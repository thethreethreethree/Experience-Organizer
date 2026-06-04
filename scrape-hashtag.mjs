// Collect Instagram posts by hashtag for a "traveler feed" CSV.
// Walks https://www.instagram.com/explore/tags/<tag>/ in the saved logged-in session
// (./.ig-session, shared with scrape-igposts.mjs), scrolls the grid to load more
// posts, then visits each post URL to extract the 7 template fields:
//   handle, caption, image_url, location_label, ig_post_url, likes_label, verified
//
// Run:  node ig-login.mjs                                  (once, to log in)
//       node scrape-hashtag.mjs "ELNIDO,ELNIDOPhilippines" 100 "El Nido, Palawan"

import { writeFile } from 'node:fs/promises';
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

const HEADERS = ['handle', 'caption', 'image_url', 'location_label', 'ig_post_url', 'likes_label', 'verified'];
const csvField = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = rows => [HEADERS.join(','), ...rows.map(r => HEADERS.map(h => csvField(r[h])).join(','))].join('\n');

// Strip the leading '#' and lowercase. IG tag URLs are case-insensitive but canonical lowercase.
const normTag = t => (t || '').trim().replace(/^#/, '').toLowerCase();

// Parse a comma/space/newline-separated list of tags into a clean array, deduped.
export function parseTags(input) {
  return [...new Set(String(input || '').split(/[\s,;]+/).map(normTag).filter(Boolean))];
}

// Pull post shortcodes from the hashtag grid. Scrolls until we have `want` or the
// grid stops growing. Returns an array of /p/<code> or /reel/<code> hrefs in the
// order Instagram returned them (Top + Recent intermixed).
async function collectShortcodes(page, tag, want, onTick) {
  await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3500);
  const seen = new Set();
  let stagnantRounds = 0;
  for (let round = 0; round < 60 && seen.size < want; round++) {
    const fresh = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
        const m = a.getAttribute('href').match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (m) out.push(`/${m[1]}/${m[2]}/`);
      }
      return out;
    });
    const before = seen.size;
    for (const h of fresh) seen.add(h);
    if (onTick) onTick(seen.size);
    if (seen.size === before) {
      stagnantRounds++;
      if (stagnantRounds >= 4) break; // grid stopped giving us new posts
    } else stagnantRounds = 0;
    await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
    await sleep(2200 + Math.floor(Math.random() * 800));
  }
  return [...seen].slice(0, want);
}

