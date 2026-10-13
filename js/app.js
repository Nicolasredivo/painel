import { h, fmtBRL, fmtPct, fmtQtd, fmtDataHora, fmtHora, sinal, seta, MASK } from './util.js';
import * as cofre from './vault.js';
import { consolidar, resultado, entradasNaoExplicadas, duplicatasTrezor } from './calc.js';
import { parseCSV, parseNumero, detectarColunas, converter, separarTabelas, converterTabelas, lerSaldos, conciliarSaldos, CAMPOS } from './csv.js';
import { buscarPrecos, consultarSaldo, validarBtc, validarEth } from './net.js';

const ATIVOS = ['BTC', 'ETH'];
const NOMES = { BTC: 'Bitcoin', ETH: 'Ethereum' };
const TIPOS = { compra: 'Compra', venda: 'Venda', deposito: 'Depósito', saque: 'Saque', taxa: 'Taxa de rede' };
const MIN = 60_000;
const CHAVE_PRECOS = 'painel.precos';

let estado = null;          // dados descriptografados: só existem na memória enquanto destravado
let sessao = null;
let envelopePendente = null; // backup escolhido, aguardando a senha dele
let precos = lerPrecosCache();
let precosErro = null;
let precosAtualizando = false;
let saldos = {};
let saldosErro = {};
let proxPreco = 0;
let proxSaldo = 0;
let ultimaAtividade = Date.now();
let ultimoManual = 0;
let versaoInicial = null;
let novaVersao = false;
let mostrarTodos = false;
let timer = null;

const raiz = document.getElementById('app');

// ---------- utilidades ----------
function lerPrecosCache() {
  try { return JSON.parse(localStorage.getItem(CHAVE_PRECOS)); } catch { return null; }
}

const estadoVazio = () => ({
  v: 1,
  cfg: { btc: '', eth: '', auto: true, esconder: false, lockMin: 5, ultimoBackup: null, ignorados: [] },
  lancs: [],
});

function normalizar(e) {
  const base = estadoVazio();
  return { v: 1, cfg: { ...base.cfg, ...(e?.cfg || {}) }, lancs: Array.isArray(e?.lancs) ? e.lancs : [] };
}

let fila = Promise.resolve();
function persistir() {
  fila = fila
    .then(async () => { if (sessao && estado) cofre.guardar(await cofre.selar(sessao, estado)); })
    .catch(() => aviso('Não consegui salvar neste aparelho. Faça um backup agora.'));
  return fila;
}

function aviso(texto) {
  const el = h('div', { class: 'aviso', role: 'status' }, texto);
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}

function dialogo(titulo, corpo, larga = false) {
  const d = h('dialog', { class: 'janela' + (larga ? ' larga' : '') },
    h('div', { class: 'janela-topo' },
      h('h2', {}, titulo),
      h('button', { class: 'icone', type: 'button', 'aria-label': 'Fechar', onclick: () => d.close() }, '✕')),
    h('div', { class: 'janela-corpo' }, corpo));
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.body.append(d);
  d.showModal();
  return d;
}

const campo = (rotulo, input, dica) =>
  h('label', { class: 'campo' }, h('span', {}, rotulo), input, dica ? h('small', { class: 'mut' }, dica) : null);

