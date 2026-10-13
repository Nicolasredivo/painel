// Dados 100% inventados. Rodar: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidar, resultado, entradasNaoExplicadas, duplicatasTrezor } from '../js/calc.js';
import { parseCSV, parseNumero, parseData, detectarColunas, converter, classificarAtivo, classificarTipo, separarTabelas, converterTabelas, lerSaldos, conciliarSaldos } from '../js/csv.js';
import { validarBtc, validarEth, extrairEntradas } from '../js/net.js';
import * as cofre from '../js/vault.js';

const L = (o) => ({ taxaBRL: 0, taxaQtd: 0, valor: 0, ...o });

test('preço médio ponderado de duas compras', () => {
  const c = consolidar([
    L({ tipo: 'compra', ativo: 'BTC', data: '2025-01-01T00:00:00Z', qtd: 0.1, valor: 30000 }),
    L({ tipo: 'compra', ativo: 'BTC', data: '2025-02-01T00:00:00Z', qtd: 0.1, valor: 50000 }),
  ], 'BTC');
  assert.equal(c.qtd, 0.2);
  assert.equal(c.custo, 80000);
  assert.equal(c.precoMedio, 400000);
});

test('taxa em R$ entra no custo; taxa de rede reduz quantidade e sobe o preço médio', () => {
  const c = consolidar([
    L({ tipo: 'compra', ativo: 'ETH', data: '2025-01-01T00:00:00Z', qtd: 1, valor: 10000, taxaBRL: 50 }),
    L({ tipo: 'saque', ativo: 'ETH', data: '2025-01-02T00:00:00Z', qtd: 0.99, taxaQtd: 0.01 }),
  ], 'ETH');
  assert.equal(c.custo, 10050);
  assert.ok(Math.abs(c.qtd - 0.99) < 1e-12);
  assert.ok(c.precoMedio > 10050 / 1);
  assert.equal(c.enviado, 0.99);
});

test('venda baixa o custo proporcional e registra lucro realizado', () => {
  const c = consolidar([
    L({ tipo: 'compra', ativo: 'BTC', data: '2025-01-01T00:00:00Z', qtd: 1, valor: 100 }),
    L({ tipo: 'venda', ativo: 'BTC', data: '2025-01-02T00:00:00Z', qtd: 0.5, valor: 80 }),
  ], 'BTC');
  assert.equal(c.qtd, 0.5);
  assert.equal(c.custo, 50);
  assert.equal(c.realizado, 30);
  assert.equal(c.precoMedio, 100);
});

test('venda maior que o saldo gera aviso e não deixa negativo', () => {
  const c = consolidar([
    L({ tipo: 'compra', ativo: 'BTC', data: '2025-01-01T00:00:00Z', qtd: 1, valor: 100 }),
    L({ tipo: 'venda', ativo: 'BTC', data: '2025-01-02T00:00:00Z', qtd: 2, valor: 300 }),
  ], 'BTC');
  assert.equal(c.qtd, 0);
  assert.ok(c.avisos.length > 0);
});

test('rentabilidade', () => {
  const c = consolidar([L({ tipo: 'compra', ativo: 'BTC', data: '2025-01-01T00:00:00Z', qtd: 2, valor: 200 })], 'BTC');
  const r = resultado(c, 150);
  assert.equal(r.valor, 300);
  assert.equal(r.lucro, 100);
  assert.equal(r.pct, 50);
  assert.ok(Number.isNaN(resultado(c, undefined).pct));
});

test('números em pt-BR e en-US', () => {
  assert.equal(parseNumero('R$ 1.234,56'), 1234.56);
  assert.equal(parseNumero('1,234.56'), 1234.56);
  assert.equal(parseNumero('0,00123456'), 0.00123456);
  assert.equal(parseNumero('0.00123456'), 0.00123456);
  assert.equal(parseNumero('1.234.567,8'), 1234567.8);
  assert.equal(parseNumero('1e-8'), 1e-8);
  assert.equal(parseNumero('-5,5'), -5.5);
  assert.ok(Number.isNaN(parseNumero('')));
  assert.ok(Number.isNaN(parseNumero('abc')));
});

