// No-API Instagram enrichment. Fills empty "Instagram" cells by trying, in order:
//   A) the place's own Website HTML (social icons),
//   B) DuckDuckGo HTML search,
//   C) Bing HTML search,
//   D) Google search via headless Chrome (Puppeteer) as a last resort.
// First valid handle wins. Writes the CSV back in place (temp-file + atomic rename).
//
// Run:  node scrape-instagram.mjs [csvPath]   (default: data/stays.csv)
// Requires: npm install puppeteer-core  (uses your existing Chrome)

import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const findChrome = () => CHROME_CANDIDATES.find(p => existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- CSV ----
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

// ---- Instagram handle validation ----
const BAD = new Set(['p','reel','reels','explore','accounts','tv','stories','about','developer','web','legal','privacy','directory','help','sharer','share','tr','i','wix','squarespace','business','blog','popular','instagram','meta']);
function handleFromUrl(u) {
  // accept https://(www.)instagram.com/<handle>[/...]
  const m = (u || '').match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  if (!m) return '';
  const h = m[1].replace(/\.$/, '');
  if (h.length < 2 || h.length > 30) return '';
  if (BAD.has(h.toLowerCase())) return '';
  return h;
}
const igUrl = h => `https://www.instagram.com/${h}/`;

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
];
let uaIx = 0;
const nextUA = () => UAS[uaIx++ % UAS.length];

