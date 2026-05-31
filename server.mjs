// Local server for the Data Collection System.
// Serves index.html and the data folder, and exposes:
//   POST /scrape            -> Puppeteer photo enrichment (no Google API key)
//   POST /scrape-instagram  -> Brave/DDG Instagram-handle enrichment (no API key)
//
// Run:  node server.mjs    then open http://localhost:8000

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enrichCsv } from './scrape-photos.mjs';
import { enrichInstagram } from './scrape-instagram.mjs';
import { enrichIgPosts } from './scrape-igposts.mjs';

import { writeFile } from 'node:fs/promises';

const ROOT = new URL('./', import.meta.url);
const PORT = 8000;
const TYPES = { '.html': 'text/html', '.csv': 'text/csv', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.css': 'text/css' };

// --- Pause / resume for the in-progress local enrichment run -----------------
// Set by /pause-scrape, cleared by /resume-scrape. The scrape-instagram and
// scrape-igposts loops poll shouldPause() between rows, so a click pauses
// AFTER the current row finishes cleanly (no partial-row data corruption).
let LOCAL_PAUSED = false;
const shouldPause = async () => {
  if (!LOCAL_PAUSED) return false;
  while (LOCAL_PAUSED) await new Promise((r) => setTimeout(r, 500));
  return true; // returned true => was paused at some point this call
};

// Partial save: after every row the enrich functions call onPartialSave(csv).
// We throttle disk writes to once every 5 seconds so we don't hammer the SSD
// during fast rows, but always write on the final row.
let partialLast = 0;
const PARTIAL_INTERVAL_MS = 5000;
const PARTIAL_PATH = new URL('./data/_local_enrichment.partial.csv', import.meta.url);
async function partialSave(csv, force) {
  const now = Date.now();
  if (!force && now - partialLast < PARTIAL_INTERVAL_MS) return;
  partialLast = now;
  try { await writeFile(PARTIAL_PATH, csv, 'utf8'); }
  catch (e) { console.error('partial save failed:', e.message); }
}

// Latest in-memory snapshot of the running enrichment. Updated by every
// onProgress callback so /dump-current can return it on demand without
// waiting for the run to finish.
let LATEST_CSV_SNAPSHOT = '';

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
    if (req.method === 'POST' && req.url === '/ig-login') {
      // Open the visible Chrome login window via the helper script.
      try {
        const script = fileURLToPath(new URL('./ig-login.mjs', import.meta.url));
        const child = spawn(process.execPath, [script], { cwd: fileURLToPath(ROOT), detached: true, stdio: 'ignore' });
        child.unref();
        console.log('Launched ig-login.mjs (Chrome login window).');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('launching');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(e.message);
      }
      return;
    }
    if (req.method === 'POST' && (req.url === '/pause-scrape' || req.url === '/resume-scrape')) {
      LOCAL_PAUSED = req.url === '/pause-scrape';
      console.log(LOCAL_PAUSED ? '⏸ Local enrichment PAUSED' : '▶ Local enrichment RESUMED');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ paused: LOCAL_PAUSED }));
      return;
    }
    if (req.method === 'GET' && req.url === '/scrape-status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ paused: LOCAL_PAUSED, hasSnapshot: !!LATEST_CSV_SNAPSHOT }));
      return;
    }
    if (req.method === 'GET' && req.url === '/dump-current') {
      // Return whatever the running enrichment has accumulated so far.
      // Empty 200 if no run is active yet.
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(LATEST_CSV_SNAPSHOT || '');
      return;
    }
    if (req.method === 'POST' && req.url === '/scrape-instagram-stream') {
      // Same pipeline as /scrape-instagram, but streams per-row events as
      // newline-delimited JSON so the extension can render live progress.
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });
        const send = (ev) => { try { res.write(JSON.stringify(ev) + '\n'); } catch {} };
        try {
          // Pre-count rows so the client can size the progress bar.
          const total = Math.max(
            0,
            body.split('\n').filter((l) => l.trim().length).length - 1,
          );
          send({ type: 'start', phase: 'instagram', total });
          console.log(`IG stream: ${total} rows`);

          // Reset snapshot at the start of a fresh run.
          LATEST_CSV_SNAPSHOT = body;

          const r1 = await enrichInstagram(body, async (name, handle, saw, csvSoFar) => {
            send({ type: 'ig-row', name, handle: handle || '', saw: (saw || []).slice(0, 4) });
            if (csvSoFar) { LATEST_CSV_SNAPSHOT = csvSoFar; await partialSave(csvSoFar); }
            if (await shouldPause()) send({ type: 'resumed', from: 'ig' });
          }, { shouldPause });
          send({
            type: 'phase', phase: 'igposts',
            total: r1.total, filled: r1.filled, already: r1.already,
          });

          // Hand the latest snapshot to the next stage too.
          LATEST_CSV_SNAPSHOT = r1.csv;

          const r2 = await enrichIgPosts(r1.csv, async (name, n, csvSoFar) => {
            send({ type: 'igposts-row', name, count: n, already: n === -1 });
            if (csvSoFar) { LATEST_CSV_SNAPSHOT = csvSoFar; await partialSave(csvSoFar); }
            if (await shouldPause()) send({ type: 'resumed', from: 'igposts' });
          }, { shouldPause });
          LATEST_CSV_SNAPSHOT = r2.csv;
          await partialSave(r2.csv, true);
          send({
            type: 'done',
            csv: r2.csv,
            filled: r1.filled, already: r1.already, total: r1.total,
            posts: r2.done, loggedIn: r2.loggedIn,
          });
        } catch (e) {
          console.error('Stream error:', e.message);
          send({ type: 'error', message: e.message });
        } finally {
          res.end();
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/scrape-instagram') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          console.log('Instagram scrape request received...');
          // Step 1: find missing Instagram handles.
          const r1 = await enrichInstagram(body, (name, h) => console.log(`${h ? '✓' : '·'} ${name}${h ? ' -> @' + h : ''}`));
          console.log(`Handles: ${r1.filled} new, ${r1.already} existing, ${r1.total} total.`);
          // Step 2: if logged in, collect each account's first 3 posts.
          console.log('Collecting first-3 posts (if logged in)...');
          const r2 = await enrichIgPosts(r1.csv, (name, n) => console.log(n === -1 ? `= ${name}` : (n ? `✓ ${name}: ${n} post(s)` : `· ${name}: no posts`)));
          console.log(r2.loggedIn ? `Posts: ${r2.done}/${r2.total} accounts.` : 'Posts: skipped (not logged in).');
          res.writeHead(200, {
            'Content-Type': 'text/csv',
            'X-Filled': String(r1.filled), 'X-Total': String(r1.total), 'X-Already': String(r1.already),
            'X-Posts': String(r2.done), 'X-LoggedIn': String(r2.loggedIn),
          });
          res.end(r2.csv);
        } catch (e) {
          console.error('IG scrape failed:', e.message);
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

server.listen(PORT, () => console.log(`Data Collection System running at http://localhost:${PORT}`));