test('datas dd/mm/aaaa, ISO e epoch', () => {
  assert.equal(new Date(parseData('15/03/2025 14:30:00')).getFullYear(), 2025);
  assert.equal(new Date(parseData('15/03/2025')).getMonth(), 2);
  assert.equal(parseData('2025-03-15T10:00:00Z'), '2025-03-15T10:00:00.000Z');
  assert.equal(parseData('1741989600'), '2025-03-14T22:00:00.000Z');
  assert.equal(parseData('lixo'), null);
});

test('classifica tipo e ativo', () => {
  assert.equal(classificarTipo('Compra'), 'compra');
  assert.equal(classificarTipo('BUY'), 'compra');
  assert.equal(classificarTipo('Venda'), 'venda');
  assert.equal(classificarTipo('Saque'), 'saque');
  assert.equal(classificarTipo('Depósito'), 'deposito');
  assert.equal(classificarTipo('x'), null);
  assert.equal(classificarAtivo('BTC'), 'BTC');
  assert.equal(classificarAtivo('btc/brl'), 'BTC');
  assert.equal(classificarAtivo('BTCBRL'), 'BTC');
  assert.equal(classificarAtivo('Ethereum'), 'ETH');
  assert.equal(classificarAtivo('ETH-BRL'), 'ETH');
  assert.equal(classificarAtivo('ETHEREUMCLASSIC'), null);
  assert.equal(classificarAtivo('BRL'), null);
});

const CSV = [
  'Data;Tipo;Moeda;Quantidade;Preço;Total;Taxa;ID',
  '10/01/2025 10:00:00;Compra;BTC;0,01;300000,00;3000,00;7,50;A1',
  '11/01/2025 11:00:00;Compra;ETH;0,5;12000,00;6000,00;15,00;A2',
  '12/01/2025 12:00:00;Depósito;BRL;1000;;1000,00;;A3',
  '13/01/2025 13:00:00;Saque;BTC;0,0099;;;0,0001;A4',
  '14/01/2025 14:00:00;Compra;DOGE;100;1;100;0;A5',
].join('\n');

test('lê CSV, detecta colunas e converte', () => {
  const linhas = parseCSV(CSV);
  assert.equal(linhas.length, 6);
  const mapa = detectarColunas(linhas[0]);
  assert.deepEqual(mapa, { data: 0, tipo: 1, ativo: 2, qtd: 3, preco: 4, total: 5, taxa: 6, id: 7 });
  const { itens, ignoradas } = converter(linhas.slice(1), mapa, { taxaModo: 'brl' });
  assert.equal(itens.length, 3);
  assert.equal(ignoradas.deposito, 1);
  assert.equal(ignoradas.ativo, 1);
  const btc = itens.find((i) => i.tipo === 'compra' && i.ativo === 'BTC');
  assert.equal(btc.valor, 3000);
  assert.equal(btc.taxaBRL, 7.5);
  const saque = itens.find((i) => i.tipo === 'saque');
  assert.equal(saque.qtd, 0.0099);
});

test('taxa em moeda: saque guarda taxaQtd', () => {
  const linhas = parseCSV(CSV);
  const { itens } = converter(linhas.slice(1), detectarColunas(linhas[0]), { taxaModo: 'moeda' });
  assert.equal(itens.find((i) => i.tipo === 'saque').taxaQtd, 0.0001);
});

test('reimportar o mesmo arquivo gera os mesmos ids; linhas idênticas legítimas não colapsam sem id', () => {
  const sem = 'Data;Tipo;Moeda;Quantidade;Total\n10/01/2025;Compra;BTC;0,01;100\n10/01/2025;Compra;BTC;0,01;100';
  const a = converter(parseCSV(sem).slice(1), detectarColunas(parseCSV(sem)[0]));
  const b = converter(parseCSV(sem).slice(1), detectarColunas(parseCSV(sem)[0]));
  assert.deepEqual(a.itens.map((i) => i.id), b.itens.map((i) => i.id));
  assert.equal(new Set(a.itens.map((i) => i.id)).size, 2);
});

