// Única parte que fala com a internet. Dois destinos, e só esses (travado também pelo CSP no index.html):
//   - CoinGecko: preço público em R$. O pedido não leva nenhum dado seu.
//   - Servidores Blockbook da Trezor: saldo público de uma xpub/endereço (somente leitura).

const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl&ids=bitcoin,ethereum&price_change_percentage=24h,7d,30d';
const ID = { bitcoin: 'BTC', ethereum: 'ETH' };

export async function buscarPrecos(signal) {
  const r = await fetch(COINGECKO, { signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw Object.assign(new Error('http ' + r.status), { status: r.status });
  const out = { ts: Date.now() };
  for (const c of await r.json()) {
    const a = ID[c.id];
    if (a) out[a] = {
      brl: c.current_price,
      h24: c.price_change_percentage_24h_in_currency,
      d7: c.price_change_percentage_7d_in_currency,
      d30: c.price_change_percentage_30d_in_currency,
    };
  }
  return out;
}

// ---------- saldo na Trezor (Blockbook por WebSocket, o mesmo caminho do Trezor Suite) ----------
const SERVIDORES = {
  BTC: ['btc1', 'btc2'].map((h) => `wss://${h}.trezor.io/websocket`),
  ETH: ['eth1', 'eth2'].map((h) => `wss://${h}.trezor.io/websocket`),
};
const DIVISOR = { BTC: 1e8, ETH: 1e18 };

function umaConsulta(url, descriptor, ativo, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws;
    const fim = (fn, v) => { clearTimeout(t); try { ws.close(); } catch { /* já fechado */ } fn(v); };
    const t = setTimeout(() => fim(reject, new Error('tempo esgotado')), timeoutMs);
    try { ws = new WebSocket(url); } catch (e) { clearTimeout(t); return reject(e); }
    ws.onopen = () => ws.send(JSON.stringify({ id: '1', method: 'getAccountInfo', params: { descriptor, details: 'txs', pageSize: 40, page: 1 } }));
    ws.onerror = () => fim(reject, new Error('sem conexão'));
    ws.onmessage = (m) => {
      let d;
      try { d = JSON.parse(m.data).data; } catch { return fim(reject, new Error('resposta inválida')); }
      if (!d || d.error) return fim(reject, new Error(d?.error?.message || 'resposta vazia'));
      const k = DIVISOR[ativo];
      fim(resolve, {
        saldo: Number(BigInt(d.balance || '0')) / k,
        pendente: Number(BigInt(d.unconfirmedBalance || '0')) / k,
        pendentesQtd: d.unconfirmedTxs || 0,
        txs: d.txs || 0,
        entradas: extrairEntradas(d.transactions || [], ativo, descriptor),
        ts: Date.now(),
      });
    };
  });
}

// Do histórico devolvido pelo servidor, separa só o que CHEGOU na carteira: transação já confirmada, que não
// gastou nada da própria carteira (envio e troco ficam de fora) e que não falhou. Soma o que caiu em endereços seus.
export function extrairEntradas(transacoes, ativo, descriptor) {
  const k = DIVISOR[ativo];
  const alvo = String(descriptor).toLowerCase();
  const meu = (o) => o.isOwn || (o.addresses || []).some((a) => String(a).toLowerCase() === alvo);
  const entradas = [];
  for (const t of transacoes) {
    if (!t.blockTime || !(t.confirmations > 0)) continue;
    if (ativo === 'ETH' && t.ethereumSpecific && t.ethereumSpecific.status !== 1) continue;
    if ((t.vin || []).some(meu)) continue;
    const recebido = (t.vout || []).filter(meu).reduce((s, o) => s + BigInt(o.value || '0'), 0n);
    if (recebido > 0n) entradas.push({ txid: t.txid, ts: t.blockTime * 1000, qtd: Number(recebido) / k });
  }
  return entradas;
}

export async function consultarSaldo(ativo, descriptor, timeoutMs = 15000) {
  let ultimoErro;
  for (const url of SERVIDORES[ativo]) {
    try { return await umaConsulta(url, descriptor, ativo, timeoutMs); } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro || new Error('sem conexão');
}

// ---------- validação do que o usuário cola ----------
// Devolve texto de erro, ou null se estiver ok. Nunca aceita frase de recuperação nem chave privada.
const PERIGO =
  'Isso parece uma frase de recuperação ou chave privada. NUNCA cole isso em lugar nenhum — só a chave PÚBLICA (xpub/zpub ou endereço).';

export function validarBtc(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (/\s/.test(t) || /^[xyzt]prv/i.test(t) || /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(t) || /^[0-9a-f]{64}$/i.test(t)) return PERIGO;
  if (/^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,115}$/.test(t)) return null;
  if (/^(bc1[0-9a-z]{25,90}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(t)) return null;
  return 'Formato não reconhecido. Use a xpub/zpub da conta (Trezor Suite → Detalhes da conta) ou um endereço Bitcoin.';
}

export function validarEth(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (/\s/.test(t) || /^(0x)?[0-9a-f]{64}$/i.test(t)) return PERIGO;
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
  return 'Formato não reconhecido. Use o endereço Ethereum público (0x… com 42 caracteres).';
}
