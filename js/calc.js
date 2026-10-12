// Preço médio e rentabilidade. Custo médio ponderado (o mesmo método do IR no Brasil).
//
// A quantidade tem dois grupos:
//   A) com custo conhecido (compras e depósitos com custo informado) — entra no preço médio e no resultado;
//   B) sem custo conhecido (depósitos que vieram de outro lugar) — conta como seu, mas fica fora do preço médio.

const EPS = 1e-10;

export function consolidar(lancs, ativo) {
  const L = lancs
    .filter((l) => l.ativo === ativo)
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));

  let qtdA = 0;         // com custo conhecido
  let qtdB = 0;         // sem custo conhecido
  let custo = 0;        // R$ dentro de qtdA
  let realizado = 0;    // lucro de vendas já feitas (só sobre o grupo A)
  let enviado = 0;      // total mandado da corretora em saques
  let taxasRede = 0;    // criptomoeda gasta em taxas de saque/rede
  const avisos = [];

  // Tira q do saldo, proporcional entre os dois grupos. Devolve quanto saiu do grupo A.
  const baixar = (q) => {
    const total = qtdA + qtdB;
    if (total <= EPS || q <= 0) return 0;
    const tirado = Math.min(q, total);
    const doA = tirado * (qtdA / total);
    qtdA -= doA;
    qtdB -= tirado - doA;
    return doA;
  };

  for (const l of L) {
    const taxaBRL = l.taxaBRL || 0;
    const taxaQtd = l.taxaQtd || 0;
    switch (l.tipo) {
      case 'compra':
        qtdA += l.qtd;
        custo += l.valor + taxaBRL;
        break;
      case 'deposito':
        if (l.semCusto) qtdB += l.qtd;
        else { qtdA += l.qtd; custo += l.valor; }
        break;
      case 'venda': {
        if (l.qtd > qtdA + qtdB + EPS) avisos.push('Venda maior que a quantidade que você tinha antes dela (' + l.data.slice(0, 10) + ').');
        const medio = qtdA > EPS ? custo / qtdA : 0;
        const doA = baixar(l.qtd);
        custo -= medio * doA;
        realizado += (l.valor - taxaBRL) * (doA / l.qtd) - medio * doA;
        break;
      }
      case 'saque':
        enviado += l.qtd;
        baixar(taxaQtd);          // a taxa some da quantidade, mas o custo fica (sobe o preço médio)
        taxasRede += taxaQtd;
        break;
      case 'taxa':
        baixar(l.qtd);
        taxasRede += l.qtd;
        break;
      default:
        break;
    }
    if (qtdA < EPS) { qtdA = 0; custo = 0; }
    if (qtdB < EPS) qtdB = 0;
  }

  return {
    qtd: qtdA + qtdB,
    qtdComCusto: qtdA,
    qtdSemCusto: qtdB,
    custo, realizado, enviado, taxasRede, avisos,
    precoMedio: qtdA > EPS ? custo / qtdA : 0,
    n: L.length,
  };
}

// Valor de hoje x o que foi pago. O resultado considera só o grupo com custo conhecido.
export function resultado(c, precoAtual) {
  if (!Number.isFinite(precoAtual)) return { valor: NaN, valorSemCusto: NaN, lucro: NaN, pct: NaN };
  const lucro = c.qtdComCusto * precoAtual - c.custo;
  return {
    valor: c.qtd * precoAtual,
    valorSemCusto: c.qtdSemCusto * precoAtual,
    lucro,
    pct: c.custo > 0 ? (lucro / c.custo) * 100 : NaN,
  };
}
