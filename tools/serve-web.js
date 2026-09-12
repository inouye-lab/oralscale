#!/usr/bin/env node
'use strict';
// Dead-simple static file server for local development of web/ (and bank/).
// Serves the repo root so the app can fetch ../bank/bank.json in practice mode.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.WEB_PORT || 8080);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webm': 'audio/webm', '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (rel === '/') rel = '/web/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`Web app:  http://localhost:${PORT}/web/index.html`);
  console.log(`(Start the Signer too:  npm run signer)`);
});
