// Gera os ícones PNG sem depender de nenhum programa externo: node tools/gerar-icones.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const pasta = fileURLToPath(new URL('../icons/', import.meta.url));
mkdirSync(pasta, { recursive: true });

const crcTab = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = crcTab[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const bloco = (tipo, dados) => {
  const t = Buffer.from(tipo), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(dados.length); crc.writeUInt32BE(crc32(Buffer.concat([t, dados])));
  return Buffer.concat([len, t, dados, crc]);
};

const BG = [15, 23, 32], VERDE = [61, 220, 151], AZUL = [124, 196, 255];

// Distância assinada até um retângulo de cantos arredondados (negativa = dentro).
const sdf = (px, py, x, y, w, h, r) => {
  const dx = Math.abs(px - (x + w / 2)) - (w / 2 - r), dy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};

function icone(tam) {
  const u = tam / 100; // 100 unidades de desenho
  const barras = [
    { x: 24, w: 14, h: 22, cor: AZUL },
    { x: 43, w: 14, h: 36, cor: AZUL },
    { x: 62, w: 14, h: 52, cor: VERDE },
  ];
  const base = 74; // linha de base das barras (zona segura central de 60%)
  const raw = Buffer.alloc((tam * 4 + 1) * tam);
  for (let y = 0; y < tam; y++) {
    raw[y * (tam * 4 + 1)] = 0;
    for (let x = 0; x < tam; x++) {
      let r = BG[0], g = BG[1], b = BG[2];
      for (const bar of barras) {
        const d = sdf(x + 0.5, y + 0.5, bar.x * u, (base - bar.h) * u, bar.w * u, bar.h * u, 4 * u);
        const cob = Math.min(1, Math.max(0, 0.5 - d));
        if (cob > 0) { r += (bar.cor[0] - r) * cob; g += (bar.cor[1] - g) * cob; b += (bar.cor[2] - b) * cob; }
      }
      const i = y * (tam * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tam, 0); ihdr.writeUInt32BE(tam, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco('IHDR', ihdr), bloco('IDAT', deflateSync(raw, { level: 9 })), bloco('IEND', Buffer.alloc(0))]);
}

for (const [nome, tam] of [['icon-192.png', 192], ['icon-512.png', 512], ['favicon.png', 64]]) {
  writeFileSync(join(pasta, nome), icone(tam));
  console.log('gerado', nome);
}
