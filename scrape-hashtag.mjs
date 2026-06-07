// Travel Feed: collect Instagram photo posts by hashtag for a region.
// Walks https://www.instagram.com/explore/tags/<tag>/ in the saved logged-in session
// (./.ig-session, shared with scrape-igposts.mjs), scrolls the grid to load more
// posts, then visits each post and extracts the 7 Wondavu template fields:
//   handle, caption, image_url, location_label, ig_post_url, likes_label, verified
//
// WHY image-only: IG never ships og:video, the DOM <video> uses blob: URLs (MediaSource
// API), and the network response is a byte-range fragment (bytestart=0&byteend=975) -
// none of which produce an exportable, playable video URL. So the feed is photo-only.
// Reels are detected via the network-response listener and dropped before extraction.
//
// Run:  node ig-login.mjs                                    (once, to log in)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wondavu template column order. Header row is required, columns are case-sensitive.
const HEADERS = ['handle', 'caption', 'image_url', 'location_label', 'ig_post_url', 'likes_label', 'verified'];
const csvField = (v) => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
// Trailing newline per Wondavu contract ("One blank line at the end of the file").
const toCSV = (rows) => [HEADERS.join(','), ...rows.map((r) => HEADERS.map((h) => csvField(r[h])).join(','))].join('\n') + '\n';

// Sentinel return from fetchPost when IG hands us Chrome's HTTP 429 error page. The
// loop logs it, backs off, and continues - we falsified the "persistent throttle"
// hypothesis (direct curl to the same URL returns 200), so it's transient noise.
const RATE_LIMITED = Symbol('rate-limited');

// Strip the leading '#' and lowercase. IG tag URLs are case-insensitive but canonical lowercase.
const normTag = (t) => (t || '').trim().replace(/^#/, '').toLowerCase();

// Comma/space/newline-separated list of tags → clean array, deduped.
export function parseTags(input) {
  return [...new Set(String(input || '').split(/[\s,;]+/).map(normTag).filter(Boolean))];
}

// Convert IG's display-style likes label to a number. Handles "2,443", "29K", "1.2M".
// Returns 0 for empty/unparseable - which, when a minLikes threshold is active, rejects the row.
export function parseLikes(label) {
  if (!label) return 0;
  const m = String(label).trim().match(/^([\d.,]+)\s*([KMB])?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(n)) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

// Pull post shortcodes from the hashtag grid. Scrolls until we have `want` or the grid
// stops growing. Returns an array of /p/<code>/ or /reel/<code>/ hrefs in IG's order.
async function collectShortcodes(page, tag, want, onTick) {
  await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3500);
  const seen = new Set();
  let stagnant = 0;
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
    if (seen.size === before) { stagnant++; if (stagnant >= 4) break; } else stagnant = 0;
    await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
    await sleep(2200 + Math.floor(Math.random() * 800));
  }
  return [...seen].slice(0, want);
}

