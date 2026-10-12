// Servidor estático mínimo só para testar localmente: node tools/servir.mjs [porta]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));
const porta = Number(process.argv[2]) || 5280;
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

createServer(async (req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const arquivo = normalize(join(raiz, caminho.endsWith('/') ? caminho + 'index.html' : caminho));
  if (!arquivo.startsWith(raiz)) { res.writeHead(403).end(); return; }
  try {
    const corpo = await readFile(arquivo);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(corpo);
  } catch {
    res.writeHead(404).end('não encontrado');
  }
}).listen(porta, '127.0.0.1', () => console.log('http://localhost:' + porta));
