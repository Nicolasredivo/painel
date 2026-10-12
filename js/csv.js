// Leitura de extrato CSV de corretora. O formato exato da BitPreço ainda não foi visto:
// por isso as colunas são detectadas pelo nome e podem ser corrigidas na tela de importação.

export const CAMPOS = [
  { k: 'data', rotulo: 'Data e hora' },
  { k: 'tipo', rotulo: 'Tipo (compra, venda, saque…)' },
  { k: 'ativo', rotulo: 'Moeda / par (BTC, ETH…)' },
  { k: 'qtd', rotulo: 'Quantidade (cripto)' },
  { k: 'preco', rotulo: 'Preço unitário (R$)' },
  { k: 'total', rotulo: 'Valor total (R$)' },
  { k: 'taxa', rotulo: 'Taxa' },
  { k: 'id', rotulo: 'Código da operação (evita duplicar)' },
];

const norm = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- CSV ----------
export function parseCSV(texto) {
  texto = String(texto).replace(/^﻿/, '');
  // Separador = o mais frequente nas primeiras linhas (empate: ponto e vírgula, comum em extratos brasileiros).
  const amostra = texto.split(/\r?\n/, 40);
  const conta = (d) => amostra.reduce((s, l) => s + l.split(d).length - 1, 0);
  const delim = [';', '\t', ','].map((d) => [d, conta(d)]).sort((a, b) => b[1] - a[1])[0][0];
  const linhas = [];
  let linha = [], cel = '', aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') { if (texto[i + 1] === '"') { cel += '"'; i++; } else aspas = false; }
      else cel += c;
    } else if (c === '"') aspas = true;
    else if (c === delim) { linha.push(cel); cel = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(cel); cel = '';
      if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
      linha = [];
    } else cel += c;
  }
  linha.push(cel);
  if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
  return linhas.map((l) => l.map((x) => x.trim()));
}

