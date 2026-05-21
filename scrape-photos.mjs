// No-API photo enrichment using your installed Chrome via Puppeteer.
// Loads each row's Google Maps Link in a real (headless) browser so the
// JS-rendered hero photo appears, then reads its real photo URL and writes
// data/things_to_do_photos.csv with the Image column filled in.
//
// No Google API key, no billing. Just drives Chrome locally.
//
// Run:  node scrape-photos.mjs [inputCsv]
//   default input: data/things_to_do.csv
//
// Requires: npm install puppeteer-core   (uses your existing Chrome)

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const INPUT = process.argv[2] || new URL('./data/things_to_do.csv', import.meta.url).pathname.replace(/^\//, '');
const OUT = new URL('./data/things_to_do_photos.csv', import.meta.url);

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chromePath) { console.error('No Chrome/Edge found. Edit CHROME_CANDIDATES.'); process.exit(1); }

// ---- minimal CSV parse/serialize ----
function parseCSV(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) { if (c === '"' && n === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c === '\r') {} else cur += c; }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const csvField = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = rows => rows.map(r => r.map(csvField).join(',')).join('\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const text = await readFile(INPUT, 'utf8');
const rows = parseCSV(text);
const headers = rows[0];
const linkIdx = headers.indexOf('Google Maps Link');
const imgIdx = headers.indexOf('Image');
const titleIdx = headers.indexOf('Title');
if (linkIdx < 0 || imgIdx < 0) { console.error('CSV missing "Image" or "Google Maps Link" column'); process.exit(1); }

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--lang=en-US'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
// Dismiss EU consent if it appears
async function acceptConsent() {
  try {
    const btn = await page.$('button[aria-label*="Accept"], form[action*="consent"] button');
    if (btn) { await btn.click(); await sleep(1500); }
  } catch {}
}

let filled = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r || r.length <= linkIdx) continue;
  const link = r[linkIdx];
  const title = r[titleIdx] || `row ${i}`;
  if (!link) { console.log(`· ${title}: no maps link`); continue; }

  try {
    await page.goto(link, { waitUntil: 'networkidle2', timeout: 45000 });
    await acceptConsent();
    // Wait for the hero photo button that holds the real image.
    await page.waitForSelector('img', { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    const photo = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].map(i => i.src).filter(Boolean);
      // Real place photos are served from googleusercontent (gps-cs / lh3..lh6).
      const real = imgs.find(s => /googleusercontent\.com\/(gps-cs|p\/|proxy)/.test(s) || /lh[3-6]\.googleusercontent\.com/.test(s));
      return real || '';
    });
    if (photo && !photo.includes('default_user')) {
      r[imgIdx] = photo;
      filled++;
      console.log(`✓ ${title}`);
    } else {
      console.log(`· ${title}: no photo found (kept existing)`);
    }
  } catch (e) {
    console.log(`✗ ${title}: ${e.message.split('\n')[0]}`);
  }
  await sleep(800);
}

await browser.close();
await writeFile(OUT, toCSV(rows), 'utf8');
console.log(`\nDone. Filled ${filled}/${rows.length - 1} rows.`);
console.log(`Wrote ${OUT.pathname}`);