// ---------- telas de entrada ----------
function telaCriar() {
  const senha = h('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Frase longa, 10+ caracteres' });
  const conf = h('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Repita a senha' });
  const msg = h('p', { class: 'erro', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primario' }, 'Criar cofre');
  return h('form', {
    class: 'cartao entrada',
    onsubmit: async (e) => {
      e.preventDefault();
      if (senha.value.length < 10) { msg.textContent = 'Use pelo menos 10 caracteres. Uma frase longa é melhor que uma palavra complicada.'; return; }
      if (senha.value !== conf.value) { msg.textContent = 'As senhas não são iguais.'; return; }
      btn.disabled = true; btn.textContent = 'Criando…'; msg.textContent = '';
      const novo = estadoVazio();
      const r = await cofre.criar(senha.value, novo);
      cofre.guardar(r.envelope);
      try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
      sessao = r.sessao; estado = novo;
      iniciar();
    },
  },
  h('h1', {}, 'Painel'),
  h('p', {}, 'Crie uma senha para o cofre. Tudo que você lançar aqui fica cifrado com ela, só neste aparelho.'),
  h('p', { class: 'mut' }, 'A senha não é guardada em lugar nenhum. Se esquecer, só um backup + a mesma senha recupera os dados.'),
  campo('Senha', senha), campo('Repetir senha', conf), msg, btn,
  botaoRestaurar());
}

function botaoRestaurar() {
  const arq = h('input', {
    type: 'file', accept: '.json,application/json', class: 'oculto',
    onchange: async () => {
      const f = arq.files[0]; arq.value = '';
      if (!f) return;
      try {
        const env = JSON.parse(await f.text());
        if (!cofre.envelopeValido(env)) throw new Error();
        envelopePendente = env; render();
      } catch { aviso('Esse arquivo não parece um backup deste painel.'); }
    },
  });
  return h('div', { class: 'rodape-entrada' }, arq,
    h('button', { type: 'button', class: 'link', onclick: () => arq.click() }, 'Restaurar de um backup'));
}

function telaEntrar() {
  const senha = h('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Senha', autofocus: true });
  const msg = h('p', { class: 'erro', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primario' }, 'Entrar');
  return h('form', {
    class: 'cartao entrada',
    onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = ''; btn.disabled = true; btn.textContent = 'Abrindo…';
      try {
        const r = await cofre.abrir(senha.value, envelopePendente || cofre.ler());
        if (envelopePendente) { cofre.guardar(envelopePendente); envelopePendente = null; }
        sessao = r.sessao; estado = normalizar(r.estado);
        senha.value = '';
        iniciar();
      } catch (err) {
        msg.textContent = err.message === 'senha-errada' ? 'Senha incorreta.' : 'Não consegui abrir este cofre.';
        btn.disabled = false; btn.textContent = 'Entrar'; senha.select();
      }
    },
  },
  h('h1', {}, 'Painel'),
  envelopePendente ? h('p', { class: 'ok' }, 'Backup carregado. Digite a senha dele para entrar — isso substitui os dados deste aparelho.') : null,
  campo('Senha', senha), msg, btn,
  h('div', { class: 'rodape-entrada' },
    envelopePendente
      ? h('button', { type: 'button', class: 'link', onclick: () => { envelopePendente = null; render(); } }, 'Cancelar restauração')
      : botaoRestaurar(),
    h('button', { type: 'button', class: 'link perigo', onclick: apagarTudo }, 'Apagar tudo')));
}

function apagarTudo() {
  if (!confirm('Apagar TODOS os dados deste aparelho? Só dá para recuperar com um backup.')) return;
  if (!confirm('Última confirmação: apagar mesmo?')) return;
  cofre.apagarTudo();
  estado = null; sessao = null; envelopePendente = null;
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  render();
}

// ---------- painel ----------
function variacoes(v) {
  const chip = (rot, x) => h('span', { class: 'chip ' + sinal(x) }, rot + ' ', seta(x) + fmtPct(x));
  if (!v) return h('div', { class: 'chips' }, h('span', { class: 'chip' }, 'variação indisponível'));
  return h('div', { class: 'chips' }, chip('24h', v.h24), chip('7d', v.d7), chip('30d', v.d30));
}

const linha = (rot, val, cls) => [h('dt', {}, rot), h('dd', { class: cls || '' }, val)];

function cartaoAtivo(a, d, R, Q) {
  const { c, p, r, v } = d;
  return h('section', { class: 'cartao ativo' },
    h('div', { class: 'ativo-topo' },
      h('h2', {}, a, h('span', { class: 'mut' }, ' · ' + NOMES[a])),
      h('div', { class: 'preco' }, fmtBRL(p))),
    variacoes(v),
    c.n === 0
      ? h('p', { class: 'mut' }, 'Sem lançamentos. Importe o extrato da corretora ou adicione uma compra à mão para ver preço médio e rentabilidade.')
      : h('dl', { class: 'grade' },
        linha('Quantidade', Q(c.qtd, a)),
        linha('Preço médio', R(c.precoMedio)),
        linha('Investido', R(c.custo)),
        c.qtdSemCusto > 0
          ? linha('Valor hoje (com custo)', R(r.valor - r.valorSemCusto))
          : linha('Valor hoje', R(r.valor)),
        linha('Resultado', h('span', {}, seta(r.lucro) + R(r.lucro) + ' (' + fmtPct(r.pct) + ')'), sinal(r.lucro)),
        c.qtdSemCusto > 0 ? linha('Sem custo informado', R(r.valorSemCusto)) : null,
        c.qtdSemCusto > 0 ? linha('Total hoje', R(r.valor)) : null,
        c.realizado ? linha('Lucro de vendas', R(c.realizado), sinal(c.realizado)) : null),
    c.qtdSemCusto > 0
      ? h('p', { class: 'mut nota' }, `${Q(c.qtdSemCusto, a)} chegaram por depósito sem custo informado: contam no total, mas ficam fora do preço médio e do resultado. Informe o custo no lançamento (✎) para incluir.`)
      : null,
    c.avisos.length ? h('ul', { class: 'avisos' }, c.avisos.slice(0, 3).map((t) => h('li', {}, t))) : null);
}

function secaoTrezor(dados, R) {
  const cfg = estado.cfg;
  const itens = [];
  for (const a of ATIVOS) {
    const desc = a === 'BTC' ? cfg.btc : cfg.eth;
    if (!desc) continue;
    const s = saldos[a], e = saldosErro[a], p = dados[a].p;
    const linhas = [];
    if (s) {
      linhas.push(h('div', { class: 'trezor-linha' },
        h('strong', {}, `${NOMES[a]} na Trezor: `),
        estado.cfg.esconder ? MASK : `${fmtQtd(s.saldo)} ${a} (${fmtBRL(s.saldo * p)})`));
      if (s.pendente) linhas.push(h('div', { class: 'ok' },
        `${s.pendente > 0 ? '+' : ''}${estado.cfg.esconder ? MASK : fmtQtd(s.pendente) + ' ' + a} a caminho, aguardando confirmação na rede`));
      const novas = entradasNaoExplicadas(s.entradas || [], estado.lancs, a, estado.cfg.ignorados || []);
      if (novas.length) {
        const soma = novas.reduce((x, e) => x + e.qtd, 0);
        const quando = novas.map((e) => new Date(e.ts).toLocaleDateString('pt-BR')).join(', ');
        linhas.push(h('div', { class: 'concil' },
          h('span', {}, `Chegou ${estado.cfg.esconder ? MASK : fmtQtd(soma)} ${a} na sua Trezor (${quando}) e não veio de um saque da Bity. É seu?`),
          h('button', { type: 'button', onclick: () => abrirContarTrezor(a, novas) }, 'Ver')));
      }
      const enviado = dados[a].c.enviado;
      const taxasSaque = estado.lancs.filter((l) => l.ativo === a && l.tipo === 'saque').reduce((x, l) => x + (l.taxaQtd || 0), 0);
      const contado = estado.lancs.filter((l) => l.ativo === a && l.origem === 'trezor').reduce((x, l) => x + l.qtd, 0);
      const dif = s.saldo - (enviado - taxasSaque + contado);
      if (enviado + contado > 0 && dif < -1e-8 && !s.pendente) linhas.push(h('div', { class: 'mut' },
        `Ainda faltam ${estado.cfg.esconder ? MASK : fmtQtd(-dif)} ${a} chegar na Trezor (saque a caminho ou ainda não feito).`));
      linhas.push(h('small', { class: 'mut' }, 'conferido às ' + fmtHora(s.ts)));
    }
    if (e) linhas.push(h('div', { class: 'aviso-linha' }, `Sem resposta do servidor da Trezor agora (${e}). Tentando de novo.`));
    if (!s && !e) linhas.push(h('div', { class: 'mut' }, `${NOMES[a]}: consultando…`));
    itens.push(...linhas);
  }
  return h('section', { class: 'cartao' },
    h('h2', {}, 'Trezor'),
    !cfg.auto || itens.length === 0
      ? h('p', { class: 'mut' }, 'Para ver o saldo e a chegada do saque automaticamente, informe a xpub (Bitcoin) e/ou o endereço (Ethereum) em ⚙.')
      : itens);
}

function secaoLancs() {
  const todos = [...estado.lancs].sort((a, b) => (a.data < b.data ? 1 : -1));
  const lista = mostrarTodos ? todos : todos.slice(0, 15);
  const R = (n) => (estado.cfg.esconder ? MASK : fmtBRL(n));
  return h('section', { class: 'cartao' },
    h('div', { class: 'secao-topo' },
      h('h2', {}, 'Lançamentos'),
      h('div', { class: 'botoes' },
        h('button', { type: 'button', onclick: abrirManual }, '＋ Adicionar'),
        h('button', { type: 'button', onclick: abrirImportar }, 'Importar extrato'))),
    lista.length === 0
      ? h('p', { class: 'mut' }, 'Nada ainda. Use “Importar extrato” com o CSV da corretora.')
      : h('ul', { class: 'lancs' }, lista.map((l) => h('li', {},
        h('span', { class: 'mut' }, fmtDataHora(l.data)),
        h('span', {}, `${TIPOS[l.tipo] || l.tipo} ${l.ativo}`),
        h('span', { class: 'dir' }, estado.cfg.esconder ? MASK : fmtQtd(l.qtd)),
        h('span', { class: 'dir' }, l.tipo === 'compra' || l.tipo === 'venda' ? R(l.valor) : l.tipo === 'deposito' ? (l.semCusto ? 'sem custo' : R(l.valor)) : ''),
        l.tipo === 'deposito'
          ? h('button', { class: 'icone', type: 'button', 'aria-label': 'Informar custo do depósito', title: 'Informar custo', onclick: () => abrirCusto(l) }, '✎')
          : h('span', {}),
        h('button', {
          class: 'icone', type: 'button', 'aria-label': 'Apagar lançamento', title: 'Apagar',
          onclick: async () => {
            if (!confirm('Apagar este lançamento?')) return;
            estado.lancs = estado.lancs.filter((x) => x.id !== l.id);
            await persistir(); render();
          },
        }, '🗑')))),
    todos.length > 15
      ? h('button', { type: 'button', class: 'link', onclick: () => { mostrarTodos = !mostrarTodos; render(); } },
        mostrarTodos ? 'Mostrar só os últimos' : `Ver todos (${todos.length})`)
      : null);
}

function painel() {
  const esc = estado.cfg.esconder;
  const R = (n) => (esc ? MASK : fmtBRL(n));
  const Q = (n, a) => (esc ? MASK : fmtQtd(n) + ' ' + a);
  const dados = {};
  for (const a of ATIVOS) {
    const c = consolidar(estado.lancs, a);
    const p = precos?.[a]?.brl;
    dados[a] = { c, p, r: resultado(c, p), v: precos?.[a] };
  }
  const custo = ATIVOS.reduce((s, a) => s + dados[a].c.custo, 0);
  const temPreco = ATIVOS.every((a) => Number.isFinite(dados[a].p));
  const valor = temPreco ? ATIVOS.reduce((s, a) => s + dados[a].r.valor, 0) : NaN;
  const lucro = temPreco ? ATIVOS.reduce((x, a) => x + dados[a].r.lucro, 0) : NaN;   // só o que tem custo conhecido
  const pct = custo > 0 ? (lucro / custo) * 100 : NaN;
  const semCustoTotal = temPreco ? ATIVOS.reduce((x, a) => x + dados[a].r.valorSemCusto, 0) : 0;

  const dias = estado.cfg.ultimoBackup ? (Date.now() - new Date(estado.cfg.ultimoBackup)) / 864e5 : Infinity;
  const stale = precos && Date.now() - precos.ts > 3 * MIN;

  return h('div', { class: 'pagina' },
    h('header', { class: 'topo' },
      h('h1', {}, 'Painel'),
      h('div', { class: 'acoes' },
        h('button', { class: 'icone', type: 'button', 'aria-label': esc ? 'Mostrar valores' : 'Ocultar valores', title: esc ? 'Mostrar valores' : 'Ocultar valores',
          onclick: async () => { estado.cfg.esconder = !esc; await persistir(); render(); } }, esc ? '🙈' : '👁'),
        h('button', { class: 'icone', type: 'button', 'aria-label': 'Atualizar agora', title: 'Atualizar agora', onclick: atualizarAgora }, '↻'),
        h('button', { class: 'icone', type: 'button', 'aria-label': 'Configurações', title: 'Configurações', onclick: abrirConfig }, '⚙'),
        h('button', { class: 'icone', type: 'button', 'aria-label': 'Bloquear', title: 'Bloquear', onclick: bloquear }, '🔒'))),
    novaVersao ? h('div', { class: 'faixa' }, 'Há uma versão nova do app. ',
      h('button', { type: 'button', class: 'link', onclick: () => location.reload() }, 'Atualizar agora (pede a senha de novo)')) : null,
    estado.lancs.length > 0 && dias > 30 ? h('div', { class: 'faixa' }, 'Faça um backup cifrado: ⚙ → Backup. Se este aparelho for perdido ou limpo, os dados vão junto.') : null,
    h('section', { class: 'cartao total' },
      h('div', { class: 'mut' }, 'Total (BTC + ETH)'),
      h('div', { class: 'total-valor' }, R(valor)),
      h('div', { class: 'total-res ' + sinal(lucro) },
        custo > 0 ? `${seta(lucro)}${R(lucro)} (${fmtPct(pct)}) sobre ${R(custo)} investidos${semCustoTotal > 0 ? ` (não inclui ${R(semCustoTotal)} sem custo informado)` : ''}` : 'Lance suas compras para ver o resultado'),
      h('div', { class: 'status' },
        h('span', { class: 'ponto ' + (precosErro || stale ? 'ruim' : precos ? 'bom' : '') }),
        precos
          ? `Preços de ${fmtHora(precos.ts)}${precosErro === 'limite' ? ' — limite da fonte, tentando de novo em instantes' : precosErro ? ' — sem conexão, mostrando o último valor' : ' — atualiza sozinho'}`
          : precosErro ? 'Sem conexão para buscar os preços' : 'Buscando preços…')),
    h('div', { class: 'duas' }, ATIVOS.map((a) => cartaoAtivo(a, dados[a], R, Q))),
    secaoTrezor(dados, R),
    secaoLancs(),
    h('footer', { class: 'pe' }, `Dados cifrados só neste aparelho · v${versaoInicial || '…'}`));
}

function render() {
  raiz.replaceChildren();
  if (!estado) raiz.append(!cofre.existe() && !envelopePendente ? telaCriar() : telaEntrar());
  else raiz.append(painel());
}

// ---------- atualização automática ----------
async function atualizarPrecos() {
  if (precosAtualizando) return;
  precosAtualizando = true;
  proxPreco = Date.now() + MIN;
  try {
    precos = await buscarPrecos(AbortSignal.timeout(15000));
    precosErro = null;
    try { localStorage.setItem(CHAVE_PRECOS, JSON.stringify(precos)); } catch { /* sem cache */ }
  } catch (e) {
    precosErro = e.status === 429 ? 'limite' : 'rede';
    if (e.status === 429) proxPreco = Date.now() + 3 * MIN;
  } finally {
    precosAtualizando = false;
    if (estado) render();
  }
}

async function limparDuplicatas() {
  if (!estado) return;
  const ids = new Set(duplicatasTrezor(estado.lancs));
  if (!ids.size) return;
  estado.lancs = estado.lancs.filter((l) => !ids.has(l.id));
  await persistir();
  render();
  aviso(ids.size > 1 ? `${ids.size} entradas contadas em dobro foram unidas ao saque do extrato.` : 'Uma entrada contada em dobro foi unida ao saque do extrato.');
}

async function atualizarSaldos() {
  const cfg = estado.cfg;
  proxSaldo = Date.now() + 2 * MIN;
  const alvo = ATIVOS.filter((a) => (a === 'BTC' ? cfg.btc : cfg.eth));
  await Promise.all(alvo.map(async (a) => {
    try {
      const s = await consultarSaldo(a, a === 'BTC' ? cfg.btc : cfg.eth);
      saldos[a] = s; delete saldosErro[a];
    } catch (e) { saldosErro[a] = e.message; }
  }));
  if (estado) render();
}

function tick() {
  if (!estado) return;
  const agora = Date.now();
  if (agora - ultimaAtividade > estado.cfg.lockMin * MIN) return bloquear();
  if (document.visibilityState !== 'visible') return;
  if (agora >= proxPreco) atualizarPrecos();
  if (estado.cfg.auto && agora >= proxSaldo) atualizarSaldos();
}

function atualizarAgora() {
  if (Date.now() - ultimoManual < 10_000) return aviso('Aguarde alguns segundos entre atualizações.');
  ultimoManual = Date.now();
  proxPreco = 0; proxSaldo = 0;
  tick();
}

async function checarVersao() {
  try {
    const r = await fetch('version.json', { cache: 'no-store' });
    const { v } = await r.json();
    if (!versaoInicial) versaoInicial = v;
    else if (v !== versaoInicial) { novaVersao = true; if (!estado) location.reload(); else render(); }
  } catch { /* offline: tenta depois */ }
}

function iniciar() {
  ultimaAtividade = Date.now();
  proxPreco = 0; proxSaldo = 0;
  clearInterval(timer);
  timer = setInterval(tick, 5000);
  checarVersao();
  render();
  tick();
  limparDuplicatas();
}

function bloquear() {
  estado = null; sessao = null; saldos = {}; saldosErro = {};
  clearInterval(timer);
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  if (novaVersao) return location.reload();
  render();
}

for (const ev of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
  addEventListener(ev, () => { ultimaAtividade = Date.now(); }, { passive: true, capture: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checarVersao();
  if (!estado) return;
  if (!precos || Date.now() - precos.ts > 30_000) proxPreco = 0;
  if (!saldos.BTC && !saldos.ETH) proxSaldo = 0;
  else if (Date.now() - Math.max(saldos.BTC?.ts || 0, saldos.ETH?.ts || 0) > MIN) proxSaldo = 0;
  tick();
});
addEventListener('online', () => { if (estado) { proxPreco = 0; proxSaldo = 0; tick(); } });

// ---------- lançamento manual ----------
function abrirManual() {
  const agora = new Date(Date.now() - new Date().getTimezoneOffset() * MIN).toISOString().slice(0, 16);
  const tipo = h('select', {}, Object.entries(TIPOS).map(([k, v]) => h('option', { value: k }, v)));
  const ativo = h('select', {}, ATIVOS.map((a) => h('option', { value: a }, `${a} · ${NOMES[a]}`)));
  const data = h('input', { type: 'datetime-local', value: agora, required: true });
  const qtd = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00100000', required: true, autocomplete: 'off' });
  const valor = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
  const taxaBRL = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
  const taxaQtd = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00000000', autocomplete: 'off' });
  const msg = h('p', { class: 'erro', role: 'alert' });
  const rotValor = h('span', {}, 'Valor total pago/recebido (R$)');
  const gValor = h('label', { class: 'campo' }, rotValor, valor);
  const gTaxaBRL = campo('Taxa (R$), se houver', taxaBRL);
  const gTaxaQtd = campo('Taxa de rede (na própria moeda), se houver', taxaQtd);
  const rotQtd = h('span', {}, 'Quantidade');
  const ajustar = () => {
    const t = tipo.value;
    gValor.hidden = !(t === 'compra' || t === 'venda' || t === 'deposito');
    gTaxaBRL.hidden = !(t === 'compra' || t === 'venda');
    rotValor.textContent = t === 'deposito' ? 'Custo desse depósito (R$) — deixe vazio se não souber' : 'Valor total pago/recebido (R$)';
    gTaxaQtd.hidden = t !== 'saque';
    rotQtd.textContent = t === 'saque' ? 'Quantidade enviada' : t === 'taxa' ? 'Quantidade gasta em taxa' : 'Quantidade';
  };
  tipo.addEventListener('change', ajustar);
  ajustar();
  const d = dialogo('Novo lançamento', h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const q = parseNumero(qtd.value), t = tipo.value;
      const v = parseNumero(valor.value);
      if (!(q > 0)) { msg.textContent = 'Informe a quantidade.'; return; }
      if ((t === 'compra' || t === 'venda') && !(v >= 0)) { msg.textContent = 'Informe o valor total em R$.'; return; }
      const lanc = {
        id: 'm:' + crypto.randomUUID(), tipo: t, ativo: ativo.value,
        data: new Date(data.value).toISOString(), qtd: q,
        valor: t === 'compra' || t === 'venda' ? v : t === 'deposito' && v > 0 ? v : 0,
        taxaBRL: t === 'compra' || t === 'venda' ? parseNumero(taxaBRL.value) || 0 : 0,
        taxaQtd: t === 'saque' ? parseNumero(taxaQtd.value) || 0 : 0,
        origem: 'manual',
      };
      if (t === 'deposito') lanc.semCusto = !(v > 0);
      estado.lancs.push(lanc);
      await persistir(); render(); d.close();
    },
  },
  campo('Tipo', tipo), campo('Moeda', ativo), campo('Data e hora', data),
  h('label', { class: 'campo' }, rotQtd, qtd), gValor, gTaxaBRL, gTaxaQtd, msg,
  h('button', { type: 'submit', class: 'primario' }, 'Salvar')));
}

