// Preço médio e rentabilidade. Custo médio ponderado (o mesmo método do IR no Brasil).

const EPS = 1e-10;

export function consolidar(lancs, ativo) {
  const L = lancs
    .filter((l) => l.ativo === ativo)
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));

  let qtd = 0;          // quanto você tem hoje (corretora + Trezor)
  let custo = 0;        // quanto, em R$, está "dentro" dessa quantidade
  let realizado = 0;    // lucro de vendas já feitas
  let enviado = 0;      // total mandado da corretora para a Trezor
  let taxasRede = 0;    // criptomoeda gasta em taxas de saque/rede
  const avisos = [];

  for (const l of L) {
    const taxaBRL = l.taxaBRL || 0;
    const taxaQtd = l.taxaQtd || 0;
    switch (l.tipo) {
      case 'compra':
        qtd += l.qtd;
        custo += l.valor + taxaBRL;
        break;
      case 'venda': {
        if (l.qtd > qtd + EPS) avisos.push('Venda maior que a quantidade comprada antes dela (' + l.data.slice(0, 10) + ').');
        const q = Math.min(l.qtd, qtd);
        const medio = qtd > EPS ? custo / qtd : 0;
        custo -= medio * q;
        qtd -= q;
        realizado += l.valor - taxaBRL - medio * q;
        break;
      }
      case 'saque':
        enviado += l.qtd;
        qtd -= taxaQtd;
        taxasRede += taxaQtd;
        break;
      case 'taxa':
        qtd -= l.qtd;
        taxasRede += l.qtd;
        break;
      default:
        break;
    }
    if (Math.abs(qtd) < EPS) qtd = 0;
    if (qtd < 0) { avisos.push('Quantidade ficou negativa em ' + l.data.slice(0, 10) + ': falta alguma compra no histórico.'); qtd = 0; }
    if (qtd === 0) custo = 0;
  }

  return {
    qtd, custo, realizado, enviado, taxasRede, avisos,
    precoMedio: qtd > EPS ? custo / qtd : 0,
    n: L.length,
  };
}

// Valor de hoje x o que foi pago.
export function resultado(c, precoAtual) {
  if (!Number.isFinite(precoAtual)) return { valor: NaN, lucro: NaN, pct: NaN };
  const valor = c.qtd * precoAtual;
  const lucro = valor - c.custo;
  return { valor, lucro, pct: c.custo > 0 ? (lucro / c.custo) * 100 : NaN };
}