// Visit a single post URL and pull the template fields. Returns null on extraction failure,
// or RATE_LIMITED when Chrome hits HTTP 429.
//
// EVIDENCE-BASED EXTRACTION (verified by live diagnostic):
//   og:title       = "<Display Name> on Instagram: \"<caption>\""   (caption lives here)
//   og:description = "<N> likes, <M> comments - <handle> on <date>: ..."  (handle + likes)
//   og:image       = CDN URL                                        (cover image)
//   <script ld+json>     = NOT shipped for posts
//   <article> anchors    = always 0 in headless (dead-end strategy)
async function fetchPost(page, href, regionLabel, captureCtx) {
  const url = `https://www.instagram.com${href}`;
  if (captureCtx) captureCtx.setHref(href);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    // Give video responses (Reel cover playback) a moment to fire so the listener
    // can flag the post as a Reel before we decide to keep it.
    await sleep(800);
    // Detect Chrome's HTTP 429 error page before wasting time on selectors.
    if (page.url().startsWith('chrome-error://')) {
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/HTTP ERROR 429/.test(bodyText)) { console.log(`  post ${href}: HTTP 429`); return RATE_LIMITED; }
      console.log(`  post ${href}: chrome-error (${bodyText.slice(0, 60).replace(/\n/g, ' ')})`);
      return null;
    }
    // Wait for the article skeleton. Some posts (private/deleted) never render one;
    // we still try to read og:* from the head before giving up.
    await page.waitForSelector('article, main', { timeout: 12000 }).catch(() => {});
    await sleep(2200);

    const data = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
      const ogDesc  = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';

      // Handle: og:description's "- <handle> on <date>" pattern. IG ships this on every public post.
      let handle = '';
      let handleSource = '';
      const mDesc = ogDesc.match(/(?:likes|comments|views|plays)\s*-\s*([A-Za-z0-9_.]+)\s+on\s+/i);
      if (mDesc) { handle = mDesc[1]; handleSource = 'og:desc'; }
      else {
        // Very rare fallback: some restricted posts use "(@handle)" in og:title.
        const mTitle = ogTitle.match(/\(@([A-Za-z0-9_.]+)\)/);
        if (mTitle) { handle = mTitle[1]; handleSource = 'og:title-paren'; }
      }

      // Caption: og:title text after "on Instagram:" (quotes may be straight or curly).
      let caption = '';
      const mCap = ogTitle.match(/on Instagram[^:]*:\s*["“]?([\s\S]+?)["”]?\s*$/i);
      if (mCap) caption = mCap[1].trim();
      else if (ogDesc) {
        const mD = ogDesc.match(/:\s*([\s\S]+?)\s*$/);
        if (mD) caption = mD[1].trim();
      }

      // Likes: leading "<N> likes" in og:description.
      let likes_label = '';
      const mLikes = ogDesc.match(/^([\d,.KMB]+)\s+likes/i);
      if (mLikes) likes_label = mLikes[1];

      // Verified badge: any <svg aria-label="Verified"> near the username.
      const verified = !!document.querySelector('article svg[aria-label="Verified"], header svg[aria-label="Verified"]');

      // Location: article body text often renders <handle>\n<location>\nFollow when a place is tagged.
      let location_label = '';
      if (handle) {
        const articleText = document.querySelector('article')?.innerText || '';
        const lines = articleText.split('\n').map((s) => s.trim()).filter(Boolean);
        for (let i = 2; i < lines.length; i++) {
          if (lines[i] === 'Follow' && lines[i - 2] === handle && lines[i - 1] !== handle) { location_label = lines[i - 1]; break; }
        }
      }

      return {
        handle, caption, image_url: ogImage, location_label, verified, likes_label,
        _hasOgImage: !!ogImage, _hasOgDesc: !!ogDesc, _handleSource: handleSource,
      };
    });

    // Drop rows that came back completely empty (deleted/private posts that didn't render anything).
    if (!data.handle && !data.image_url) return null;

    console.log(`  post ${href}: handle=${data.handle || '(none)'} (${data._handleSource || '-'}) img=${data.image_url ? 'yes' : 'no'} cap=${(data.caption || '').length}ch likes=${data.likes_label || '-'}`);

    const location_label = data.location_label || regionLabel || '';
    // Caption is REQUIRED by Wondavu. When extraction misses, fall back to the location
    // label so the importer never receives an empty caption. Do NOT invent content.
    let caption = (data.caption || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!caption) caption = location_label;
    return {
      handle: data.handle || '',
      caption,
      image_url: data.image_url || '',
      location_label,
      ig_post_url: url,
      // Contract default: "0" if empty. Stamped here so the importer has no ambiguity.
      likes_label: data.likes_label || '0',
      verified: data.verified ? 'true' : 'false',
    };
  } catch (e) {
    console.log(`  post ${href}: error ${e.message}`);
    return null;
  }
}

