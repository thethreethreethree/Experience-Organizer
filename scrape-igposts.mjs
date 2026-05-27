// Collect up to 6 thumbnail images from each row's Instagram account, using the
// logged-in session saved by ig-login.mjs (./.ig-session). Each partner card shows
// these as a swipeable horizontal strip so users can browse that partner's recent
// IG posts without leaving the app. Visual only - no clickable links.
//
// Adds columns: IG_Img_1 .. IG_Img_6   (thumbnail URLs; CDN images expire after a
// few weeks so re-run periodically to refresh).
//
// Run:  node ig-login.mjs           (once, to log in)
//       node scrape-igposts.mjs [file.csv] [--inplace]
//
// Uses a SECONDARY Instagram account. Paced to reduce the chance of being flagged.

import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const userDataDir = fileURLToPath(new URL('./.ig-session', import.meta.url));
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

const handleOf = ig => { const m = (ig || '').match(/instagram\.com\/([A-Za-z0-9_.]+)/i); return m ? m[1].replace(/\/$/, '') : ''; };

export function hasIgSession() { return existsSync(userDataDir); }

// Collect first-3 posts for each row with an IG handle. Reuses the saved login session.
// Returns { csv, done, total, loggedIn }. If not logged in, returns the CSV unchanged.
export async function enrichIgPosts(text, onProgress) {
  if (!CHROME) throw new Error('No Chrome/Edge found.');
  const rows = parseCSV(text);
  const headers = rows[0];
  const igIdx = headers.indexOf('Instagram');
  const titleIdx = headers.indexOf('Title');
  if (igIdx < 0) throw new Error('CSV needs an "Instagram" column');

  // Up to 6 thumbnails per partner - rendered as a per-card swipeable IG row.
  // Per-post URLs are NOT collected (the field is visual only, no taps).
  const NEWCOLS = ['IG_Img_1', 'IG_Img_2', 'IG_Img_3', 'IG_Img_4', 'IG_Img_5', 'IG_Img_6'];
  for (const col of NEWCOLS) if (!headers.includes(col)) { headers.push(col); for (let i = 1; i < rows.length; i++) rows[i].push(''); }
  const idx = Object.fromEntries(NEWCOLS.map(c => [c, headers.indexOf(c)]));

  if (!existsSync(userDataDir)) return { csv: toCSV(rows), done: 0, total: 0, loggedIn: false };

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir, args: ['--no-sandbox', '--lang=en-US'] });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(2500);
  const cookies = await page.cookies('https://www.instagram.com');
  if (!cookies.some(c => c.name === 'sessionid' && c.value)) { await browser.close(); return { csv: toCSV(rows), done: 0, total: 0, loggedIn: false }; }

  // Pull up to 6 unique post thumbnail URLs from the profile grid (DOM order = most
  // recent first). We ignore the post URLs themselves - users swipe within the card.
  const firstThumbs = async (handle) => {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'networkidle2', timeout: 40000 });
    await sleep(2500);
    await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
    await sleep(1500);
    return await page.evaluate(() => {
      const seen = new Set(), imgs = [];
      for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
        const m = a.getAttribute('href').match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (!m) continue;
        if (seen.has(m[2])) continue; seen.add(m[2]);
        const img = a.querySelector('img');
        const src = img ? (img.currentSrc || img.src || '') : '';
        if (src) imgs.push(src);
        if (imgs.length >= 6) break;
      }
      return imgs;
    });
  };

  let done = 0, total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length <= igIdx) continue;
    const handle = handleOf(r[igIdx]);
    const name = r[titleIdx] || handle || `row ${i}`;
    if (!handle) continue;
    total++;
    // Skip if thumbnails are already populated (re-runs only refresh empties).
    if (r[idx.IG_Img_1]) { if (onProgress) onProgress(name, -1); continue; }
    let n = 0;
    try {
      const thumbs = await firstThumbs(handle);
      thumbs.slice(0, 6).forEach((src, k) => { r[idx['IG_Img_' + (k + 1)]] = src; });
      n = thumbs.length; if (n) done++;
    } catch {}
    if (onProgress) onProgress(name, n);
    await sleep(6000 + Math.floor(Math.random() * 3000));
  }
  await browser.close();
  return { csv: toCSV(rows), done, total, loggedIn: true };
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(userDataDir)) { console.error('No saved session. Run "node ig-login.mjs" first and log in.'); process.exit(1); }
  const input = (process.argv[2] && existsSync(process.argv[2])) ? process.argv[2] : fileURLToPath(new URL('./data/stays.csv', import.meta.url));
  const target = process.argv.includes('--inplace') ? input : input.replace(/\.csv$/i, '') + '_enriched.csv';
  const text = await readFile(input, 'utf8');
  const { csv, done, total, loggedIn } = await enrichIgPosts(text, (name, n) =>
    console.log(n === -1 ? `= ${name}: already has posts` : (n ? `✓ ${name}: ${n} post(s)` : `· ${name}: no posts`)));
  if (!loggedIn) { console.error('Not logged in. Run "node ig-login.mjs" first.'); process.exit(1); }
  const tmp = target.replace(/[^\\/]+$/, `.igp_${Date.now()}.tmp`);
  let saved = false;
  for (let a = 0; a < 8 && !saved; a++) {
    try { await writeFile(tmp, csv, 'utf8'); try { await rm(target, { force: true }); } catch {} await rename(tmp, target); saved = true; }
    catch (e) { if (['EBUSY','EPERM','EEXIST','EACCES'].includes(e.code)) { console.log(`(locked: ${e.code}, retry 3s)`); try { await rm(tmp, { force: true }); } catch {} await sleep(3000); } else throw e; }
  }
  if (!saved) { const fb = target.replace(/[^\\/]+$/, `igposts_${Date.now()}.csv`); await writeFile(fb, csv, 'utf8'); console.error(`Locked. Saved to ${fb}`); process.exit(2); }
  console.log(`\nDone. Collected posts for ${done}/${total} accounts. Updated ${target}`);
}