test('CSV com aspas, vírgula como separador e BOM', () => {
  const t = '﻿date,type,asset,amount,total\n"2025-01-10 10:00:00",buy,"BTC","0.01","3,000.00"';
  const l = parseCSV(t);
  assert.equal(l[1][4], '3,000.00');
  const { itens } = converter(l.slice(1), detectarColunas(l[0]));
  assert.equal(itens[0].valor, 3000);
});

test('recusa frase de recuperação e chave privada', () => {
  assert.match(validarBtc('abandon abandon abandon abandon abandon abandon'), /NUNCA/);
  assert.match(validarBtc('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'), /NUNCA/);
  assert.match(validarEth('0x' + 'a'.repeat(64)), /NUNCA/);
  assert.equal(validarBtc('1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), null);
  assert.equal(validarBtc('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), null);
  assert.equal(validarBtc('xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'), null);
  assert.equal(validarEth('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), null);
  assert.ok(validarEth('0x123'));
  assert.equal(validarBtc(''), null);
});

test('cofre: abre com a senha certa, falha com a errada, cada gravação usa IV novo', async () => {
  const estado = { v: 1, lancs: [{ id: 'x' }], cfg: { btc: 'segredo-de-teste' } };
  const { sessao, envelope } = await cofre.criar('uma frase longa de teste', estado);
  assert.ok(!JSON.stringify(envelope).includes('segredo-de-teste'));
  const { estado: lido } = await cofre.abrir('uma frase longa de teste', envelope);
  assert.deepEqual(lido, estado);
  await assert.rejects(cofre.abrir('senha errada', envelope), /senha-errada/);
  const env2 = await cofre.selar(sessao, estado);
  assert.notEqual(env2.iv, envelope.iv);
  const adulterado = { ...envelope, ct: envelope.ct.slice(0, -4) + 'AAAA' };
  await assert.rejects(cofre.abrir('uma frase longa de teste', adulterado));
  await assert.rejects(cofre.abrir('x', { v: 2 }), /arquivo-invalido/);
});

// Formato com várias seções, como o extrato real da Bitypreço (valores inventados).
const MULTI = [
  'Empresa Exemplo LTDA  CNPJ 00.000.000/000100',
  ';;;;;;',
  'Saldos no final do dia 12/10/2026',
  ';;;;;;',
  'BTC;;;0,02',
  'ETH;;;0,5',
  'BRL;;;20,90',
  ';;;;;;',
  'Depositos, Saques e Cashback',
  'Data;Tipo;Moeda;Quantidade;Preco R$,TxID',
  '25/11/2023 00:06:55;Deposito;BTC;0,001;;aaaa1111',
  '08/12/2023 08:57:29;Deposito;BRL;65,00;;',
  '14/12/2025 21:24:34;Saque;BTC;0,0005;;bbbb2222',
  ';;;;;;',
  ';;;;;;',
  'Compras e Vendas',
  'Data;Tipo;Moeda;Quantidade;Preco (R$);Total (R$)',
  '28/09/2026 10:13:30;Venda;DOGE;45,4;0,47;21,17',
  '13/11/2025 10:53:50;Compra;BTC;0,0002;500.000,00;100,00',
  '04/03/2024 16:02:09;Compra;ETH;0,01;18.000,00;180,00',
  ';;;;;;',
  'BTC total comprados:;;;0,0002',
].join('\n');

test('extrato com várias seções: acha as tabelas, o TxID e os depósitos de cripto', () => {
  const tabelas = separarTabelas(parseCSV(MULTI));
  assert.equal(tabelas.length, 2);
  assert.deepEqual(tabelas[0].cabecalho, ['Data', 'Tipo', 'Moeda', 'Quantidade', 'Preco R$', 'TxID']);
  const { itens, ignoradas } = converterTabelas(tabelas);
  assert.equal(itens.length, 4);
  assert.equal(ignoradas.deposito, 1);   // depósito em reais
  assert.equal(ignoradas.ativo, 1);      // venda de DOGE
  const dep = itens.find((i) => i.tipo === 'deposito');
  assert.equal(dep.ativo, 'BTC');
  assert.equal(dep.semCusto, true);
  assert.equal(dep.id, 'i:aaaa1111:deposito');
  assert.equal(itens.find((i) => i.tipo === 'saque').qtd, 0.0005);
  assert.equal(itens.find((i) => i.tipo === 'compra' && i.ativo === 'ETH').valor, 180);
  // reimportar não muda os ids
  assert.deepEqual(converterTabelas(separarTabelas(parseCSV(MULTI))).itens.map((i) => i.id), itens.map((i) => i.id));
});

test('arquivo simples (uma tabela, cabeçalho Data) também cai no modo de seções', () => {
  const t = separarTabelas(parseCSV(CSV));
  assert.equal(t.length, 1);
  assert.equal(converterTabelas(t).itens.length, 3);
});

test('depósito sem custo conta na quantidade mas fica fora do preço médio e do resultado', () => {
  const c = consolidar([
    L({ tipo: 'deposito', ativo: 'BTC', data: '2023-11-25T00:00:00Z', qtd: 0.001, semCusto: true }),
    L({ tipo: 'compra', ativo: 'BTC', data: '2024-01-01T00:00:00Z', qtd: 0.001, valor: 400 }),
  ], 'BTC');
  assert.equal(c.qtd, 0.002);
  assert.equal(c.qtdSemCusto, 0.001);
  assert.equal(c.precoMedio, 400000);
  const r = resultado(c, 500000);
  assert.equal(r.valor, 1000);
  assert.equal(r.valorSemCusto, 500);
  assert.equal(r.lucro, 100);          // só a parte com custo: 0,001 x 500.000 - 400
  assert.equal(r.pct, 25);
});

test('depósito com custo informado entra no preço médio; venda baixa os dois grupos na proporção', () => {
  const com = consolidar([
    L({ tipo: 'deposito', ativo: 'ETH', data: '2023-01-01T00:00:00Z', qtd: 1, valor: 100 }),
    L({ tipo: 'compra', ativo: 'ETH', data: '2023-02-01T00:00:00Z', qtd: 1, valor: 300 }),
  ], 'ETH');
  assert.equal(com.precoMedio, 200);
  const mista = consolidar([
    L({ tipo: 'deposito', ativo: 'ETH', data: '2023-01-01T00:00:00Z', qtd: 1, semCusto: true }),
    L({ tipo: 'compra', ativo: 'ETH', data: '2023-02-01T00:00:00Z', qtd: 1, valor: 300 }),
    L({ tipo: 'venda', ativo: 'ETH', data: '2023-03-01T00:00:00Z', qtd: 1, valor: 400 }),
  ], 'ETH');
  assert.equal(mista.qtd, 1);
  assert.equal(mista.qtdSemCusto, 0.5);
  assert.equal(mista.custo, 150);
  assert.equal(mista.realizado, 50);     // metade da venda (200) menos o custo de 0,5 ETH (150)
});

// ---------- conferência de saldos ----------
const comSaldo = (btc, eth) => MULTI.replace('BTC;;;0,02', 'BTC;;;' + btc).replace('ETH;;;0,5', 'ETH;;;' + eth);

test('lê os saldos do topo do extrato e ignora o resto', () => {
  const s = lerSaldos(parseCSV(MULTI));
  assert.equal(s.BTC, 0.02);
  assert.equal(s.ETH, 0.5);
  assert.equal(s.BRL, 20.9);
  assert.equal(s['CNPJ'], undefined);
});

test('diferença pequena vira taxa de rede do saque, com id fixo por moeda', () => {
  // BTC esperado: 0,0002 + 0,001 - 0,0005 = 0,0007 ; saldo 0,00068 -> taxa de 0,00002
  const linhas = parseCSV(comSaldo('0,00068', '0,01'));
  const { itens } = converterTabelas(separarTabelas(linhas));
  const { taxas, avisos } = conciliarSaldos(itens, lerSaldos(linhas));
  assert.equal(avisos.length, 0);
  assert.equal(taxas.length, 1);
  assert.equal(taxas[0].ativo, 'BTC');
  assert.equal(taxas[0].tipo, 'taxa');
  assert.equal(taxas[0].qtd, 0.00002);
  assert.equal(taxas[0].id, 'c:BTC');
  assert.equal(taxas[0].data, itens.find((i) => i.tipo === 'saque').data);   // data do último saque
  // a taxa entra no cálculo: some da quantidade, o custo fica, o preço médio sobe um pouco
  const antes = consolidar(itens, 'BTC');
  const depois = consolidar([...itens, taxas[0]], 'BTC');
  assert.ok(Math.abs(antes.qtd - depois.qtd - 0.00002) < 1e-12);
  assert.equal(antes.custo, depois.custo);
  assert.ok(depois.precoMedio > antes.precoMedio);
});

test('saldo que bate (ETH) não gera nada', () => {
  const linhas = parseCSV(comSaldo('0,00068', '0,01'));
  const { itens } = converterTabelas(separarTabelas(linhas));
  assert.equal(conciliarSaldos(itens, lerSaldos(linhas)).taxas.filter((t) => t.ativo === 'ETH').length, 0);
});

test('saldo da corretora maior que o extrato: só avisa', () => {
  const linhas = parseCSV(comSaldo('0,02', '0,01'));      // 0,02 > 0,0007 esperado
  const { itens } = converterTabelas(separarTabelas(linhas));
  const { taxas, avisos } = conciliarSaldos(itens, lerSaldos(linhas));
  assert.equal(taxas.length, 0);
  assert.match(avisos[0], /maior que o calculado/);
});

test('diferença grande demais não vira taxa: só avisa', () => {
  const linhas = parseCSV(comSaldo('0,0003', '0,01'));    // esperado 0,0007, saldo 0,0003: 57% de diferença
  const { itens } = converterTabelas(separarTabelas(linhas));
  const { taxas, avisos } = conciliarSaldos(itens, lerSaldos(linhas));
  assert.equal(taxas.length, 0);
  assert.match(avisos[0], /diferença grande/);
});

test('depois de sacar quase tudo, a taxa ainda é reconhecida (tolerância sobre o que entrou, não sobre o que sobrou)', () => {
  const itens = [
    { tipo: 'compra', ativo: 'ETH', data: '2025-01-01T00:00:00.000Z', qtd: 0.05, valor: 900, taxaBRL: 0, taxaQtd: 0 },
    { tipo: 'saque', ativo: 'ETH', data: '2025-02-01T00:00:00.000Z', qtd: 0.0495, valor: 0, taxaBRL: 0, taxaQtd: 0 },
  ];
  // sobraram 0,0005 no extrato; a corretora mostra saldo 0 -> 0,0005 foi taxa (1% do que entrou)
  const { taxas, avisos } = conciliarSaldos(itens, { ETH: 0 });
  assert.equal(avisos.length, 0);
  assert.equal(taxas[0].qtd, 0.0005);
});

// ---------- entradas na Trezor ----------
const MEU = '0xMinhaCarteira';
const txEth = (o) => ({
  txid: '0xt', blockTime: 1731291791, confirmations: 100, value: '1000',
  vin: [{ addresses: ['0xOutro'] }], vout: [{ addresses: [MEU], isOwn: true, value: '4132730000000000' }],
  ethereumSpecific: { status: 1 }, ...o,
});

test('extrai só o que chegou: confirmado, sem gasto próprio e sem falha', () => {
  const e = extrairEntradas([
    txEth({ txid: '0xok' }),
    txEth({ txid: '0xpendente', confirmations: 0 }),
    txEth({ txid: '0xfalhou', ethereumSpecific: { status: 0 } }),
    txEth({ txid: '0xenvio', vin: [{ addresses: [MEU], isOwn: true }], vout: [{ addresses: ['0xOutro'], value: '5' }] }),
  ], 'ETH', MEU);
  assert.equal(e.length, 1);
  assert.equal(e[0].txid, '0xok');
  assert.equal(e[0].qtd, 0.00413273);
  assert.equal(e[0].ts, 1731291791000);
});

test('BTC por xpub: soma as saídas marcadas como suas e ignora troco de envio', () => {
  const entrou = { txid: 'b1', blockTime: 1765758274, confirmations: 10, vin: [{ addresses: ['bc1outro'] }],
    vout: [{ addresses: ['bc1a'], isOwn: true, value: '30000' }, { addresses: ['bc1b'], isOwn: true, value: '20000' }, { addresses: ['bc1terceiro'], value: '99' }] };
  const enviou = { txid: 'b2', blockTime: 1765758999, confirmations: 10, vin: [{ addresses: ['bc1a'], isOwn: true }],
    vout: [{ addresses: ['bc1c'], isOwn: true, value: '7000' }, { addresses: ['bc1terceiro'], value: '1000' }] };
  const e = extrairEntradas([entrou, enviou], 'BTC', 'xpubQualquer');
  assert.equal(e.length, 1);
  assert.equal(e[0].qtd, 0.0005);
});

test('entrada explicada por saque some; a que o extrato não explica aparece; depois de contada, some', () => {
  const lancs = [{ id: 's1', tipo: 'saque', ativo: 'BTC', data: '2025-12-14T00:00:00.000Z', qtd: 0.0005, taxaQtd: 0 }];
  const explicada = { txid: 'tA', ts: 1765758274000, qtd: 0.0005 };
  const externa = { txid: 'tB', ts: 1731291791000, qtd: 0.00413273 };
  assert.deepEqual(entradasNaoExplicadas([explicada], lancs, 'BTC'), []);
  const sobra = entradasNaoExplicadas([externa, explicada], lancs, 'BTC');
  assert.equal(sobra.length, 1);
  assert.equal(sobra[0].txid, 'tB');
  // quem já foi contado (id t:<txid>) não aparece de novo
  assert.equal(entradasNaoExplicadas([externa], [...lancs, { id: 't:tB', tipo: 'deposito', ativo: 'BTC' }], 'BTC').length, 0);
});

test('saque com taxa descontada (chega até 2% a menos) ainda casa; chegada bem menor não casa', () => {
  const lancs = [{ id: 's1', tipo: 'saque', ativo: 'ETH', data: '2025-01-01T00:00:00.000Z', qtd: 0.05, taxaQtd: 0 }];
  assert.equal(entradasNaoExplicadas([{ txid: 'x', ts: 1, qtd: 0.0495 }], lancs, 'ETH').length, 0);
  assert.equal(entradasNaoExplicadas([{ txid: 'y', ts: 1, qtd: 0.04 }], lancs, 'ETH').length, 1);
});

test('entrada contada vira depósito e entra no total (sem custo, ou com custo se informado)', () => {
  const dep = (extra) => ({ id: 't:x', tipo: 'deposito', ativo: 'ETH', data: '2024-11-11T02:23:11.000Z', qtd: 0.00413273, taxaBRL: 0, taxaQtd: 0, origem: 'trezor', ...extra });
  const sem = consolidar([dep({ valor: 0, semCusto: true })], 'ETH');
  assert.equal(sem.qtd, 0.00413273);
  assert.equal(sem.qtdSemCusto, 0.00413273);
  const com = consolidar([dep({ valor: 80, semCusto: false })], 'ETH');
  assert.equal(com.custo, 80);
  assert.ok(Math.abs(com.precoMedio - 80 / 0.00413273) < 1e-6);
});

// ---------- simplificações ----------
test('depósito contado na Trezor que depois vira saque do extrato é detectado como duplicata', () => {
  const saque = { id: 's1', tipo: 'saque', ativo: 'BTC', data: '2025-12-14T21:24:34.000Z', qtd: 0.0005, taxaQtd: 0 };
  const dep = { id: 't:x', tipo: 'deposito', ativo: 'BTC', origem: 'trezor', data: '2025-12-14T21:34:00.000Z', qtd: 0.0005 };
  assert.deepEqual(duplicatasTrezor([saque, dep]), ['t:x']);
  // depósito de outra origem, outro ativo, ou muito depois do saque não é tocado
  assert.deepEqual(duplicatasTrezor([saque, { ...dep, origem: 'manual' }]), []);
  assert.deepEqual(duplicatasTrezor([saque, { ...dep, ativo: 'ETH' }]), []);
  assert.deepEqual(duplicatasTrezor([saque, { ...dep, data: '2026-03-01T00:00:00.000Z' }]), []);
  assert.deepEqual(duplicatasTrezor([saque, { ...dep, qtd: 0.004 }]), []);
});

test('um saque só desfaz uma duplicata', () => {
  const saque = { id: 's1', tipo: 'saque', ativo: 'BTC', data: '2025-12-14T21:24:34.000Z', qtd: 0.0005 };
  const mk = (id) => ({ id, tipo: 'deposito', ativo: 'BTC', origem: 'trezor', data: '2025-12-14T21:34:00.000Z', qtd: 0.0005 });
  assert.equal(duplicatasTrezor([saque, mk('t:a'), mk('t:b')]).length, 1);
});

test('entrada ignorada não volta a aparecer', () => {
  const e = { txid: 'tX', ts: 1731291791000, qtd: 0.004 };
  assert.equal(entradasNaoExplicadas([e], [], 'ETH').length, 1);
  assert.equal(entradasNaoExplicadas([e], [], 'ETH', ['tX']).length, 0);
});

test('taxa de saque fixa e alta (≈11% do sacado) é aceita como taxa; diferença maior que isso só avisa', () => {
  const base = [
    { tipo: 'compra', ativo: 'ETH', data: '2024-01-01T00:00:00.000Z', qtd: 0.0504, valor: 800, taxaBRL: 0, taxaQtd: 0 },
    { tipo: 'saque', ativo: 'ETH', data: '2026-10-13T21:17:00.000Z', qtd: 0.0455, valor: 0, taxaBRL: 0, taxaQtd: 0 },
  ];
  const ok = conciliarSaldos(base, { ETH: 0 });            // sobraram 0,0049 (10,8% do sacado) e a conta zerou
  assert.equal(ok.avisos.length, 0);
  assert.equal(ok.taxas[0].qtd, 0.0049);
  const sobra = [{ ...base[0], qtd: 0.07 }, base[1]];       // sobrariam 0,0245 (54% do sacado): não é taxa
  const ruim = conciliarSaldos(sobra, { ETH: 0 });
  assert.equal(ruim.taxas.length, 0);
  assert.match(ruim.avisos[0], /diferença grande/);
});

// ---------- vários cofres ----------
function armazenamentoFalso() {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  return m;
}

test('cofre antigo vira "Principal" sem migrar nada; segundo cofre é independente', async () => {
  const m = armazenamentoFalso();
  const a = await cofre.criar('senha longa do cofre A', { v: 1, nome: 'A' });
  m.set('painel.cofre.v1', JSON.stringify(a.envelope));                 // como já está no aparelho do dono
  assert.deepEqual(cofre.listar(), [{ id: 'principal', nome: 'Principal' }]);
  const b = await cofre.criar('senha longa do cofre B', { v: 1, nome: 'B' });
  const id = cofre.novoId();
  assert.notEqual(id, 'principal');
  cofre.guardar(id, b.envelope); cofre.registrar(id, 'Mãe');
  assert.deepEqual(cofre.listar().map((c) => c.nome), ['Principal', 'Mãe']);
  // cada senha abre só o seu
  assert.equal((await cofre.abrir('senha longa do cofre A', cofre.ler('principal'))).estado.nome, 'A');
  assert.equal((await cofre.abrir('senha longa do cofre B', cofre.ler(id))).estado.nome, 'B');
  await assert.rejects(cofre.abrir('senha longa do cofre A', cofre.ler(id)), /senha-errada/);
  // renomear e apagar um não toca no outro
  cofre.renomear(id, 'Mamãe');
  assert.equal(cofre.listar()[1].nome, 'Mamãe');
  cofre.apagar(id);
  assert.deepEqual(cofre.listar().map((c) => c.id), ['principal']);
  assert.ok(cofre.ler('principal'));
  assert.equal(cofre.ler(id), null);
});

test('primeiro cofre de um aparelho novo usa o id "principal"; apagar o principal não o ressuscita', async () => {
  armazenamentoFalso();
  assert.equal(cofre.existe(), false);
  assert.equal(cofre.novoId(), 'principal');
  const a = await cofre.criar('senha longa do cofre A', { v: 1 });
  cofre.guardar('principal', a.envelope); cofre.registrar('principal', 'Eu');
  cofre.apagar('principal');
  assert.equal(cofre.existe(), false);
  assert.deepEqual(cofre.listar(), []);
});