// ---------- importar extrato ----------
function abrirImportar() {
  let linhas = null, mapa = null, taxaModo = 'brl', convertido = null, tabelas = [], desmarcadas = new Set();
  const area = h('div', {});
  const arq = h('input', { type: 'file', accept: '.csv,.txt,.xlsx,.xls,text/csv' });

  const atualizarPrevia = () => {
    convertido = tabelas.length ? converterTabelas(tabelas, { taxaModo }) : converter(linhas.slice(1), mapa, { taxaModo });
    const porId = new Map(estado.lancs.map((l) => [l.id, l]));
    const novos = convertido.itens.filter((i) => !porId.has(i.id));
    // Conferência com o saldo que a corretora informa no topo do arquivo: a diferença costuma ser taxa de rede.
    const concil = tabelas.length ? conciliarSaldos(convertido.itens, lerSaldos(linhas)) : { taxas: [], avisos: [] };
    const muda = (t) => !porId.has(t.id) || Math.abs(porId.get(t.id).qtd - t.qtd) > 1e-9;
    const taxasEscolhidas = concil.taxas.filter((t) => muda(t) && !desmarcadas.has(t.id));
    const total = novos.length + taxasEscolhidas.length;
    const descreve = (n, t) => [n ? `${n} lançamento${n > 1 ? 's' : ''}` : '', t ? `${t} taxa${t > 1 ? 's' : ''} de rede` : ''].filter(Boolean).join(' + ');
    const ign = convertido.ignoradas;
    const cont = (f) => convertido.itens.filter(f).length;
    previa.replaceChildren(
      h('p', {}, h('strong', {}, `${convertido.itens.length} lançamentos reconhecidos`),
        ` (${cont((i) => i.tipo === 'compra')} compras, ${cont((i) => i.tipo === 'venda')} vendas, ${cont((i) => i.tipo === 'deposito')} depósitos de cripto, ${cont((i) => i.tipo === 'saque')} saques) — `,
        `${convertido.itens.length - novos.length} já existiam, ${novos.length} são novos.`),
      h('p', { class: 'mut' }, `Ignorados: ${ign.deposito} depósitos em reais ou de outras moedas, ${ign.ativo} de outras moedas, ${ign.tipo} de tipo desconhecido, ${ign.invalida} com dados incompletos.`),
      concil.taxas.length || concil.avisos.length
        ? h('div', { class: 'concil' },
          h('strong', {}, 'Conferência com o saldo da corretora'),
          concil.taxas.map((t) => h('label', { class: 'check' },
            h('input', {
              type: 'checkbox', checked: !desmarcadas.has(t.id),
              onchange: (e) => { if (e.target.checked) desmarcadas.delete(t.id); else desmarcadas.add(t.id); atualizarPrevia(); },
            }),
            ` ${fmtQtd(t.qtd)} ${t.ativo} a menos do que o extrato explica (provável taxa de rede de saque). Registrar como taxa de rede${porId.has(t.id) ? (muda(t) ? ' — atualiza o valor já registrado' : ' — já registrada') : ''}.`)),
          concil.avisos.map((a) => h('p', { class: 'mut' }, a)))
        : null,
      h('ul', { class: 'lancs' }, convertido.itens.slice(0, 5).map((l) => h('li', {},
        h('span', { class: 'mut' }, fmtDataHora(l.data)), h('span', {}, `${TIPOS[l.tipo]} ${l.ativo}`),
        h('span', { class: 'dir' }, fmtQtd(l.qtd)), h('span', { class: 'dir' }, l.tipo === 'saque' ? '' : l.semCusto ? 'sem custo' : fmtBRL(l.valor))))),
      h('button', {
        type: 'button', class: 'primario', disabled: total === 0,
        onclick: async () => {
          estado.lancs.push(...novos);
          for (const t of taxasEscolhidas) {
            const existente = porId.get(t.id);
            if (existente) Object.assign(existente, { qtd: t.qtd, data: t.data });
            else estado.lancs.push({ ...t });
          }
          await persistir(); render(); d.close();
          limparDuplicatas();
          aviso(`Importado: ${descreve(novos.length, taxasEscolhidas.length)}. Faça um backup em ⚙.`);
        },
      }, total ? `Importar ${descreve(novos.length, taxasEscolhidas.length)}` : 'Nada novo para importar'));
  };
  const previa = h('div', { class: 'previa' });

  const desenharMapa = () => {
    const cab = linhas[0];
    const selects = CAMPOS.map(({ k, rotulo }) => {
      const s = h('select', { onchange: () => { mapa[k] = Number(s.value); atualizarPrevia(); } },
        h('option', { value: -1 }, '— nenhuma —'),
        cab.map((nome, i) => h('option', { value: i, selected: mapa[k] === i }, nome || `coluna ${i + 1}`)));
      return campo(rotulo, s);
    });
    const modo = h('select', { onchange: () => { taxaModo = modo.value; atualizarPrevia(); } },
      h('option', { value: 'brl' }, 'Em R$ (soma ao custo)'),
      h('option', { value: 'moeda' }, 'Na própria moeda (já descontada / taxa de rede)'),
      h('option', { value: 'ignorar' }, 'Ignorar taxas'));
    area.replaceChildren(
      h('p', { class: 'mut' }, `${linhas.length - 1} linhas lidas. Confira se cada campo aponta para a coluna certa.`),
      h('details', {}, h('summary', {}, 'Colunas detectadas (toque para corrigir)'), selects, campo('Como a taxa aparece', modo)),
      previa);
    atualizarPrevia();
  };

  arq.addEventListener('change', async () => {
    const f = arq.files[0];
    if (!f) return;
    if (/\.xlsx?$/i.test(f.name)) { area.replaceChildren(h('p', { class: 'erro' }, 'Este é um arquivo Excel. No Excel: Arquivo → Salvar como → CSV UTF-8, e importe esse.')); return; }
    if (f.size > 5_000_000) { area.replaceChildren(h('p', { class: 'erro' }, 'Arquivo grande demais para um extrato.')); return; }
    linhas = parseCSV(await f.text());
    if (linhas.length < 2) { area.replaceChildren(h('p', { class: 'erro' }, 'Não encontrei linhas de dados nesse arquivo.')); return; }
    tabelas = separarTabelas(linhas);
    if (tabelas.length) {
      area.replaceChildren(
        h('p', { class: 'mut' }, `${linhas.length} linhas lidas. Encontrei ${tabelas.length} seção(ões) de lançamentos e li as colunas automaticamente.`),
        previa);
      atualizarPrevia();
    } else {
      mapa = detectarColunas(linhas[0]);
      desenharMapa();
    }
  });

  const d = dialogo('Importar extrato (CSV)', [
    h('p', { class: 'mut' }, 'O arquivo é lido aqui no aparelho e não é enviado a lugar nenhum. Importar o mesmo arquivo de novo não duplica.'),
    campo('Arquivo do extrato', arq), area,
  ], true);
}

