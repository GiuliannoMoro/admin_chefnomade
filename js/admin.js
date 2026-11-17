"use strict";

/* =====================================================================
   Chef Nômade — painel de administração (SPA)
   RF005 login · RF006 cardápio · RF007 pedidos · RF008 status

   Rotas:
     #/login
     #/pedidos[/status]   lista de pedidos, com filtro opcional
     #/comandas           comandas abertas; fechar na hora do pagamento
     #/cardapio           gerenciar itens
   ===================================================================== */

const API = "/api/admin";
const CHAVE_SESSAO = "chefnomade:admin-sessao";
const CHAVE_SOM = "chefnomade:admin-som";
const INTERVALO_PEDIDOS = 5000;

const STATUS = [
  { valor: "recebido", rotulo: "Recebido" },
  { valor: "em_preparo", rotulo: "Em preparo" },
  { valor: "pronto", rotulo: "Pronto" },
  { valor: "entregue", rotulo: "Entregue" },
];
const ROTULO_STATUS = Object.fromEntries(STATUS.map((s) => [s.valor, s.rotulo]));
ROTULO_STATUS.cancelado = "Cancelado";

const PROXIMO_PASSO = {
  recebido: { status: "em_preparo", acao: "Iniciar preparo" },
  em_preparo: { status: "pronto", acao: "Marcar pronto" },
  pronto: { status: "entregue", acao: "Marcar entregue" },
};

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);

const app = $("#app");
const topo = $("#cabecalho-painel"); // topo + barra de abas
const modalFundo = $("#modal");
const modal = $(".modal", modalFundo);
const toastEl = $("#toast");
const badgeNovos = $("#badge-novos");

const estado = {
  sessao: lerSessao(),
  avisoLogin: null,
  secao: null,
  // pedidos
  filtro: "",
  pedidos: [],
  carregouPedidos: false,
  assinatura: "",
  ultimoIdVisto: null,
  novos: new Set(),
  historicos: new Map(),
  abertos: new Set(),
  timerPedidos: null,
  cicloPedidos: 0,
  timerExpira: null,
  atualizadoEm: null,
  som: lerPreferenciaSom(),
  audio: null,
  // comandas
  comandas: [],
  // cardápio
  categorias: [],
  produtos: [],
  busca: "",
  filtroCategoria: "",
  imagemForm: null,
  focoAntesModal: null,
};

/* ---------------------------------------------------------------------
   Utilitários
   --------------------------------------------------------------------- */
const formatoBRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dinheiro = (valor) => formatoBRL.format(Number(valor));
const formatoHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const formatoDataHora = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});

