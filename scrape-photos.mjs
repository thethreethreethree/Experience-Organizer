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

import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
export function findChrome() { return CHROME_CANDIDATES.find(p => existsSync(p)); }

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

// Enrich CSV text -> { csv, filled, total }.
//   onProgress(title, ok, idx, total, csvSoFar) called per row (optional).
//   The 5th arg `csvSoFar` is the serialized CSV of all rows so far - the server uses
//   it to keep LATEST_CSV_SNAPSHOT current so /dump-current can return live state.
export async function enrichCsv(text, onProgress) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('No Chrome/Edge found. Edit CHROME_CANDIDATES in scrape-photos.mjs.');
  const rows = parseCSV(text);
  const headers = rows[0];
  const linkIdx = headers.indexOf('Google Maps Link');
  const imgIdx = headers.indexOf('Image');
  const titleIdx = headers.indexOf('Title');
  if (linkIdx < 0 || imgIdx < 0) throw new Error('CSV missing "Image" or "Google Maps Link" column');

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--lang=en-US', '--window-size=1280,900'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  // Pre-accept Google consent cookies so the place page (not a consent wall) loads.
  try {
    await page.setCookie(
      { name: 'CONSENT', value: 'YES+cb.20210720-07-p0.en+FX+410', domain: '.google.com' },
      { name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.google.com' },
    );
  } catch {}

  const acceptConsent = async () => {
    try {
      const btn = await page.$('button[aria-label*="Accept all"], button[aria-label*="Accept"], form[action*="consent"] button, button[jsname="b3VHJd"]');
      if (btn) { await btn.click().catch(() => {}); await sleep(1200); }
    } catch {}
  };

  // Pull every plausible photo URL from the rendered page AND its raw HTML/JSON,
  // then pick the largest non-avatar one. Runs inside the browser context.
  const extractInPage = () => {
    const urls = new Set();
    const add = u => { if (u && typeof u === 'string') urls.add(u.replace(/\\u003d/g, '=').replace(/\\\//g, '/')); };
    // 1) <img> src / currentSrc / srcset / lazy attrs
    document.querySelectorAll('img').forEach(i => {
      add(i.src); add(i.currentSrc);
      add(i.getAttribute('data-src')); add(i.getAttribute('data-iml'));
      if (i.srcset) i.srcset.split(',').forEach(p => add(p.trim().split(' ')[0]));
    });
    // 2) CSS background-image on any element (the Maps hero photo is often a div bg)
    document.querySelectorAll('*').forEach(el => {
      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage || ''; } catch {}
      if (bg.includes('googleusercontent')) {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m) add(m[1]);
      }
    });
    // 3) Raw HTML / embedded JSON. De-escape first (JSON has \/ and =),
    //    then match any googleusercontent photo path (gps-cs, gpc, p/, a-/, etc).
    const html = document.documentElement.outerHTML
      .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const re = /https:\/\/(?:lh[3-6]|streetviewpixels-pa)\.googleusercontent\.com\/[A-Za-z0-9_\-./=]+/g;
    let m; while ((m = re.exec(html))) add(m[0]);

    // A real place photo: googleusercontent with a long photo token. Exclude tiny avatars.
    const isReal = s => /googleusercontent\.com\/(gps-cs|gps-proxy|gpc|p\/|proxy|a-\/|a\/)/.test(s)
      || /lh[3-6]\.googleusercontent\.com\/[A-Za-z0-9_-]{12,}/.test(s);
    // True avatars are tiny (<=96px) - don't filter by the "-p-" modifier any more,
    // because Google now serves regular grid thumbs with -p- too (e.g. =w156-h114-p-k-no).
    // We always upscale to =s1600 before saving, so a small-thumb URL is fine to accept.
    const isAvatar = s => {
      if (/default_user/.test(s)) return true;
      if (/=s(?:16|24|32|40|48|50|64|72|96|100|120)\b/.test(s)) return true;
      const wh = s.match(/=w(\d+)-h(\d+)/);
      if (wh && +wh[1] <= 96 && +wh[2] <= 96) return true;
      return false;
    };
    // Rough "resolution" score so we prefer the biggest available image.
    const sizeOf = s => {
      const w = s.match(/=w(\d+)/), h = s.match(/=h(\d+)/), ss = s.match(/=s(\d+)/);
      return Math.max(w ? +w[1] : 0, h ? +h[1] : 0, ss ? +ss[1] : 0) || 1; // 1 = present but unsized
    };
    const cands = [...urls].filter(isReal).filter(s => !isAvatar(s));
    cands.sort((a, b) => sizeOf(b) - sizeOf(a));
    return cands[0] || '';
  };

  // Normalize to a large, sharp image: drop any existing size token, then append one.
  // =s1600 (longest-side 1600px) is supported across all googleusercontent photo forms.
  const upscale = u => {
    const base = u.split('=')[0];
    return base + '=s1600';
  };

  // Extract a Place ID from a Google Maps URL. The "!19sChIJ..." segment is the
  // place_id; URLs built around place_id resolve reliably while raw "data=" URLs
  // go stale and stop loading the place panel.
  const placeIdOf = u => {
    const m = (u || '').match(/!19s(Ch[A-Za-z0-9_-]+)/);
    return m ? m[1] : '';
  };

  // Fetch one place with up to 3 navigation attempts. We always try the durable
  // place_id URL first; if that fails (or no place_id available) we fall back to
  // the original link from the CSV.
  const fetchPhoto = async (originalLink) => {
    const pid = placeIdOf(originalLink);
    const urls = pid
      ? [`https://www.google.com/maps/place/?q=place_id:${pid}&hl=en`, originalLink]
      : [originalLink];
    for (let attempt = 0; attempt < 3; attempt++) {
      const link = urls[Math.min(attempt, urls.length - 1)];
      try {
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
        await acceptConsent();
        // Wait until the place panel actually loads (title stops being the generic "Google Maps").
        await page.waitForFunction(
          () => document.title && !/^Google Maps/.test(document.title),
          { timeout: 20000 }
        ).catch(() => {});
        // Wait for the place heading.
        await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
        await sleep(1500);
        // Wait for a real photo URL token to appear (raw substring - HTML often has
        // escaped slashes that would fail a strict-URL regex).
        await page.waitForFunction(() => {
          const html = document.documentElement.outerHTML;
          return /gps-cs|gps-proxy|googleusercontent\.com[^"']*gpc/.test(html);
        }, { timeout: 12000 }).catch(() => {});
        // Settle: the URL appears in HTML before the DOM <img> tag actually mounts.
        // A full settle window catches single-photo places like small hostels.
        await sleep(2200);
        // First extraction attempt BEFORE scrolling - some places have a single photo
        // that gets evicted from the DOM when we scroll away from it.
        let photo = await page.evaluate(extractInPage);
        if (photo) return upscale(photo);
        // Scroll to trigger lazy-loading on grids with many photos, then re-extract.
        await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
        await sleep(1200);
        photo = await page.evaluate(extractInPage);
        if (photo) return upscale(photo);
        // Last resort: click the hero/photo button to open the gallery, then re-extract.
        try {
          const heroBtn = await page.$('button[jsaction*="hero"], button[aria-label*="Photo"], button[data-photo-index], img[decoding]');
          if (heroBtn) { await heroBtn.click().catch(() => {}); await sleep(1800); }
          photo = await page.evaluate(extractInPage);
          if (photo) return upscale(photo);
        } catch {}
      } catch {
        await sleep(2500); // backoff before retry
      }
    }
    return '';
  };

  // A cell is "already a real photo" if it's a Google user-content URL or a
  // streetview thumbnail and not the well-known "default_user" placeholder.
  // Such cells are left untouched - we never downgrade good user-supplied images.
  const isRealAlready = u => {
    if (!u) return false;
    if (/default_user|placeholder/i.test(u)) return false;
    return /lh[3-6]\.googleusercontent\.com|googleusercontent\.com\/(gps-cs|gps-proxy|gpc|p\/|proxy)|streetviewpixels-pa\.googleapis\.com/.test(u);
  };

  let filled = 0, kept = 0;
  const total = rows.length - 1;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length <= linkIdx) continue;
    const link = r[linkIdx];
    const title = r[titleIdx] || `row ${i}`;
    let ok = false;
    if (isRealAlready(r[imgIdx])) {
      // Keep the existing photo - don't touch it.
      kept++; ok = true;
      if (onProgress) onProgress(title, ok, i, total, toCSV(rows));
      continue;
    }
    if (link) {
      const photo = await fetchPhoto(link);
      if (photo) { r[imgIdx] = photo; filled++; ok = true; }
    }
    // Pass csvSoFar as 5th arg so the server can update its live snapshot.
    if (onProgress) onProgress(title, ok, i, total, toCSV(rows));
    await sleep(700);
  }
  await browser.close();
  return { csv: toCSV(rows), filled, total };
}