// ---------- números e datas ----------
export function parseNumero(s) {
  if (s == null) return NaN;
  let t = String(s).trim();
  if (!t) return NaN;
  if (/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(t)) return parseFloat(t);
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t);
  t = t.replace(/[R$\s ]/gi, '').replace(/[A-Za-z]+/g, '').replace(/[()+-]/g, '');
  if (!t) return NaN;
  const p = t.lastIndexOf('.'), v = t.lastIndexOf(',');
  if (p > -1 && v > -1) t = v > p ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (v > -1) t = (t.match(/,/g) || []).length > 1 ? t.replace(/,/g, '') : t.replace(',', '.');
  else if (p > -1 && (t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

export function parseData(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  let d;
  if (/^\d{10}$/.test(t)) d = new Date(Number(t) * 1000);
  else if (/^\d{13}$/.test(t)) d = new Date(Number(t));
  else {
    const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      d = new Date(ano, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    } else d = new Date(t.replace(' ', 'T'));
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- detecção de colunas ----------
const EXATOS = {
  data: ['data', 'date', 'datahora', 'datetime', 'dataehora', 'horario', 'time', 'createdat', 'criadoem', 'executadoem'],
  tipo: ['tipo', 'type', 'side', 'lado', 'operacao', 'operation', 'transacao', 'acao', 'tipodeoperacao'],
  ativo: ['ativo', 'moeda', 'asset', 'coin', 'currency', 'criptomoeda', 'symbol', 'simbolo', 'par', 'pair', 'mercado', 'market'],
  qtd: ['quantidade', 'qtd', 'amount', 'quantity', 'qty', 'volume', 'quantidadecripto'],
  preco: ['preco', 'price', 'cotacao', 'precounitario', 'valorunitario', 'unitprice'],
  total: ['total', 'valortotal', 'valor', 'value', 'totalbrl', 'valorbrl', 'brl'],
  taxa: ['taxa', 'fee', 'tarifa', 'comissao', 'fees', 'taxas'],
  id: ['id', 'idoperacao', 'orderid', 'ordemid', 'txid', 'codigo', 'referencia', 'hash'],
};
const PARCIAIS = {
  data: ['data', 'date', 'hora', 'time'],
  tipo: ['tipo', 'type', 'side', 'lado', 'operac'],
  ativo: ['ativo', 'moeda', 'asset', 'coin', 'currency', 'par', 'pair', 'symbol', 'mercado'],
  qtd: ['quantidade', 'qtd', 'amount', 'quantity', 'qty'],
  preco: ['preco', 'price', 'cotacao'],
  total: ['total', 'valor', 'value'],
  taxa: ['taxa', 'fee', 'tarifa', 'comissao'],
  id: ['id', 'codigo', 'hash', 'ref'],
};

export function detectarColunas(cabecalho) {
  const nomes = cabecalho.map(norm);
  const mapa = Object.fromEntries(CAMPOS.map((c) => [c.k, -1]));
  const usada = new Set();
  const pegar = (k, testa) => {
    if (mapa[k] !== -1) return;
    const i = nomes.findIndex((n, idx) => !usada.has(idx) && n && testa(n));
    if (i > -1) { mapa[k] = i; usada.add(i); }
  };
  for (const { k } of CAMPOS) pegar(k, (n) => EXATOS[k].includes(n));
  for (const { k } of CAMPOS) pegar(k, (n) => PARCIAIS[k].some((p) => n.includes(p)));
  return mapa;
}

// ---------- classificação ----------
export function classificarTipo(s) {
  const n = norm(s);
  if (!n) return null;
  if (/compra|buy|bid|aquisic|purchase/.test(n)) return 'compra';
  if (/venda|sell|ask|sale/.test(n)) return 'venda';
  if (/saque|withdraw|retirada|envio|enviar|send|saida/.test(n)) return 'saque';
  if (/deposit|receb|entrada|cashback|bonus/.test(n)) return 'deposito';
  return null;
}

export function classificarAtivo(s) {
  const t = String(s ?? '').toUpperCase().split(/[^A-Z]+/).find(Boolean) || '';
  const par = (pre, resto) => t.startsWith(pre) && (t.length === pre.length || /^(BRL|USDT?|USD|BTC|ETH)$/.test(t.slice(pre.length)) && resto);
  if (t === 'BITCOIN' || t === 'XBT' || par('BTC', true)) return 'BTC';
  if (t === 'ETHEREUM' || t === 'ETHER' || par('ETH', true)) return 'ETH';
  return null;
}

// Hash simples e estável (FNV-1a) só para reconhecer linha repetida entre importações.
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// taxaModo: 'brl' (soma ao custo) | 'moeda' (já descontada da cripto) | 'ignorar'
export function converter(linhas, mapa, { taxaModo = 'brl' } = {}) {
  const itens = [];
  const ign = { tipo: 0, ativo: 0, invalida: 0, deposito: 0 };
  const repetidas = new Map();
  for (const row of linhas) {
    const cel = (k) => (mapa[k] >= 0 ? row[mapa[k]] : '');
    const tipo = classificarTipo(cel('tipo'));
    if (!tipo) { ign.tipo++; continue; }
    const ativo = classificarAtivo(cel('ativo'));
    // Depósito em reais ou de outra moeda não entra; depósito de BTC/ETH entra (custo desconhecido).
    if (!ativo) { ign[tipo === 'deposito' ? 'deposito' : 'ativo']++; continue; }
    const data = parseData(cel('data'));
    let qtd = Math.abs(parseNumero(cel('qtd')));
    const preco = Math.abs(parseNumero(cel('preco')));
    let total = Math.abs(parseNumero(cel('total')));
    const taxa = taxaModo === 'ignorar' ? 0 : Math.abs(parseNumero(cel('taxa'))) || 0;
    if (!Number.isFinite(qtd) && Number.isFinite(total) && preco > 0) qtd = total / preco;
    if (!Number.isFinite(total) && Number.isFinite(qtd) && Number.isFinite(preco)) total = qtd * preco;
    const semValor = tipo === 'saque' || tipo === 'deposito';
    if (!data || !(qtd > 0) || (!semValor && !(total >= 0))) { ign.invalida++; continue; }

    const item = {
      tipo, ativo, data, qtd,
      valor: tipo === 'saque' ? 0 : Number.isFinite(total) ? total : 0,
      taxaBRL: 0, taxaQtd: 0, origem: 'csv',
    };
    if (tipo === 'deposito') item.semCusto = !(total > 0);
    if (taxaModo === 'brl' && tipo !== 'saque') item.taxaBRL = taxa;
    if (taxaModo === 'moeda') {
      if (tipo === 'saque') item.taxaQtd = taxa;
      else if (tipo === 'compra') item.qtd = Math.max(0, qtd - taxa);
    }

    const bruto = row.join('\u001f');
    const ocorrencia = (repetidas.get(bruto) || 0) + 1;
    repetidas.set(bruto, ocorrencia);
    const idCel = cel('id');
    item.id = idCel ? 'i:' + idCel + ':' + tipo : 'h:' + fnv(bruto) + ':' + ocorrencia;
    itens.push(item);
  }
  return { itens, ignoradas: ign };
}

// ---------- extratos com várias seções (ex.: Bitypreço) ----------
// Cada tabela começa numa linha cuja 1ª célula é "Data" e vai até a primeira linha que não começa com data.
const COMECA_COM_DATA = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/;

export function separarTabelas(linhas) {
  const tabelas = [];
  let atual = null;
  for (const l of linhas) {
    if (['data', 'date', 'datahora', 'datetime'].includes(norm(l[0])) && l.length > 2) {
      // Alguns cabeçalhos trazem duas colunas coladas por vírgula (ex.: "Preco R$,TxID").
      const cab = l.flatMap((c) => (/txid/i.test(c) && c.includes(',') ? c.split(',') : [c])).map((c) => c.trim());
      atual = { cabecalho: cab, linhas: [] };
      tabelas.push(atual);
      continue;
    }
    if (!atual) continue;
    if (!COMECA_COM_DATA.test(l[0] || '')) { atual = null; continue; }
    atual.linhas.push(l);
  }
  return tabelas.filter((t) => t.linhas.length > 0);
}

export function converterTabelas(tabelas, opcoes) {
  const itens = [];
  const ignoradas = { tipo: 0, ativo: 0, invalida: 0, deposito: 0 };
  for (const t of tabelas) {
    const r = converter(t.linhas, detectarColunas(t.cabecalho), opcoes);
    itens.push(...r.itens);
    for (const k of Object.keys(ignoradas)) ignoradas[k] += r.ignoradas[k];
  }
  return { itens, ignoradas };
}