function esc(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const normalizar = (texto) =>
  String(texto ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function quandoFoi(iso) {
  const data = new Date(iso);
  const minutos = Math.floor((Date.now() - data) / 60000);
  const hoje = new Date().toDateString() === data.toDateString();
  const hora = hoje ? formatoHora.format(data) : formatoDataHora.format(data);
  if (minutos < 1) return `${hora} · agora`;
  if (minutos < 60) return `${hora} · há ${minutos} min`;
  if (minutos < 24 * 60) return `${hora} · há ${Math.floor(minutos / 60)} h`;
  return hora;
}

let timerToast;
function toast(mensagem, tipo = "") {
  toastEl.textContent = mensagem;
  toastEl.className = `toast ${tipo}`;
  toastEl.hidden = false;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

/* ---------------------------------------------------------------------
   RF005 — Sessão
   --------------------------------------------------------------------- */
function lerSessao() {
  try {
    const sessao = JSON.parse(localStorage.getItem(CHAVE_SESSAO));
    if (sessao?.access_token && sessao.expires_at * 1000 > Date.now() + 5000) return sessao;
  } catch { /* sessão corrompida */ }
  try { localStorage.removeItem(CHAVE_SESSAO); } catch { /* ignora */ }
  return null;
}

function salvarSessao(sessao) {
  estado.sessao = sessao;
  try { localStorage.setItem(CHAVE_SESSAO, JSON.stringify(sessao)); } catch { /* ignora */ }
  agendarExpiracao();
}

function agendarExpiracao() {
  clearTimeout(estado.timerExpira);
  if (!estado.sessao) return;
  const restante = estado.sessao.expires_at * 1000 - Date.now();
  estado.timerExpira = setTimeout(
    () => encerrarSessao("Sua sessão expirou. Entre novamente."),
    Math.min(Math.max(restante, 0), 2 ** 31 - 1),
  );
}

function encerrarSessao(aviso = null) {
  clearTimeout(estado.timerExpira);
  clearTimeout(estado.timerPedidos);
  estado.timerPedidos = null;
  estado.cicloPedidos++; // descarta qualquer busca em andamento
  try { localStorage.removeItem(CHAVE_SESSAO); } catch { /* ignora */ }
  Object.assign(estado, {
    sessao: null,
    avisoLogin: aviso,
    secao: null,
    pedidos: [],
    carregouPedidos: false,
    assinatura: "",
    ultimoIdVisto: null,
    novos: new Set(),
    historicos: new Map(),
    abertos: new Set(),
  });
  atualizarAvisoNovos();
  fecharModal();
  if (location.hash === "#/login") rotear();
  else location.hash = "#/login";
}

class ErroSessao extends Error {}

async function api(caminho, opcoes = {}) {
  const headers = { "Content-Type": "application/json" };
  if (estado.sessao) headers.Authorization = `Bearer ${estado.sessao.access_token}`;

  let resposta;
  try {
    resposta = await fetch(API + caminho, { ...opcoes, headers });
  } catch {
    throw new Error("Sem conexão com o servidor.");
  }

  if ((resposta.status === 401 || resposta.status === 403) && caminho !== "/login") {
    let mensagem = "Sua sessão expirou. Entre novamente.";
    try { mensagem = (await resposta.json()).erro ?? mensagem; } catch { /* sem corpo */ }
    encerrarSessao(mensagem);
    throw new ErroSessao(mensagem);
  }

  if (resposta.status === 204) return null;
  let dados = null;
  try { dados = await resposta.json(); } catch { /* sem corpo */ }
  if (!resposta.ok) throw new Error(dados?.erro || "Erro de comunicação com o servidor.");
  return dados;
}

/* ---------------------------------------------------------------------
   Roteamento (rotas protegidas → login)
   --------------------------------------------------------------------- */
function rotear() {
  const [secao = "", parametro = ""] = location.hash.replace(/^#\/?/, "").split("/");

  if (!estado.sessao) {
    if (secao !== "login") {
      location.replace("#/login");
      return;
    }
    mostrarLogin();
    return;
  }

  if (secao === "login" || secao === "") {
    location.replace("#/pedidos");
    return;
  }

  topo.hidden = false;
  $("#nome-admin").textContent = estado.sessao.admin?.nome ?? "";
  for (const aba of topo.querySelectorAll("[data-secao]")) {
    if (aba.dataset.secao === secao) aba.setAttribute("aria-current", "page");
    else aba.removeAttribute("aria-current");
  }
  fecharModal();

  if (secao === "pedidos") {
    mostrarPedidos(STATUS.some((s) => s.valor === parametro) ? parametro : "");
  } else if (secao === "cardapio" || secao === "comandas") {
    if (secao === "cardapio") mostrarCardapio();
    else mostrarComandas();
    // O aviso de pedidos novos continua funcionando fora da aba Pedidos
    if (!estado.timerPedidos) atualizarPedidos();
  } else {
    location.replace("#/pedidos");
  }
}

/* ---------------------------------------------------------------------
   RF005 — Tela de login
   --------------------------------------------------------------------- */
function mostrarLogin() {
  topo.hidden = true;
  estado.secao = "login";
  const aviso = estado.avisoLogin;
  estado.avisoLogin = null;

  app.innerHTML = `
    <section class="login">
      <form id="form-login" novalidate>
        <div class="marca">
          <span class="marca-chef">CHEF</span>
          <span class="marca-nome">NÔMADE <span class="selo-painel">PAINEL</span></span>
        </div>
        <p class="sub">Acesso restrito à equipe</p>
        ${aviso ? `<p class="mensagem-erro">${esc(aviso)}</p>` : ""}
        <div class="campo">
          <label for="email">E-mail</label>
          <input id="email" name="email" type="email" autocomplete="username" required>
        </div>
        <div class="campo">
          <label for="senha">Senha</label>
          <input id="senha" name="senha" type="password" autocomplete="current-password" required>
        </div>
        <p class="mensagem-erro" id="erro-login" hidden></p>
        <button class="btn btn-largo" type="submit">Entrar</button>
      </form>
    </section>`;

  $("#email").focus();
}

async function entrar(form) {
  const erro = $("#erro-login");
  const botao = $('button[type="submit"]', form);
  const email = form.email.value.trim();
  const senha = form.senha.value;
  erro.hidden = true;

  if (!email || !senha) {
    erro.textContent = "Informe e-mail e senha.";
    erro.hidden = false;
    (email ? form.senha : form.email).focus();
    return;
  }

  botao.disabled = true;
  botao.textContent = "Entrando…";
  desbloquearAudio();

  try {
    const sessao = await api("/login", {
      method: "POST",
      body: JSON.stringify({ email, senha }),
    });
    salvarSessao(sessao);
    location.hash = "#/pedidos";
  } catch (falha) {
    erro.textContent = falha.message;
    erro.hidden = false;
    botao.disabled = false;
    botao.textContent = "Entrar";
    form.senha.select();
  }
}

$("#btn-sair").addEventListener("click", () => {
  encerrarSessao();
});

/* ---------------------------------------------------------------------
   RF007 — Pedidos
   --------------------------------------------------------------------- */
function mostrarPedidos(filtro) {
  const trocouDeTela = estado.secao !== "pedidos";
  const trocouFiltro = estado.filtro !== filtro;
  estado.secao = "pedidos";
  estado.filtro = filtro;

  if (!trocouDeTela && !trocouFiltro && $("#lista-pedidos")) return;

  {
    app.innerHTML = `
      <div class="cabecalho">
        <h1>Pedidos</h1>
        <div class="acoes">
          <span class="atualizado" id="atualizado"></span>
          <button type="button" class="som" id="btn-som" aria-pressed="${estado.som}">
            ${estado.som ? "Som ligado" : "Som desligado"}
          </button>
        </div>
      </div>
      <nav class="filtros" aria-label="Filtrar por status">
        <a href="#/pedidos" ${filtro === "" ? 'aria-current="page"' : ""}>Todos</a>
        ${STATUS.map((s) => `
          <a href="#/pedidos/${s.valor}" ${filtro === s.valor ? 'aria-current="page"' : ""}>${s.rotulo}</a>`).join("")}
      </nav>
      <div id="lista-pedidos"><p class="estado">Carregando pedidos…</p></div>`;

    estado.assinatura = "";
    estado.carregouPedidos = false;
    atualizarPedidos();
  }
}

// Cada chamada abre um "ciclo"; respostas de ciclos antigos são descartadas,
// então nunca existem dois agendamentos de atualização rodando ao mesmo tempo.
async function atualizarPedidos() {
  clearTimeout(estado.timerPedidos);
  estado.timerPedidos = null;
  if (!estado.sessao) return;

  const ciclo = ++estado.cicloPedidos;
  const filtroAtual = estado.secao === "pedidos" ? estado.filtro : "";
  try {
    const dados = await api(`/pedidos${filtroAtual ? `?status=${filtroAtual}` : ""}`);
    if (ciclo !== estado.cicloPedidos) return;
    detectarNovos(dados.ultimo_id);

    if (estado.secao === "pedidos" && estado.filtro === filtroAtual) {
      estado.pedidos = dados.pedidos;
      estado.carregouPedidos = true;
      estado.atualizadoEm = new Date();
      renderizarListaPedidos();
    }
  } catch (erro) {
    if (ciclo !== estado.cicloPedidos || erro instanceof ErroSessao) return;
    if (estado.secao === "pedidos" && !estado.carregouPedidos) {
      const lista = $("#lista-pedidos");
      if (lista) lista.innerHTML = `<p class="estado erro">${esc(erro.message)}</p>`;
    }
  }

  if (estado.sessao) estado.timerPedidos = setTimeout(atualizarPedidos, INTERVALO_PEDIDOS);
}

function detectarNovos(ultimoId) {
  if (estado.ultimoIdVisto === null) {
    estado.ultimoIdVisto = ultimoId; // primeira carga: só marca a referência
    return;
  }
  if (ultimoId <= estado.ultimoIdVisto) return;

  for (let id = estado.ultimoIdVisto + 1; id <= ultimoId; id++) estado.novos.add(id);
  const quantidade = ultimoId - estado.ultimoIdVisto;
  estado.ultimoIdVisto = ultimoId;

  tocarAlerta();
  toast(quantidade === 1 ? `Novo pedido #${ultimoId}!` : `${quantidade} pedidos novos!`, "alerta");
  atualizarAvisoNovos();
}

function atualizarAvisoNovos() {
  const n = estado.novos.size;
  badgeNovos.textContent = n;
  badgeNovos.hidden = n === 0;
  document.title = n ? `(${n}) Pedidos · Chef Nômade` : "Painel · Chef Nômade";
}

function marcarComoVisto(id) {
  if (estado.novos.delete(id)) atualizarAvisoNovos();
}

function itensPedidoHtml(pedido) {
  return pedido.itens.map((item) => {
    const detalhes = [
      ...item.opcoes.map((o) => `<li>${esc(o.nome_opcao)}</li>`),
      item.observacao ? `<li class="obs">${esc(item.observacao)}</li>` : "",
    ].join("");
    return `
      <li>
        <div class="linha">
          <span><span class="qtd">${item.quantidade}×</span>${esc(item.nome_produto)}</span>
          <span>${dinheiro(item.subtotal)}</span>
        </div>
        ${detalhes ? `<ul>${detalhes}</ul>` : ""}
      </li>`;
  }).join("");
}

function historicoHtml(id) {
  const historico = estado.historicos.get(id);
  if (historico === undefined) return `<p class="atualizado">Carregando…</p>`;
  if (historico === null) return `<p class="atualizado">Não foi possível carregar.</p>`;
  if (!historico.length) return `<p class="atualizado">Sem registros.</p>`;

  return `<ol>${historico.map((h) => `
    <li>
      ${formatoDataHora.format(new Date(h.alterado_em))} —
      ${h.status_anterior
        ? `${esc(ROTULO_STATUS[h.status_anterior] ?? h.status_anterior)} → <strong>${esc(ROTULO_STATUS[h.status_novo] ?? h.status_novo)}</strong>`
        : `<strong>${esc(ROTULO_STATUS[h.status_novo] ?? h.status_novo)}</strong>`}
      ${h.alterado_por ? `por ${esc(h.alterado_por)}` : "(pedido do cliente)"}
    </li>`).join("")}</ol>`;
}

function pedidoHtml(p) {
  const novo = estado.novos.has(p.id);
  const proximo = PROXIMO_PASSO[p.status];
  const opcoesStatus = STATUS.map((s) =>
    `<option value="${s.valor}" ${s.valor === p.status ? "selected" : ""}>${s.rotulo}</option>`).join("");

  return `
    <article class="pedido ${novo ? "novo" : ""}" data-status="${esc(p.status)}" data-id="${p.id}">
      <div class="pedido-topo">
        <div>
          <div class="pedido-numero">#${p.id}${novo ? `<span class="selo-novo">NOVO</span>` : ""}</div>
          <div class="pedido-hora">${quandoFoi(p.created_at)}</div>
        </div>
        <span class="status">${esc(ROTULO_STATUS[p.status] ?? p.status)}</span>
      </div>
      <div class="cliente">${esc(p.nome_cliente)} <small>· ${p.mesa ? `Mesa ${p.mesa}` : "Balcão"}</small></div>
      <ul class="pedido-itens">${itensPedidoHtml(p)}</ul>
      ${p.observacoes ? `<p class="obs-pedido"><strong>Obs. do pedido:</strong> ${esc(p.observacoes)}</p>` : ""}
      <div class="pedido-total"><span>Total</span><span>${dinheiro(p.total)}</span></div>
      <div class="pedido-acoes">
        ${proximo ? `<button type="button" class="btn" data-acao="avancar" data-id="${p.id}"
                             data-status="${proximo.status}">${proximo.acao}</button>` : ""}
        <select data-acao="status" data-id="${p.id}" aria-label="Alterar status do pedido ${p.id}">
          ${STATUS.some((s) => s.valor === p.status) ? "" : `<option selected disabled>${esc(ROTULO_STATUS[p.status] ?? p.status)}</option>`}
          ${opcoesStatus}
        </select>
      </div>
      <details class="historico" data-id="${p.id}" ${estado.abertos.has(p.id) ? "open" : ""}>
        <summary>Histórico de status</summary>
        <div class="historico-conteudo">${historicoHtml(p.id)}</div>
      </details>
    </article>`;
}

function renderizarListaPedidos(forcar = false) {
  const lista = $("#lista-pedidos");
  if (!lista) return;

  const atualizado = $("#atualizado");
  if (atualizado && estado.atualizadoEm) {
    atualizado.textContent = `Atualizado às ${formatoHora.format(estado.atualizadoEm)}`;
  }

  // Só redesenha quando algo mudou (preserva foco e scroll)
  const assinatura = JSON.stringify([
    estado.pedidos.map((p) => [p.id, p.status]),
    [...estado.novos],
    Math.floor(Date.now() / 60000),
  ]);
  if (!forcar && assinatura === estado.assinatura) return;
  estado.assinatura = assinatura;

  if (!estado.pedidos.length) {
    lista.innerHTML = `<p class="estado">${estado.filtro
      ? `Nenhum pedido com status "${esc(ROTULO_STATUS[estado.filtro])}".`
      : "Nenhum pedido ainda."}</p>`;
    return;
  }

  const foco = document.activeElement;
  const chaveFoco = foco?.dataset?.acao && foco.dataset.id ? `[data-acao="${foco.dataset.acao}"][data-id="${foco.dataset.id}"]` : null;

  lista.innerHTML = `<div class="pedidos">${estado.pedidos.map(pedidoHtml).join("")}</div>`;

  if (chaveFoco) $(chaveFoco, lista)?.focus({ preventScroll: true });
}

async function mudarStatus(id, status) {
  const cartao = $(`.pedido[data-id="${id}"]`);
  cartao?.querySelectorAll("button, select").forEach((el) => { el.disabled = true; });
  marcarComoVisto(id);

  try {
    await api(`/pedidos/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    estado.historicos.delete(id);
    toast(`Pedido #${id}: ${ROTULO_STATUS[status]}`);
  } catch (erro) {
    if (erro instanceof ErroSessao) return;
    toast(erro.message);
  }

  if (estado.abertos.has(id)) carregarHistorico(id);
  await atualizarPedidos();
  renderizarListaPedidos(true);
}

async function carregarHistorico(id) {
  try {
    estado.historicos.set(id, await api(`/pedidos/${id}/historico`));
  } catch (erro) {
    if (erro instanceof ErroSessao) return;
    estado.historicos.set(id, null);
  }
  const alvo = $(`.historico[data-id="${id}"] .historico-conteudo`);
  if (alvo) alvo.innerHTML = historicoHtml(id);
}

/* Som de notificação (Web Audio — sem arquivo externo) */
function lerPreferenciaSom() {
  try { return localStorage.getItem(CHAVE_SOM) !== "off"; } catch { return true; }
}

function desbloquearAudio() {
  try {
    estado.audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (estado.audio.state === "suspended") estado.audio.resume();
  } catch { /* navegador sem Web Audio */ }
}

function tocarAlerta() {
  if (!estado.som) return;
  desbloquearAudio();
  const ctx = estado.audio;
  if (!ctx) return;
  [[0, 880], [0.18, 1175], [0.36, 1568]].forEach(([inicio, frequencia]) => {
    const osc = ctx.createOscillator();
    const volume = ctx.createGain();
    const t = ctx.currentTime + inicio;
    osc.type = "sine";
    osc.frequency.value = frequencia;
    volume.gain.setValueAtTime(0.0001, t);
    volume.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    osc.connect(volume).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  });
}

// O navegador só libera áudio depois de um clique/tecla do usuário
document.addEventListener("pointerdown", desbloquearAudio, { once: true });
document.addEventListener("keydown", desbloquearAudio, { once: true });

/* ---------------------------------------------------------------------
   Comandas — cada cliente acumula pedidos; fecha quando paga
   --------------------------------------------------------------------- */
async function mostrarComandas() {
  estado.secao = "comandas";
  app.innerHTML = `
    <div class="cabecalho">
      <h1>Comandas abertas</h1>
      <div class="acoes">
        <button type="button" class="btn btn-secundario" data-acao="atualizar-comandas">Atualizar</button>
      </div>
    </div>
    <div id="lista-comandas"><p class="estado">Carregando comandas…</p></div>`;

  await carregarComandas();
}

async function carregarComandas() {
  try {
    estado.comandas = await api("/comandas");
  } catch (erro) {
    if (erro instanceof ErroSessao) return;
    const lista = $("#lista-comandas");
    if (lista) lista.innerHTML = `<p class="estado erro">${esc(erro.message)}</p>`;
    return;
  }
  renderizarComandas();
}

function comandaHtml(c) {
  const pedidos = c.pedidos.map((p) => `
    <li class="${p.status === "cancelado" ? "cancelado" : ""}">
      <span>#${p.id} · ${esc(ROTULO_STATUS[p.status] ?? p.status)}</span>
      <span>${dinheiro(p.total)}</span>
    </li>`).join("");

  return `
    <article class="pedido comanda">
      <div class="pedido-topo">
        <div>
          <div class="cliente">${esc(c.nome_cliente)} <small>· ${c.mesa ? `Mesa ${c.mesa}` : "Balcão"}</small></div>
          <div class="pedido-hora">Aberta ${quandoFoi(c.created_at)}</div>
        </div>
        <span class="status">${c.pedidos.length} ${c.pedidos.length === 1 ? "pedido" : "pedidos"}</span>
      </div>
      ${pedidos ? `<ul class="comanda-pedidos">${pedidos}</ul>` : ""}
      <div class="pedido-total"><span>Total</span><span>${dinheiro(c.total)}</span></div>
      <div class="pedido-acoes">
        <button type="button" class="btn" data-acao="fechar-comanda" data-comanda="${esc(c.id)}">Fechar comanda (pago)</button>
      </div>
    </article>`;
}

function renderizarComandas() {
  const lista = $("#lista-comandas");
  if (!lista) return;
  lista.innerHTML = estado.comandas.length
    ? `<div class="pedidos">${estado.comandas.map(comandaHtml).join("")}</div>`
    : `<p class="estado">Nenhuma comanda aberta.</p>`;
}

function confirmarFechamento(comanda) {
  const pendentes = comanda.pedidos.filter((p) => !["entregue", "cancelado"].includes(p.status)).length;
  abrirModal(`
    <div class="conteudo">
      <h2 id="modal-titulo">Fechar comanda</h2>
      <p>Confirmar o pagamento de <strong>${dinheiro(comanda.total)}</strong> de
        <strong>${esc(comanda.nome_cliente)}</strong>${comanda.mesa ? ` (mesa ${comanda.mesa})` : ""}?</p>
      ${pendentes ? `<p class="mensagem-erro">Atenção: ${pendentes === 1 ? "1 pedido ainda não foi entregue" : `${pendentes} pedidos ainda não foram entregues`}.</p>` : ""}
      <p class="atualizado">Depois de fechada, a comanda some do site do cliente e o próximo pedido abre uma nova.</p>
      <p class="mensagem-erro" id="erro-form" hidden></p>
      <div class="rodape">
        <button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>
        <button type="button" class="btn" data-acao="confirmar-fechamento" data-comanda="${esc(comanda.id)}">Fechar comanda</button>
      </div>
    </div>`);
  $("[data-fechar]", modal).focus();
}

async function fecharComanda(id, botao) {
  botao.disabled = true;
  botao.textContent = "Fechando…";
  const comanda = estado.comandas.find((c) => c.id === id);
  try {
    await api(`/comandas/${id}/fechar`, { method: "PATCH" });
    fecharModal();
    toast(`Comanda de ${comanda?.nome_cliente ?? "cliente"} fechada`);
    await carregarComandas();
  } catch (erro) {
    if (erro instanceof ErroSessao) return;
    const msg = $("#erro-form");
    msg.textContent = erro.message;
    msg.hidden = false;
    botao.disabled = false;
    botao.textContent = "Fechar comanda";
  }
}

/* ---------------------------------------------------------------------
   RF006 — Cardápio
   --------------------------------------------------------------------- */
async function mostrarCardapio() {
  estado.secao = "cardapio";
  app.innerHTML = `
    <div class="cabecalho">
      <h1>Cardápio</h1>
      <div class="acoes">
        <button type="button" class="btn" data-acao="novo-produto">+ Novo item</button>
      </div>
    </div>
    <div class="barra-busca">
      <input type="search" id="busca" placeholder="Buscar item…" aria-label="Buscar item"
             value="${esc(estado.busca)}">
      <select id="filtro-categoria" aria-label="Filtrar por categoria">
        <option value="">Todas as categorias</option>
      </select>
    </div>
    <div id="lista-produtos"><p class="estado">Carregando itens…</p></div>`;

  await carregarProdutos();
}

async function carregarProdutos() {
  try {
    const [categorias, produtos] = await Promise.all([api("/categorias"), api("/produtos")]);
    estado.categorias = categorias;
    estado.produtos = produtos;
  } catch (erro) {
    if (erro instanceof ErroSessao) return;
    const lista = $("#lista-produtos");
    if (lista) lista.innerHTML = `<p class="estado erro">${esc(erro.message)}</p>`;
    return;
  }

  const filtro = $("#filtro-categoria");
  if (filtro) {
    filtro.innerHTML = `<option value="">Todas as categorias</option>` +
      estado.categorias.map((c) =>
        `<option value="${c.id}" ${String(c.id) === estado.filtroCategoria ? "selected" : ""}>${esc(c.nome)}</option>`).join("");
  }
  renderizarProdutos();
}

function renderizarProdutos() {
  const lista = $("#lista-produtos");
  if (!lista) return;

  const termo = normalizar(estado.busca.trim());
  const visiveis = estado.produtos.filter((p) =>
    (!estado.filtroCategoria || String(p.categoria_id) === estado.filtroCategoria) &&
    (!termo || normalizar(p.nome).includes(termo)));

  if (!visiveis.length) {
    lista.innerHTML = `<p class="estado">Nenhum item encontrado.</p>`;
    return;
  }

  const linhas = estado.categorias
    .map((c) => {
      const itens = visiveis.filter((p) => p.categoria_id === c.id);
      if (!itens.length) return "";
      return `
        <tr class="grupo-categoria"><td colspan="5">${esc(c.nome)}</td></tr>
        ${itens.map((p) => `
          <tr>
            <td class="foto">
              ${p.imagem_url
                ? `<img class="miniatura" src="${esc(p.imagem_url)}" alt="" loading="lazy">`
                : `<div class="miniatura miniatura-vazia" aria-hidden="true">${esc(p.nome.charAt(0))}</div>`}
            </td>
            <td class="nome">
              <strong>${esc(p.nome)}</strong>
              ${p.descricao ? `<div>${esc(p.descricao)}</div>` : ""}
            </td>
            <td class="preco">${p.preco === null ? `<span class="sem">Sem preço</span>` : dinheiro(p.preco)}</td>
            <td>
              ${p.vegetariano ? `<span class="etiqueta veg">Veg</span>` : ""}
              ${p.disponivel ? "" : `<span class="etiqueta off">Oculto</span>`}
            </td>
            <td class="acoes">
              <button type="button" class="btn btn-secundario btn-pequeno" data-acao="editar" data-id="${p.id}">Editar</button>
              <button type="button" class="btn btn-perigo btn-pequeno" data-acao="excluir" data-id="${p.id}">Excluir</button>
            </td>
          </tr>`).join("")}`;
    })
    .join("");

  lista.innerHTML = `
    <div class="tabela-wrap">
      <table>
        <thead><tr><th></th><th>Item</th><th>Preço</th><th>Situação</th><th class="acoes">Ações</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;
}

/* Formulário de produto (cadastrar / editar) */
function abrirFormProduto(produto = null) {
  const p = produto ?? { disponivel: true, vegetariano: false };
  estado.imagemForm = { url: p.imagem_url ?? null, arquivo: null, previa: p.imagem_url ?? null };
  const precoTexto = p.preco === null || p.preco === undefined ? "" : Number(p.preco).toFixed(2).replace(".", ",");

  abrirModal(`
    <form id="form-produto" novalidate data-id="${produto?.id ?? ""}">
      <h2 id="modal-titulo">${produto ? "Editar item" : "Novo item"}</h2>
      <div class="grade-campos">
        <div class="campo inteiro" data-campo="nome">
          <label for="f-nome">Nome *</label>
          <input id="f-nome" name="nome" maxlength="80" value="${esc(p.nome ?? "")}">
          <span class="erro-campo" hidden></span>
        </div>
        <div class="campo" data-campo="categoria_id">
          <label for="f-categoria">Categoria *</label>
          <select id="f-categoria" name="categoria_id">
            <option value="">Selecione…</option>
            ${estado.categorias.map((c) =>
              `<option value="${c.id}" ${c.id === p.categoria_id ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}
          </select>
          <span class="erro-campo" hidden></span>
        </div>
        <div class="campo" data-campo="preco">
          <label for="f-preco">Preço (R$) *</label>
          <input id="f-preco" name="preco" inputmode="decimal" placeholder="0,00" value="${precoTexto}">
          <span class="erro-campo" hidden></span>
        </div>
        <div class="campo inteiro">
          <label for="f-descricao">Descrição</label>
          <textarea id="f-descricao" name="descricao" maxlength="400" rows="3">${esc(p.descricao ?? "")}</textarea>
        </div>
        <div class="campo inteiro">
          <label for="f-ingredientes">Ingredientes</label>
          <input id="f-ingredientes" name="ingredientes" value="${esc((p.ingredientes ?? []).join(", "))}">
          <span class="dica">Separe por vírgula. Aparecem no detalhe do item.</span>
        </div>
        <div class="campo inteiro" data-campo="imagem">
          <span class="campo-rotulo"><strong>Imagem</strong></span>
          <div class="imagem-campo">
            <div id="previa-imagem"></div>
            <div class="botoes">
              <button type="button" class="btn btn-secundario btn-pequeno" data-acao="escolher-imagem">Escolher imagem</button>
              <button type="button" class="btn btn-secundario btn-pequeno" data-acao="remover-imagem">Remover imagem</button>
            </div>
            <input type="file" id="f-imagem" accept="image/jpeg,image/png,image/webp" hidden>
          </div>
          <span class="dica">JPG, PNG ou WEBP, até 5 MB.</span>
          <span class="erro-campo" hidden></span>
        </div>
        <div class="inteiro" style="display:flex;gap:22px;flex-wrap:wrap">
          <label class="check"><input type="checkbox" name="vegetariano" ${p.vegetariano ? "checked" : ""}> Vegetariano</label>
          <label class="check"><input type="checkbox" name="disponivel" ${p.disponivel ? "checked" : ""}> Visível no cardápio</label>
        </div>
      </div>
      <p class="mensagem-erro" id="erro-form" hidden></p>
      <div class="rodape">
        <button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>
        <button type="submit" class="btn">${produto ? "Salvar alterações" : "Cadastrar item"}</button>
      </div>
    </form>`);

  atualizarPreviaImagem();
  $("#f-nome").focus();
}

function atualizarPreviaImagem() {
  const alvo = $("#previa-imagem");
  if (!alvo) return;
  const { previa } = estado.imagemForm;
  alvo.innerHTML = previa
    ? `<img class="imagem-previa" src="${esc(previa)}" alt="Prévia da imagem">`
    : `<div class="imagem-previa miniatura-vazia">SEM FOTO</div>`;
  $('[data-acao="remover-imagem"]').hidden = !previa;
}

function mostrarErroCampo(form, campo, mensagem) {
  const bloco = $(`[data-campo="${campo}"]`, form);
  if (!bloco) return;
  bloco.classList.toggle("invalido", Boolean(mensagem));
  const span = $(".erro-campo", bloco);
  span.textContent = mensagem ?? "";
  span.hidden = !mensagem;
}

function validarFormProduto(form) {
  const erros = {};
  const nome = form.nome.value.trim();
  const precoTexto = form.preco.value.trim().replace(/\s|R\$/g, "").replace(",", ".");
  const preco = Number(precoTexto);

  if (!nome) erros.nome = "Informe o nome do item.";
  if (!form.categoria_id.value) erros.categoria_id = "Escolha a categoria.";
  if (!precoTexto) erros.preco = "Informe o preço.";
  else if (!Number.isFinite(preco) || preco < 0) erros.preco = "Preço inválido. Use, por exemplo, 28,90.";

  for (const campo of ["nome", "categoria_id", "preco"]) mostrarErroCampo(form, campo, erros[campo]);
  return { valido: Object.keys(erros).length === 0, primeiro: Object.keys(erros)[0], preco };
}

async function prepararImagem(arquivo) {
  // Reduz para no máximo 1200px e converte em JPEG: upload mais leve
  try {
    const bitmap = await createImageBitmap(arquivo);
    const escala = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * escala);
    canvas.height = Math.round(bitmap.height * escala);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    if (blob) return { tipo: "image/jpeg", base64: await paraBase64(blob) };
  } catch { /* usa o arquivo original */ }
  return { tipo: arquivo.type, base64: await paraBase64(arquivo) };
}

function paraBase64(blob) {
  return new Promise((ok, falha) => {
    const leitor = new FileReader();
    leitor.onload = () => ok(String(leitor.result).split(",")[1]);
    leitor.onerror = () => falha(new Error("Não foi possível ler a imagem."));
    leitor.readAsDataURL(blob);
  });
}

async function salvarProduto(form) {
  const erroGeral = $("#erro-form");
  erroGeral.hidden = true;

  const { valido, primeiro, preco } = validarFormProduto(form);
  if (!valido) {
    form.elements[primeiro]?.focus();
    return;
  }

  const botao = $('button[type="submit"]', form);
  const textoBotao = botao.textContent;
  botao.disabled = true;

  try {
    let imagem_url = estado.imagemForm.url;
    if (estado.imagemForm.arquivo) {
      botao.textContent = "Enviando imagem…";
      const imagem = await prepararImagem(estado.imagemForm.arquivo);
      ({ url: imagem_url } = await api("/imagens", { method: "POST", body: JSON.stringify(imagem) }));
    }

    botao.textContent = "Salvando…";
    const id = form.dataset.id;
    const corpo = {
      nome: form.nome.value.trim(),
      categoria_id: Number(form.categoria_id.value),
      preco,
      descricao: form.descricao.value.trim() || null,
      ingredientes: form.ingredientes.value,
      imagem_url,
      vegetariano: form.vegetariano.checked,
      disponivel: form.disponivel.checked,
    };

    await api(id ? `/produtos/${id}` : "/produtos", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(corpo),
    });

    fecharModal();
    toast(id ? `"${corpo.nome}" atualizado` : `"${corpo.nome}" cadastrado`);
    await carregarProdutos(); // RF006: lista atualizada após cada operação
  } catch (erro) {
    if (erro instanceof ErroSessao) return;
    erroGeral.textContent = erro.message;
    erroGeral.hidden = false;
    botao.disabled = false;
    botao.textContent = textoBotao;
  }
}

function confirmarExclusao(produto) {
  abrirModal(`
    <div class="conteudo">
      <h2 id="modal-titulo">Excluir item</h2>
      <p>Excluir <strong>${esc(produto.nome)}</strong> do cardápio permanentemente? Isso não pode ser desfeito.</p>
      <p class="atualizado">Pedidos antigos continuam mostrando o nome do item.
        Se quiser só esconder temporariamente, edite e desmarque "Visível no cardápio".</p>
      <p class="mensagem-erro" id="erro-form" hidden></p>
      <div class="rodape">
        <button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>
        <button type="button" class="btn btn-perigo" data-acao="confirmar-exclusao" data-id="${produto.id}">Excluir</button>
      </div>
    </div>`);
  $("[data-fechar]", modal).focus();
}

async function excluirProduto(id, botao) {
  botao.disabled = true;
  botao.textContent = "Excluindo…";
  const produto = estado.produtos.find((p) => p.id === id);
  try {
    await api(`/produtos/${id}`, { method: "DELETE" });
    fecharModal();
    toast(`"${produto?.nome ?? "Item"}" excluído`);
    await carregarProdutos();
  } catch (erro) {
    if (erro instanceof ErroSessao) return;
    const msg = $("#erro-form");
    msg.textContent = erro.message;
    msg.hidden = false;
    botao.disabled = false;
    botao.textContent = "Excluir";
  }
}

/* ---------------------------------------------------------------------
   Modal
   --------------------------------------------------------------------- */
function abrirModal(html) {
  if (modalFundo.hidden) estado.focoAntesModal = document.activeElement;
  modal.innerHTML = html;
  modalFundo.hidden = false;
  document.body.style.overflow = "hidden";
}

function fecharModal() {
  if (modalFundo.hidden) return;
  modalFundo.hidden = true;
  modal.innerHTML = "";
  document.body.style.overflow = "";
  if (estado.focoAntesModal?.isConnected) estado.focoAntesModal.focus();
}

modalFundo.addEventListener("mousedown", (e) => {
  if (e.target === modalFundo) fecharModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalFundo.hidden) fecharModal();
});

/* ---------------------------------------------------------------------
   Eventos (delegação)
   --------------------------------------------------------------------- */
document.addEventListener("submit", (e) => {
  if (e.target.id === "form-login") {
    e.preventDefault();
    entrar(e.target);
  } else if (e.target.id === "form-produto") {
    e.preventDefault();
    salvarProduto(e.target);
  }
});

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-fechar]")) {
    fecharModal();
    return;
  }

  const alvo = e.target.closest("[data-acao]");
  if (!alvo) {
    const cartao = e.target.closest(".pedido");
    if (cartao) marcarComoVisto(Number(cartao.dataset.id));
    return;
  }

  const id = Number(alvo.dataset.id);
  switch (alvo.dataset.acao) {
    case "avancar":
      mudarStatus(id, alvo.dataset.status);
      break;
    case "novo-produto":
      abrirFormProduto();
      break;
    case "editar":
      abrirFormProduto(estado.produtos.find((p) => p.id === id));
      break;
    case "excluir":
      confirmarExclusao(estado.produtos.find((p) => p.id === id));
      break;
    case "confirmar-exclusao":
      excluirProduto(id, alvo);
      break;
    case "atualizar-comandas":
      carregarComandas();
      break;
    case "fechar-comanda": {
      const comanda = estado.comandas.find((c) => c.id === alvo.dataset.comanda);
      if (comanda) confirmarFechamento(comanda);
      break;
    }
    case "confirmar-fechamento":
      fecharComanda(alvo.dataset.comanda, alvo);
      break;
    case "escolher-imagem":
      $("#f-imagem").click();
      break;
    case "remover-imagem":
      estado.imagemForm = { url: null, arquivo: null, previa: null };
      $("#f-imagem").value = "";
      atualizarPreviaImagem();
      break;
  }
});

