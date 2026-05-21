// Local server for Experience Organizer.
// Serves index.html and the data folder, and exposes POST /scrape which runs the
// Puppeteer photo enrichment (no Google API key) on a CSV uploaded from the page.
//
// Run:  node server.mjs    then open http://localhost:8000

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { enrichCsv } from './scrape-photos.mjs';

const ROOT = new URL('./', import.meta.url);
const PORT = 8000;
const TYPES = { '.html': 'text/html', '.csv': 'text/csv', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/scrape') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          console.log('Scrape request received - launching Chrome...');
          const { csv, filled, total } = await enrichCsv(body, (title, ok) => console.log(`${ok ? '✓' : '·'} ${title}`));
          console.log(`Done: ${filled}/${total} photos.`);
          res.writeHead(200, { 'Content-Type': 'text/csv', 'X-Filled': String(filled), 'X-Total': String(total) });
          res.end(csv);
        } catch (e) {
          console.error('Scrape failed:', e.message);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(e.message);
        }
      });
      return;
    }
    // static files
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    const file = new URL('.' + path, ROOT);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`Experience Organizer running at http://localhost:${PORT}`));
