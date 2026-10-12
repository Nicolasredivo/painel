// Dados 100% inventados. Rodar: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidar, resultado } from '../js/calc.js';
import { parseCSV, parseNumero, parseData, detectarColunas, converter, classificarAtivo, classificarTipo } from '../js/csv.js';
import { validarBtc, validarEth } from '../js/net.js';
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