document.addEventListener("click", (e) => {
  const botaoSom = e.target.closest("#btn-som");
  if (!botaoSom) return;
  estado.som = !estado.som;
  try { localStorage.setItem(CHAVE_SOM, estado.som ? "on" : "off"); } catch { /* ignora */ }
  botaoSom.setAttribute("aria-pressed", String(estado.som));
  botaoSom.textContent = estado.som ? "Som ligado" : "Som desligado";
  if (estado.som) tocarAlerta(); // teste rápido do som
});

document.addEventListener("change", (e) => {
  const el = e.target;

  if (el.matches('select[data-acao="status"]')) {
    mudarStatus(Number(el.dataset.id), el.value);
  } else if (el.id === "filtro-categoria") {
    estado.filtroCategoria = el.value;
    renderizarProdutos();
  } else if (el.id === "f-imagem") {
    const arquivo = el.files?.[0];
    const form = el.form;
    mostrarErroCampo(form, "imagem", null);
    if (!arquivo) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(arquivo.type)) {
      mostrarErroCampo(form, "imagem", "Use uma imagem JPG, PNG ou WEBP.");
      el.value = "";
      return;
    }
    if (arquivo.size > 5 * 1024 * 1024) {
      mostrarErroCampo(form, "imagem", "A imagem deve ter no máximo 5 MB.");
      el.value = "";
      return;
    }
    if (estado.imagemForm.previa?.startsWith("blob:")) URL.revokeObjectURL(estado.imagemForm.previa);
    estado.imagemForm = { ...estado.imagemForm, arquivo, previa: URL.createObjectURL(arquivo) };
    atualizarPreviaImagem();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "busca") {
    estado.busca = e.target.value;
    renderizarProdutos();
  } else if (e.target.closest?.("#form-produto")) {
    const bloco = e.target.closest("[data-campo]");
    if (bloco?.classList.contains("invalido")) mostrarErroCampo(e.target.form, bloco.dataset.campo, null);
  }
});

// <details> não propaga "toggle": escuta na fase de captura
document.addEventListener("toggle", (e) => {
  const detalhes = e.target;
  if (!detalhes.matches?.(".historico")) return;
  const id = Number(detalhes.dataset.id);
  if (detalhes.open) {
    estado.abertos.add(id);
    if (!estado.historicos.has(id)) carregarHistorico(id);
  } else {
    estado.abertos.delete(id);
  }
}, true);

/* ---------------------------------------------------------------------
   Início
   --------------------------------------------------------------------- */
window.addEventListener("hashchange", rotear);
agendarExpiracao();
rotear();
