// Funciona offline e se atualiza sozinho: com internet, sempre busca a versão mais nova dos arquivos
// (revalida a cada abertura); sem internet, usa a cópia guardada. Nunca guarda dados seus nem respostas de API.
const CACHE = 'painel-casca';
const CASCA = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/util.js', 'js/vault.js', 'js/calc.js', 'js/csv.js', 'js/net.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) return; // sempre da rede
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