// ---- CLI mode ---- (robust on Windows: compare resolved file paths)
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const input = process.argv[2]
    ? process.argv[2]
    : fileURLToPath(new URL('./data/things_to_do.csv', import.meta.url));
  // Output is named after the input file (content-aware), e.g. "HOSTEL V1.csv" -> "HOSTEL V1_enriched.csv".
  // Pass a 3rd arg to override, or "--inplace" to overwrite the source.
  const arg3 = process.argv[3];
  const target = (arg3 === '--inplace') ? input
    : (arg3 ? arg3 : input.replace(/\.csv$/i, '') + '_enriched.csv');
  const text = await readFile(input, 'utf8');
  const { csv, filled, total } = await enrichCsv(text, (title, ok) => console.log(`${ok ? '✓' : '·'} ${title}`));

  // Write via a fresh temp file + rename. Avoids the "stale locked file" trap and
  // gives an atomic swap. Retries cover transient OneDrive/AV locks.
  const tmp = target.replace(/[^\\/]+$/, `.scrape_${Date.now()}.tmp`);
  let saved = false;
  for (let attempt = 0; attempt < 8 && !saved; attempt++) {
    try {
      await writeFile(tmp, csv, 'utf8');
      try { await rm(target, { force: true }); } catch {}
      await rename(tmp, target);
      saved = true;
    } catch (e) {
      if (['EBUSY', 'EPERM', 'EEXIST', 'EACCES'].includes(e.code)) {
        console.log(`(target locked: ${e.code} - retry ${attempt + 1}/8 in 3s; close the CSV / pause OneDrive if it persists)`);
        try { await rm(tmp, { force: true }); } catch {}
        await sleep(3000);
      } else { throw e; }
    }
  }
  if (!saved) {
    // Final fallback: never lose the work - dump beside the file with a timestamp.
    const fallback = target.replace(/[^\\/]+$/, `things_to_do_photos_${Date.now()}.csv`);
    await writeFile(fallback, csv, 'utf8');
    console.error(`\nLive file was locked. Saved results to:\n  ${fallback}\nClose the open CSV / pause OneDrive, then copy it over things_to_do.csv.`);
    process.exit(2);
  }
  console.log(`\nDone. Filled ${filled}/${total} rows. Updated ${target}`);
}
