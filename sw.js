// Service Worker do MOCI — torna o site instalável como app e abre a "casca"
// (páginas, estilo, scripts, ícones) mesmo sem sinal.
//
// SEGURANÇA: só arquivos do próprio site entram no cache. Tudo o que vem de
// outra origem — o backend do Apps Script (login, sessões, OCIs, usuários),
// os mapas, o Leaflet e as fontes — passa direto pela rede e NUNCA é guardado
// aqui. Assim nenhum dado de ocupação ou de usuário fica salvo no aparelho.
//
// Estratégia: network-first para HTML/CSS/JS (sempre a versão mais nova quando
// há sinal; o cache só cobre a falta de sinal); cache-first só para imagens e
// manifesto. Mudou a estratégia ou a lista? Suba a versão abaixo.
var CACHE_NAME = 'moci-v1';
var CACHE_ASSETS = [
  './',
  './index.html',
  './listar.html',
  './conta.html',
  './usuarios.html',
  './log.html',
  './apresentacoes.html',
  './style.css',
  './auth.js',
  './app.js',
  './CAT-SERTAO-SEM-FUNDO.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './manifest.webmanifest'
];

// cache.add por item (não addAll): um único 404 não derruba a instalação inteira.
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(CACHE_ASSETS.map(function (url) {
        return cache.add(url).catch(function () { /* segue sem esse item */ });
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.map(function (n) {
        if (n.indexOf('moci-') === 0 && n !== CACHE_NAME) return caches.delete(n);
      }));
    })
  );
  self.clients.claim();
});

var RAIZ = new URL('./', self.registration.scope).href;

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;            // POST (login, cadastro) nunca passa pelo cache
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // Apps Script, mapas, CDNs: só rede

  var p = url.pathname;
  var navegacao = e.request.mode === 'navigate';

  if (navegacao || p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.js')) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        if (res && res.status === 200) {
          var copia = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(e.request, copia); });
        }
        return res;
      }).catch(function () {
        return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
          if (hit) return hit;
          return caches.match(RAIZ + 'index.html').then(function (home) {
            return home || new Response('<h1>Sem conexão</h1><p>Abra o MOCI de novo quando houver sinal.</p>',
              { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
          });
        });
      })
    );
    return;
  }

  if (/\.(png|jpg|jpeg|svg|webp|ico|webmanifest)$/i.test(p)) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (res) {
          if (res && res.status === 200) {
            var copia = res.clone();
            caches.open(CACHE_NAME).then(function (c) { c.put(e.request, copia); });
          }
          return res;
        });
      })
    );
  }
  // Demais arquivos (ex.: PDFs grandes das apresentações): rede normal, sem cache.
});
