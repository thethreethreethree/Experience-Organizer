// Falsification probe: does the issue follow the .ig-session profile, or is it
// inherent to Puppeteer hitting IG from here?
//
// Compares THREE configurations against the same post URL:
//   A) Puppeteer with .ig-session       (current scraper config)
//   B) Puppeteer with a FRESH profile   (no saved cookies)
//   C) Plain Node fetch                 (no Chrome at all - baseline)
//
// Output identifies which axis is failing so we can fix the right thing.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync);
const savedSession = fileURLToPath(new URL('./.ig-session', import.meta.url));
const POST = 'https://www.instagram.com/p/DJj90ywtQbE/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function probe(label, opts) {
  console.log(`\n===== ${label} =====`);
  let b;
  try {
    b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--lang=en-US'], ...opts });
    const page = (await b.pages())[0] || await b.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    const resp = await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => ({ _err: e.message }));
    await sleep(1500);
    const url = page.url();
    const status = resp && resp.status ? resp.status() : '(no response object)';
    const ogImage = await page.evaluate(() => document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '').catch(() => '');
    const ogDesc = await page.evaluate(() => document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '').catch(() => '');
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 200)).catch(() => '');
    const title = await page.title().catch(() => '');
    console.log(`status=${status}`);
    console.log(`landed=${url}`);
    console.log(`title=${title}`);
    console.log(`og:image=${ogImage ? 'YES' : 'no'}`);
    console.log(`og:desc=${ogDesc ? 'YES (' + ogDesc.slice(0, 80) + '...)' : 'no'}`);
    console.log(`body=${JSON.stringify(bodyText.slice(0, 120))}`);
    if (resp && resp._err) console.log(`navigation error: ${resp._err}`);
  } catch (e) {
    console.log(`probe failed: ${e.message}`);
  } finally {
    if (b) try { await b.close(); } catch {}
  }
}

console.log(`POST URL: ${POST}`);
console.log(`Chrome  : ${CHROME}`);

// A: scraper's actual config
await probe('A — .ig-session profile (current scraper)', { userDataDir: savedSession });

// B: fresh disposable profile
const tmp = mkdtempSync(join(tmpdir(), 'igdiag-'));
await probe('B — FRESH profile (no saved cookies)', { userDataDir: tmp });
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

// C: plain fetch (no Chrome at all)
console.log('\n===== C — plain Node fetch =====');
try {
  const res = await fetch(POST, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  const text = await res.text();
  console.log(`status=${res.status}`);
  console.log(`bytes=${text.length}`);
  const og = (text.match(/<meta property="og:image"[^>]*content="([^"]+)"/) || [])[1] || '';
  const ogd = (text.match(/<meta property="og:description"[^>]*content="([^"]+)"/) || [])[1] || '';
  console.log(`og:image=${og ? 'YES' : 'no'}`);
  console.log(`og:desc=${ogd ? 'YES (' + ogd.slice(0, 80) + '...)' : 'no'}`);
} catch (e) {
  console.log(`fetch failed: ${e.message}`);
}
console.log('\nDone.');
