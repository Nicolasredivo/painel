// Formatação e montagem de elementos. Nada aqui toca em dados nem na rede.

export const MASK = '•••••';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtBRL = (n) => (Number.isFinite(n) ? brl.format(n) : '—');

export function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  const sinal = n > 0 ? '+' : '';
  return sinal + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
}

export function fmtQtd(n, casas = 8) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas });
}

export function fmtDataHora(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export const fmtHora = (ts) =>
  new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const sinal = (n) => (!Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
export const seta = (n) => (!Number.isFinite(n) || n === 0 ? '' : n > 0 ? '▲ ' : '▼ ');

// Cria elemento sem innerHTML: o texto sempre entra como texto, nunca como HTML.
export function h(tag, props, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const por = (f) => {
    if (f == null || f === false) return;
    if (Array.isArray(f)) f.forEach(por);
    else el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  };
  filhos.forEach(por);
  return el;
}