// Main entry. tags: array of bare hashtag names. want: target kept count. regionLabel:
// stamped into location_label when IG doesn't expose a location for the post.
// opts.minLikes: drop posts below this threshold (default 0 = disabled).
// opts.imageOnly: drop Reels (detected via network response listener). Default false here;
//   the server endpoint and UI default it to true (the "photofeed" intent).
// opts.shouldPause: async () => boolean - blocks between posts when paused.
//
// onProgress(ev): {phase:'discover',tag,found} | {phase:'fetch',i,total,name,ok,reason,kept,want,rejected*,csvSoFar}
export async function enrichHashtag(tags, want, regionLabel, onProgress, opts = {}) {
  const shouldPause = opts.shouldPause || (async () => false);
  const minLikes = Math.max(0, parseInt(opts.minLikes, 10) || 0);
  const imageOnly = !!opts.imageOnly;
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

  // Network-response listener as a Reel detector. IG fires video/mp4 responses on Reel
  // page loads (URL contains /o1/v/); image posts produce none. We just track yes/no
  // per href - we DON'T try to capture the URL since IG only serves byte-range fragments.
  const hasVideo = Object.create(null);
  let currentHref = null;
  page.on('response', (resp) => {
    if (!currentHref || hasVideo[currentHref]) return;
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    const isVideo = /^video\//i.test(ct) || /\/o1\/v\//i.test(u);
    if (isVideo && resp.status() === 200) hasVideo[currentHref] = true;
  });

  // Verify the saved session is still logged in. Without sessionid, the explore page is
  // logged-out-throttled and many posts return blank.
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(2500);
  const cookies = await page.cookies('https://www.instagram.com');
  if (!cookies.some((c) => c.name === 'sessionid' && c.value)) {
    await browser.close();
    throw new Error('Instagram session expired. Click "Log in to Instagram" again.');
  }

  // Discovery overscan: filters narrow the qualifying set so we need more URLs queued than
  // the kept target. Empirically on #elnido: ~50% of posts are images, ~30% have ≥1000 likes.
  const target = Math.max(1, parseInt(want, 10) || 100);
  let overscanMult = 2;
  if (minLikes > 0) overscanMult *= minLikes >= 1000 ? 3 : 2;
  if (imageOnly) overscanMult *= 2;
  const overscan = Math.min(target * overscanMult, target + 400);

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

  // Snapshot throttling: serializing the CSV every row on big runs is wasteful and blocks
  // V8. maybeSnap() returns the CSV at most once every 5s, else empty.
  const rows = [];
  let lastSnap = 0;
  const SNAP_EVERY = 5000;
  const maybeSnap = () => { const now = Date.now(); if (now - lastSnap < SNAP_EVERY) return ''; lastSnap = now; return toCSV(rows); };

  const captureCtx = {
    setHref: (h) => { currentHref = h; },
    consumeHasVideo: (h) => { const v = !!hasVideo[h]; delete hasVideo[h]; return v; },
  };

  let rejectedLowLikes = 0;
  let rejectedReels = 0;
  let rateLimitHits = 0;
  for (let i = 0; i < hrefList.length && rows.length < target; i++) {
    const href = hrefList[i];
    const result = await fetchPost(page, href, regionLabel, captureCtx);
    if (result === RATE_LIMITED) {
      rateLimitHits++;
      if (onProgress) await onProgress({
        phase: 'fetch', i: i + 1, total: hrefList.length, name: href,
        ok: false, reason: 'HTTP 429 (will retry after backoff)',
        kept: rows.length, want: target,
        rejected: rejectedLowLikes + rejectedReels,
        rejectedLowLikes, rejectedReels, rateLimitHits,
      });
      await sleep(20000 + Math.floor(Math.random() * 10000));
      continue;
    }
    rateLimitHits = 0;
    const row = result;
    let kept = false;
    let rejectReason = '';
    if (row) {
      const wasReel = captureCtx.consumeHasVideo(href);
      if (imageOnly && wasReel) {
        rejectedReels++; rejectReason = 'Reel (image-only mode)';
      } else if (minLikes > 0) {
        const likes = parseLikes(row.likes_label);
        if (likes >= minLikes) { rows.push(row); kept = true; }
        else { rejectedLowLikes++; rejectReason = `<${minLikes} likes (${likes || 'unknown'})`; }
      } else {
        rows.push(row); kept = true;
      }
    }
    if (onProgress) await onProgress({
      phase: 'fetch',
      i: i + 1,
      total: hrefList.length,
      name: row?.handle ? '@' + row.handle : href,
      ok: kept,
      reason: rejectReason,
      kept: rows.length,
      want: target,
      rejected: rejectedLowLikes + rejectedReels,
      rejectedLowLikes,
      rejectedReels,
      csvSoFar: maybeSnap(),
    });
    await shouldPause();
    await sleep(4500 + Math.floor(Math.random() * 2500));
  }

  await browser.close();
  return { csv: toCSV(rows), kept: rows.length, attempted: hrefList.length, rejectedLowLikes, rejectedReels, target };
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tagsArg = process.argv[2] || 'ELNIDO';
  const countArg = parseInt(process.argv[3] || '100', 10);
  const regionArg = process.argv[4] || '';
  const tagList = parseTags(tagsArg);
  if (!tagList.length) { console.error('Usage: node scrape-hashtag.mjs "tag1,tag2" <count> "Region Label"'); process.exit(1); }
  console.log(`Collecting up to ${countArg} image posts from #${tagList.join(', #')}${regionArg ? ` (region: ${regionArg})` : ''}…`);
  const { csv, kept, attempted, rejectedReels, rejectedLowLikes } = await enrichHashtag(tagList, countArg, regionArg, (ev) => {
    if (ev.phase === 'discover') console.log(`· discovering #${ev.tag} — ${ev.found} so far`);
    else if (ev.phase === 'fetch') console.log(`${ev.ok ? '✓' : '·'} [${ev.i}/${ev.total}] ${ev.name}${ev.reason ? ' — ' + ev.reason : ''} (kept ${ev.kept}/${ev.want})`);
  }, { imageOnly: true, minLikes: 1000 });
  const out = `data/hashtag_feed_${Date.now()}.csv`;
  await writeFile(new URL('./' + out, import.meta.url), csv, 'utf8');
  console.log(`\nDone. Kept ${kept}/${attempted} (rejected ${rejectedReels} Reels, ${rejectedLowLikes} below min-likes). Saved to ${out}`);
}