// ---------- contar entradas da Trezor ----------
function abrirContarTrezor(a, novas) {
  const linhas = novas.map((e) => ({
    e,
    custo: h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'R$ no total (vazio = não sei)' }),
  }));
  const ignorar = async () => {
    estado.cfg.ignorados = [...new Set([...(estado.cfg.ignorados || []), ...novas.map((e) => e.txid)])];
    await persistir(); render(); d.close();
    aviso('Ignorado. Não aparece mais.');
  };
  const d = dialogo('Entrada na Trezor', h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      for (const { e, custo } of linhas) {
        const v = parseNumero(custo.value);
        estado.lancs.push({
          id: 't:' + e.txid, tipo: 'deposito', ativo: a, data: new Date(e.ts).toISOString(), qtd: e.qtd,
          valor: v > 0 ? v : 0, semCusto: !(v > 0), taxaBRL: 0, taxaQtd: 0, origem: 'trezor',
        });
      }
      await persistir(); render(); d.close();
      aviso('Entrada contada no total.');
    },
  },
  h('p', { class: 'mut' }, 'Chegou na sua Trezor e não veio de um saque da Bity. Se foi você que comprou ou recebeu, conte no total e informe quanto pagou (em R$, com taxas); se não souber, deixe vazio. Se você não reconhece, ignore: pode ser golpe de envio de valor mínimo.'),
  linhas.map(({ e, custo }) => campo(`${fmtDataHora(new Date(e.ts).toISOString())} · ${fmtQtd(e.qtd)} ${a}`, custo)),
  h('div', { class: 'duas-acoes' },
    h('button', { type: 'submit', class: 'primario' }, 'É meu — contar'),
    h('button', { type: 'button', class: 'perigo', onclick: ignorar }, 'Não conheço — ignorar'))));
}

