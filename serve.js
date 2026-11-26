/* Noll-beroende lokal server: node serve.js [port] */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8', '.zip': 'application/zip'
};

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/') pathname = '/index.html';

  // Lokal motsvarighet till Netlify _redirects för Catbox.
  if (pathname === '/api/filehost' || pathname === '/api/tmpfiles') {
    const target = pathname === '/api/tmpfiles'
      ? 'https://tmpfiles.org/api/v1/upload'
      : 'https://catbox.moe/user/api.php';
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] || 'multipart/form-data' },
          body: Buffer.concat(chunks)
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxyfel: ' + e.message);
      }
    });
    return;
  }

  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 – ' + pathname); }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}).listen(port, () => console.log(`🌿 Terrarium körs på http://localhost:${port}`));
