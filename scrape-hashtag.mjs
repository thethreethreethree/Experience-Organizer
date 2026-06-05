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

const HEADERS = ['handle', 'caption', 'image_url', 'video_url', 'location_label', 'ig_post_url', 'likes_label', 'verified'];
const csvField = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
// Trailing newline per Wondavu contract ("One blank line at the end of the file").
const toCSV = rows => [HEADERS.join(','), ...rows.map(r => HEADERS.map(h => csvField(r[h])).join(','))].join('\n') + '\n';

// Strip the leading '#' and lowercase. IG tag URLs are case-insensitive but canonical lowercase.
const normTag = t => (t || '').trim().replace(/^#/, '').toLowerCase();

// Convert IG's display-style likes label to a number. Handles "2,443", "29K", "1.2M", "1.5B".
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
// On a post permalink, IG is a heavy SPA: at domcontentloaded the article chrome
// (author link, caption, likes) hasn't rendered yet. We wait for the <article> to
// appear, then read each field from MULTIPLE independent signals - the static head
// metadata (og:title, og:image, JSON-LD) and the hydrated DOM - and accept the first
// one that yields a value.
async function fetchPost(page, href, regionLabel) {
  const url = `https://www.instagram.com${href}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    // Wait for the article skeleton; some posts (deleted / private) never render one,
    // but we still want to read og:* from the head so we don't lose the row entirely.
    await page.waitForSelector('article, main', { timeout: 12000 }).catch(() => {});
    await sleep(2200);

    const data = await page.evaluate(() => {
      // Evidence-based extraction (verified against IG's actual HTML via diag-flow.mjs):
      //   og:title       = "<Display Name> on Instagram: \"<caption>\""     (caption lives here)
      //   og:description = "<N> likes, <M> comments - <handle> on <date>: ..."  (handle + likes live here)
      //   og:image       = CDN URL
      //   <article>      = renders post body text including handle and (when present) the
      //                    location label as the line immediately before "Follow"
      //   <script ld+json> = NOT shipped for posts (always 0)
      //   <article> anchors = always 0 in headless - dead-end strategy
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
      const ogDesc  = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
      const ogVideo = document.querySelector('meta[property="og:video"]')?.getAttribute('content')
                   || document.querySelector('meta[property="og:video:secure_url"]')?.getAttribute('content')
                   || document.querySelector('meta[property="og:video:url"]')?.getAttribute('content')
                   || '';

      // Handle: og:description's "- <handle> on <date>" pattern. IG ships this for every
      // public post. Allow digits/underscore/period but reject the "on" sentinel itself.
      let handle = '';
      let handleSource = '';
      let mDesc = ogDesc.match(/(?:likes|comments|views|plays)\s*-\s*([A-Za-z0-9_.]+)\s+on\s+/i);
      if (mDesc) { handle = mDesc[1]; handleSource = 'og:desc'; }
      // Fallback: some private/restricted posts use a slightly different og:desc form.
      // Look for any "@handle" mention before "on Instagram" in og:title (rare).
      if (!handle) {
        const m = ogTitle.match(/\(@([A-Za-z0-9_.]+)\)/);
        if (m) { handle = m[1]; handleSource = 'og:title-paren'; }
      }

      // Caption: og:title after "on Instagram:" (quotes optional, may be straight or curly).
      let caption = '';
      const mCap = ogTitle.match(/on Instagram[^:]*:\s*["“]?([\s\S]+?)["”]?\s*$/i);
      if (mCap) caption = mCap[1].trim();
      else if (ogDesc) {
        // og:desc fallback: text after the final ": "
        const mD = ogDesc.match(/:\s*([\s\S]+?)\s*$/);
        if (mD) caption = mD[1].trim();
      }

      // Image: og:image (always present on valid posts, including Reels - it's the cover frame).
      const image_url = ogImage;
      // Video: og:video for Reels/clips. Falls back to a <video> element source in the article
      // when IG ships the page without og:video (rare). Image posts leave this empty.
      let video_url = ogVideo;
      if (!video_url) {
        const v = document.querySelector('article video, main video');
        if (v) video_url = v.currentSrc || v.src || '';
      }

      // Likes: first number-with-suffix in og:desc (it leads with "<N> likes, <M> comments").
      let likes_label = '';
      const mLikes = ogDesc.match(/^([\d,.KMB]+)\s+likes/i);
      if (mLikes) likes_label = mLikes[1];

      // Verified badge: <svg aria-label="Verified"> anywhere in the article header.
      const verified = !!document.querySelector('article svg[aria-label="Verified"], header svg[aria-label="Verified"]');

      // Location: in article body text, IG renders <handle>\n<location>\nFollow when a place
      // is tagged. Find the line that comes RIGHT BEFORE "Follow" but isn't the handle itself.
      let location_label = '';
      if (handle) {
        const articleText = document.querySelector('article')?.innerText || '';
        const lines = articleText.split('\n').map(s => s.trim()).filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          if (lines[i] === 'Follow' && lines[i - 1] !== handle) {
            // The line BEFORE "Follow" is location only if the line BEFORE THAT is the handle.
            if (i >= 2 && lines[i - 2] === handle) { location_label = lines[i - 1]; break; }
          }
        }
      }

      return {
        handle, caption, image_url, video_url, location_label, verified, likes_label,
        _hasOgImage: !!ogImage,
        _hasOgDesc: !!ogDesc,
        _hasOgVideo: !!ogVideo,
        _handleSource: handleSource,
      };
    });

    // Per-post diagnostic. Surfaces in the server console so we can see exactly which
    // signal each post yielded - critical for debugging when extraction starts missing.
    console.log(`  post ${href}: handle=${data.handle || '(none)'} (from ${data._handleSource || '-'}) img=${data.image_url ? 'yes' : 'no'} vid=${data.video_url ? 'yes' : 'no'} cap=${(data.caption || '').length}ch likes=${data.likes_label || '-'} loc=${data.location_label || '-'}`);

    // Accept the row if we have AT LEAST a handle or an image. A row missing both is
    // unusable; one with just an image is still useful (we'll tag the handle as unknown
    // and the user can clean it up). This used to silently drop everything missing handle.
    if (!data.handle && !data.image_url && !data.video_url) return null;
    const location_label = data.location_label || regionLabel || '';
    // Caption is REQUIRED by the Wondavu contract. When IG strips og:title (rare), fall back
    // to the location label so the importer never receives an empty caption.
    let caption = (data.caption || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!caption) caption = location_label;
    return {
      handle: data.handle || '',
      caption,
      image_url: data.image_url || '',
      video_url: data.video_url || '',
      location_label,
      ig_post_url: url,
      // Contract: defaults to "0" if empty. Stamping here keeps the importer's logic simpler
      // and avoids any ambiguity about who provides the default.
      likes_label: data.likes_label || '0',
      verified: data.verified ? 'true' : 'false',
    };
  } catch (e) {
    console.log(`  post ${href}: error ${e.message}`);
    return null;
  }
}

// Main entry. tags: array of bare hashtag names; want: target post count; regionLabel: stamped
// into location_label when IG doesn't expose a location for the post.
// onProgress(ev) is called with {phase, ...} events for live UI updates:
//   {phase:'discover', tag, found}
//   {phase:'fetch', i, total, name, ok, csvSoFar}
// opts.shouldPause: async () => boolean — blocks between posts when paused.
// opts.minLikes: when > 0, only KEEP posts whose parsed likes meet/exceed this threshold.
//   We over-scan discovery and cap total fetch attempts so a low-engagement hashtag can't loop forever.
export async function enrichHashtag(tags, want, regionLabel, onProgress, opts = {}) {
  const shouldPause = opts.shouldPause || (async () => false);
  const minLikes = Math.max(0, parseInt(opts.minLikes, 10) || 0);
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

  // Phase 1: discover post URLs across all tags. Overscan multiplier scales with the likes
  // filter - a 1000-likes threshold typically rejects 60-80% of recent hashtag posts, so we
  // need to queue 3-5x more URLs than the target to hit it.
  const target = Math.max(1, parseInt(want, 10) || 100);
  const overscanMult = minLikes >= 1000 ? 5 : minLikes > 0 ? 3 : 2;
  const overscan = Math.min(target * overscanMult, target + 200);
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

  let rejectedLowLikes = 0;
  for (let i = 0; i < hrefList.length && rows.length < target; i++) {
    const href = hrefList[i];
    const row = await fetchPost(page, href, regionLabel);
    let kept = false;
    let rejectReason = '';
    if (row) {
      if (minLikes > 0) {
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
      rejected: rejectedLowLikes,
      csvSoFar: maybeSnap(),
    });
    await shouldPause();
    await sleep(4500 + Math.floor(Math.random() * 2500));
  }

  await browser.close();
  return { csv: toCSV(rows), kept: rows.length, attempted: hrefList.length, rejectedLowLikes, target };
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