async function getText(url, ua) {
  const res = await fetch(url, { headers: { 'User-Agent': ua || nextUA(), 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  return await res.text();
}
function decodeHtml(html) {
  return html.replace(/uddg=([^&"]+)/g, (_, v) => { try { return 'X=' + decodeURIComponent(v); } catch { return _; } });
}
// All valid IG handles on a page, in document order.
function allHandles(html) {
  const d = decodeHtml(html); const out = []; const re = /instagram\.com\/([A-Za-z0-9_.]+)/gi; let m;
  while ((m = re.exec(d))) { const h = handleFromUrl('instagram.com/' + m[1]); if (h) out.push(h); }
  return out;
}
// Distinctive tokens of a business name (drop generic place words).
const STOP = new Set(['el','nido','palawan','ph','the','and','de','la','by','at','of','hostel','hostels','hostal','hotel','resort','inn','lodge','pensionne','pension','guesthouse','guest','house','backpackers','backpacker','bar','cafe','beach','place','rooms','room','stay','stays','dorm','dormitels','crib','family','unit','view','viewdeck','island','residence']);
const squash = h => (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function tokensOf(name) {
  const all = norm(name).split(' ').filter(t => t.length >= 3);
  const distinctive = all.filter(t => !STOP.has(t));
  // If every word was generic (e.g. "El Nido Viewdeck"), fall back to all words
  // so a handle like "nidoviewdeck" can still match.
  return distinctive.length ? distinctive : all;
}
// Build matching hints from the name AND the row's Facebook handle + website domain.
// Lets us accept e.g. "ourmeltingpotelnido" for "ZEN Hostel OMP" (matches its FB).
function hintsFor(name, fb, site) {
  const hints = new Set(tokensOf(name));
  const fbh = (fb || '').match(/facebook\.com\/([A-Za-z0-9_.-]+)/i);
  if (fbh && !/profile\.php|reel|share|sharer|2008|help|p\b/.test(fbh[1])) hints.add(squash(fbh[1]));
  const dom = (site || '').match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i);
  if (dom && !/google|facebook|booking|cloudbeds|reddoorz|wixsite|book-directonline/.test(dom[1])) hints.add(squash(dom[1]));
  return [...hints].filter(t => t.length >= 3);
}
// Accept a handle only if it shares a distinctive hint with the business.
function matchHandle(handles, hints) {
  if (!handles.length) return '';
  for (const h of handles) { const hs = squash(h); if (hints.some(t => hs.includes(t) || t.includes(hs))) return h; }
  return '';
}

// Website: a direct instagram link in the page belongs to the business.
async function viaWebsite(site) {
  if (!/^https?:\/\//.test(site)) return [];
  if (/instagram\.com/.test(site)) { const h = handleFromUrl(site); return h ? [h] : []; }
  try { return allHandles(await getText(site)); } catch { return []; }
}
// Multi-engine search for a raw query: Brave (primary) -> DDG Lite -> DDG html.
// Returns ALL candidate handles found, in order.
async function searchQuery(query) {
  const q = encodeURIComponent(query);
  const engines = [
    `https://search.brave.com/search?q=${q}`,
    `https://lite.duckduckgo.com/lite/?q=${q}`,
    `https://html.duckduckgo.com/html/?q=${q}`,
  ];
  const found = [];
  for (const url of engines) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const t = await getText(url, nextUA());
        const blocked = t.length < 2000 || /unusual traffic|are you a robot|captcha/i.test(t);
        if (!blocked) { found.push(...allHandles(t)); break; }
      } catch {}
      await sleep(4000 + attempt * 6000);
    }
    if (found.length) break;
    await sleep(1500);
  }
  return found;
}

// Puppeteer (lazy) for the Google-search fallback.
let browser, page;
async function ensureBrowser() {
  if (browser) return;
  const chromePath = findChrome();
  if (!chromePath) throw new Error('No Chrome/Edge found');
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  page = await browser.newPage();
  await page.setCookie(
    { name: 'CONSENT', value: 'YES+cb.20210720-07-p0.en+FX+410', domain: '.google.com' },
    { name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.google.com' },
  );
}
async function viaGoogle(name) {
  try {
    await ensureBrowser();
    const q = encodeURIComponent(`${name} instagram`);
    await page.goto(`https://www.google.com/search?q=${q}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    return allHandles(await page.content());
  } catch { return []; }
}

// Enrich CSV text: fill empty Instagram cells. Returns { csv, filled, already, total }.
// onProgress(name, handleOrEmpty, sawList, currentCsv) is called per row (optional).
// opts.shouldPause: async () => boolean. Called between rows; if returns true,
//   we BLOCK until it returns false. Used by server.mjs to pause/resume.
export async function enrichInstagram(text, onProgress, opts = {}) {
  const shouldPause = opts.shouldPause || (async () => false);
  const rows = parseCSV(text);
  const headers = rows[0];
  const igIdx = headers.indexOf('Instagram');
  const titleIdx = headers.indexOf('Title');
  const siteIdx = headers.indexOf('Website');
  const fbIdx = headers.indexOf('Facebook');
  if (igIdx < 0 || titleIdx < 0) throw new Error('CSV needs "Instagram" and "Title" columns');
  browser = null; page = null;
  let filled = 0, already = 0, total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length <= igIdx) continue;
    total++;
    if (handleFromUrl(r[igIdx])) { already++; continue; }
    const name = r[titleIdx] || '';
    const fb = fbIdx >= 0 ? (r[fbIdx] || '') : '';
    const hints = hintsFor(name, fb, r[siteIdx] || '');
    const fbm = fb.match(/facebook\.com\/([A-Za-z0-9_.-]+)/i);
    const fbHandle = (fbm && !/profile\.php|reel|share|sharer|2008|help|tr$|^p$|groups/.test(fbm[1])) ? fbm[1] : '';

    const all = [];
    let h = '';
    const tryAccept = () => { h = matchHandle(all, hints); return h; };

    all.push(...await viaWebsite(r[siteIdx] || '')); tryAccept();
    if (!h) { all.push(...await searchQuery(`${name} El Nido instagram`)); tryAccept(); }
    if (!h && fbHandle) { all.push(...await searchQuery(`${fbHandle} instagram`)); tryAccept(); }
    if (!h) { all.push(...await searchQuery(`"${name}" Palawan instagram`)); tryAccept(); }
    if (!h) { all.push(...await viaGoogle(name)); tryAccept(); }

    if (h) { r[igIdx] = igUrl(h); filled++; }
    if (onProgress) await onProgress(name, h, [...new Set(all)], toCSV(rows));
    // Block here if the server has been paused (server.mjs sets the flag).
    await shouldPause();
    await sleep(3500 + Math.floor(Math.random() * 2000));
  }
  if (browser) { try { await browser.close(); } catch {} browser = null; page = null; }
  return { csv: toCSV(rows), filled, already, total };
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = (process.argv[2] && existsSync(process.argv[2]))
    ? process.argv[2]
    : fileURLToPath(new URL('./data/stays.csv', import.meta.url));
  const arg3 = process.argv[3];
  const target = (arg3 === '--inplace') ? input
    : (arg3 ? arg3 : input.replace(/\.csv$/i, '') + '_enriched.csv');
  const text = await readFile(input, 'utf8');
  const { csv, filled, already, total } = await enrichInstagram(text, (name, h, saw) =>
    console.log(h ? `✓ ${name} -> @${h}` : `· ${name}${saw.length ? '  (saw: ' + saw.slice(0, 4).join(', ') + ')' : ''}`));

  const tmp = target.replace(/[^\\/]+$/, `.ig_${Date.now()}.tmp`);
  let saved = false;
  for (let a = 0; a < 8 && !saved; a++) {
    try { await writeFile(tmp, csv, 'utf8'); try { await rm(target, { force: true }); } catch {} await rename(tmp, target); saved = true; }
    catch (e) { if (['EBUSY','EPERM','EEXIST','EACCES'].includes(e.code)) { console.log(`(locked: ${e.code}, retry in 3s)`); try { await rm(tmp, { force: true }); } catch {} await sleep(3000); } else throw e; }
  }
  if (!saved) { const fb = target.replace(/[^\\/]+$/, `ig_result_${Date.now()}.csv`); await writeFile(fb, csv, 'utf8'); console.error(`Locked. Saved to ${fb}`); process.exit(2); }
  console.log(`\nDone. Newly filled ${filled}, already had ${already}, total ${total}. Updated ${target}`);
}