// Visit a single post URL and pull the 7 template fields. Returns null on failure.
async function fetchPost(page, href, regionLabel) {
  const url = `https://www.instagram.com${href}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(1600);
    const data = await page.evaluate(() => {
      // Header link with the author's handle. Instagram puts it in the role=link/anchor
      // that wraps the avatar + username near the top of the post dialog.
      let handle = '';
      for (const a of document.querySelectorAll('header a, article header a')) {
        const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_.]+)\/?$/);
        if (m && m[1] && !['p', 'reel', 'explore', 'accounts'].includes(m[1])) { handle = m[1]; break; }
      }
      // Verified badge sits inside the username header. We accept any svg/title containing "Verified".
      const verifiedNode = document.querySelector('header svg[aria-label="Verified"], header svg title');
      const verified = !!(document.querySelector('header svg[aria-label="Verified"]') ||
        [...document.querySelectorAll('header svg title')].some(t => /verified/i.test(t.textContent || '')));
      // Caption: the article's first <h1> or first dialog <h1> is the caption text in the
      // post permalink view. Fall back to the og:description meta which Instagram still ships.
      let caption = '';
      const h1 = document.querySelector('article h1') || document.querySelector('main h1');
      if (h1) caption = h1.innerText.trim();
      if (!caption) {
        const og = document.querySelector('meta[property="og:description"]');
        if (og) caption = (og.getAttribute('content') || '').replace(/^.*?: \"?/, '').replace(/\"$/, '').trim();
      }
      // Main image: prefer the og:image meta (highest-quality CDN URL); fall back to the
      // largest <img> currently in the article.
      let image_url = '';
      const ogimg = document.querySelector('meta[property="og:image"]');
      if (ogimg) image_url = ogimg.getAttribute('content') || '';
      if (!image_url) {
        const imgs = [...document.querySelectorAll('article img, main img')].filter(i => i.width >= 300);
        if (imgs.length) image_url = imgs[0].currentSrc || imgs[0].src || '';
      }
      // Location: an anchor pointing at /explore/locations/<id> shown above the caption when present.
      let location_label = '';
      const locA = document.querySelector('a[href*="/explore/locations/"]');
      if (locA) location_label = (locA.innerText || locA.textContent || '').trim();
      // Likes: IG shows "1,234 likes" or "Liked by ... and 1,234 others". Pull the first
      // number-with-commas we find in the article footer block.
      let likes_label = '';
      const txt = (document.querySelector('article')?.innerText) || document.body.innerText || '';
      const m = txt.match(/([\d.,KMB]+)\s+(?:likes|views|plays)/i);
      if (m) likes_label = m[1];
      return { handle, caption, image_url, location_label, verified };
    });
    if (!data.handle) return null;
    // Compress caption to a single line so the CSV stays one-row-per-post.
    const caption = (data.caption || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    return {
      handle: data.handle,
      caption,
      image_url: data.image_url || '',
      // Prefer the IG-reported location when we have one; otherwise stamp the region label
      // the user provided so the CSV is never blank in that column.
      location_label: data.location_label || regionLabel || '',
      ig_post_url: url,
      likes_label: data.likes_label || '',
      verified: data.verified ? 'true' : 'false',
    };
  } catch { return null; }
}

// Main entry. tags: array of bare hashtag names; want: target post count; regionLabel: stamped
// into location_label when IG doesn't expose a location for the post.
// onProgress(ev) is called with {phase, ...} events for live UI updates:
//   {phase:'discover', tag, found}
//   {phase:'fetch', i, total, name, ok, csvSoFar}
// opts.shouldPause: async () => boolean — blocks between posts when paused.
export async function enrichHashtag(tags, want, regionLabel, onProgress, opts = {}) {
  const shouldPause = opts.shouldPause || (async () => false);
  if (!CHROME) throw new Error('No Chrome/Edge found.');
  if (!existsSync(userDataDir)) throw new Error('Not logged in to Instagram. Click "Log in to Instagram" on the home page first.');
  const tagList = Array.isArray(tags) ? tags : parseTags(tags);
  if (!tagList.length) throw new Error('At least one hashtag is required.');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, userDataDir,
    args: ['--no-sandbox', '--lang=en-US'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });

  // Verify the saved session is still logged in. If sessionid is missing, bail loudly
  // instead of silently scraping the logged-out (rate-limited) hashtag view.
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(2500);
  const cookies = await page.cookies('https://www.instagram.com');
  if (!cookies.some(c => c.name === 'sessionid' && c.value)) {
    await browser.close();
    throw new Error('Instagram session expired. Click "Log in to Instagram" again.');
  }

  // Phase 1: discover post URLs across all tags. We over-collect (2x) so dedup + post-level
  // failures still leave us with enough posts to reach `want`.
  const target = Math.max(1, parseInt(want, 10) || 100);
  const overscan = Math.min(target * 2, target + 60);
  const allHrefs = new Set();
  for (const tag of tagList) {
    if (allHrefs.size >= overscan) break;
    const need = overscan - allHrefs.size;
    if (onProgress) await onProgress({ phase: 'discover', tag, found: allHrefs.size });
    const hrefs = await collectShortcodes(page, tag, need, async (n) => {
      if (onProgress) await onProgress({ phase: 'discover', tag, found: allHrefs.size + n });
    });
    for (const h of hrefs) allHrefs.add(h);
    await sleep(2000);
  }
  const hrefList = [...allHrefs].slice(0, overscan);

  // Phase 2: visit each post and extract fields.
  const rows = [];
  // Snapshot throttling: serializing the CSV every row on big runs is wasteful. Cap to once per 5s.
  let lastSnap = 0;
  const SNAP_EVERY = 5000;
  const maybeSnap = () => { const now = Date.now(); if (now - lastSnap < SNAP_EVERY) return ''; lastSnap = now; return toCSV(rows); };

  for (let i = 0; i < hrefList.length && rows.length < target; i++) {
    const href = hrefList[i];
    const row = await fetchPost(page, href, regionLabel);
    if (row) rows.push(row);
    if (onProgress) await onProgress({
      phase: 'fetch',
      i: i + 1,
      total: hrefList.length,
      name: row?.handle ? '@' + row.handle : href,
      ok: !!row,
      kept: rows.length,
      want: target,
      csvSoFar: maybeSnap(),
    });
    await shouldPause();
    await sleep(4500 + Math.floor(Math.random() * 2500));
  }

  await browser.close();
  return { csv: toCSV(rows), kept: rows.length, attempted: hrefList.length, target };
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tagsArg = process.argv[2] || 'ELNIDO';
  const countArg = parseInt(process.argv[3] || '100', 10);
  const regionArg = process.argv[4] || '';
  const tagList = parseTags(tagsArg);
  if (!tagList.length) { console.error('Usage: node scrape-hashtag.mjs "tag1,tag2" <count> "Region Label"'); process.exit(1); }
  console.log(`Collecting up to ${countArg} posts from #${tagList.join(', #')}${regionArg ? ` (region: ${regionArg})` : ''}…`);
  const { csv, kept, attempted } = await enrichHashtag(tagList, countArg, regionArg, (ev) => {
    if (ev.phase === 'discover') console.log(`· discovering #${ev.tag} — ${ev.found} so far`);
    else if (ev.phase === 'fetch') console.log(`${ev.ok ? '✓' : '·'} [${ev.i}/${ev.total}] ${ev.name} (kept ${ev.kept}/${ev.want})`);
  });
  const out = `data/hashtag_feed_${Date.now()}.csv`;
  await writeFile(new URL('./' + out, import.meta.url), csv, 'utf8');
  console.log(`\nDone. Saved ${kept}/${attempted} posts to ${out}`);
}