// ---------- custo de um depósito ----------
function abrirCusto(l) {
  const custo = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', value: l.semCusto ? '' : String(l.valor).replace('.', ',') });
  const d = dialogo('Custo do depósito', h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const v = parseNumero(custo.value);
      l.valor = v > 0 ? v : 0;
      l.semCusto = !(v > 0);
      await persistir(); render(); d.close();
    },
  },
  h('p', { class: 'mut' }, `${fmtDataHora(l.data)} · ${fmtQtd(l.qtd)} ${l.ativo}. Quanto você pagou por isso, no total? Se não souber, deixe vazio e ele fica fora do preço médio.`),
  campo('Custo total (R$)', custo),
  h('button', { type: 'submit', class: 'primario' }, 'Salvar')));
}

// ---------- configurações ----------
function abrirConfig() {
  const cfg = estado.cfg;
  const btc = h('input', { type: 'text', value: cfg.btc, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder: 'xpub… / zpub… / endereço' });
  const eth = h('input', { type: 'text', value: cfg.eth, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder: '0x…' });
  const auto = h('input', { type: 'checkbox', checked: cfg.auto });
  const lock = h('select', {}, [1, 2, 5, 15, 30].map((m) => h('option', { value: m, selected: cfg.lockMin === m }, `${m} min sem uso`)));
  const msg = h('p', { class: 'erro', role: 'alert' });
  const nova = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Nova senha (10+ caracteres)' });
  const nova2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repita a nova senha' });
  const msgSenha = h('p', { class: 'erro', role: 'alert' });

  const d = dialogo('Configurações', [
    h('form', {
      class: 'bloco',
      onsubmit: async (e) => {
        e.preventDefault();
        const err = validarBtc(btc.value) || validarEth(eth.value);
        if (err) { msg.textContent = err; return; }
        cfg.btc = btc.value.trim(); cfg.eth = eth.value.trim(); cfg.auto = auto.checked; cfg.lockMin = Number(lock.value);
        saldos = {}; saldosErro = {}; proxSaldo = 0;
        await persistir(); render(); d.close(); tick();
      },
    },
    h('h3', {}, 'Trezor (somente leitura)'),
    h('p', { class: 'mut' }, 'Use só a chave PÚBLICA: no Trezor Suite, conta Bitcoin → Detalhes da conta → xpub. Isso permite ver saldo e histórico, nunca gastar. Elas vão ao servidor da própria Trezor (o mesmo que o Suite usa) a cada consulta.'),
    campo('Bitcoin — xpub/zpub ou endereço', btc), campo('Ethereum — endereço público', eth),
    h('label', { class: 'check' }, auto, ' Consultar a Trezor automaticamente'),
    campo('Bloquear sozinho após', lock), msg,
    h('button', { type: 'submit', class: 'primario' }, 'Salvar')),

    h('div', { class: 'bloco' },
      h('h3', {}, 'Backup'),
      h('p', { class: 'mut' }, cfg.ultimoBackup ? 'Último backup: ' + fmtDataHora(cfg.ultimoBackup) : 'Nenhum backup feito ainda.'),
      h('p', { class: 'mut' }, 'O arquivo é cifrado com a sua senha. Guarde fora do aparelho (nuvem, e-mail para você mesmo). Para passar os dados do celular ao PC, restaure o backup na tela de entrada.'),
      h('button', { type: 'button', onclick: exportarBackup }, 'Exportar backup cifrado')),

    h('form', {
      class: 'bloco',
      onsubmit: async (e) => {
        e.preventDefault();
        if (nova.value.length < 10) { msgSenha.textContent = 'Use pelo menos 10 caracteres.'; return; }
        if (nova.value !== nova2.value) { msgSenha.textContent = 'As senhas não são iguais.'; return; }
        const r = await cofre.trocarSenha(nova.value, estado);
        cofre.guardar(r.envelope); sessao = r.sessao;
        nova.value = ''; nova2.value = ''; msgSenha.textContent = '';
        aviso('Senha trocada. Backups antigos continuam com a senha antiga.');
      },
    },
    h('h3', {}, 'Trocar senha'), nova, nova2, msgSenha,
    h('button', { type: 'submit' }, 'Trocar senha')),

    h('div', { class: 'bloco' },
      h('h3', {}, 'Sobre'),
      h('p', { class: 'mut' }, `Versão ${versaoInicial || '—'}. O app se atualiza sozinho ao abrir com internet. Fontes de dados: CoinGecko (preços) e servidores da Trezor (saldo). Nenhum outro destino é permitido.`),
      h('button', { type: 'button', class: 'perigo', onclick: apagarTudo }, 'Apagar tudo neste aparelho')),
  ], true);
}

async function exportarBackup() {
  // A data do backup entra no próprio arquivo, para o aviso não voltar depois de restaurar.
  const anterior = estado.cfg.ultimoBackup;
  estado.cfg.ultimoBackup = new Date().toISOString();
  const env = await cofre.selar(sessao, estado);
  const nome = `painel-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const arquivo = new File([JSON.stringify(env)], nome, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [arquivo] })) await navigator.share({ files: [arquivo] });
    else baixar(arquivo);
  } catch (e) {
    if (e.name === 'AbortError') { estado.cfg.ultimoBackup = anterior; return; }
    baixar(arquivo);
  }
  await persistir(); render();
  aviso('Backup gerado.');
}

function baixar(f) {
  const u = URL.createObjectURL(f);
  const a = h('a', { href: u, download: f.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10_000);
}

// ---------- partida ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sem offline */ });
checarVersao();
render();
