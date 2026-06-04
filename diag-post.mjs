// One-off: open a single IG post URL with the saved login session and dump
// EVERYTHING our extractor cares about - so we stop guessing at IG's structure.
// Usage: node diag-post.mjs [postUrl-or-/p/code/]   (default: a known elnido post)

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

const raw = process.argv[2] || '/p/Dl9OkGmzTx1/';
const url = raw.startsWith('http') ? raw : `https://www.instagram.com${raw.startsWith('/') ? '' : '/'}${raw}`;

console.log(`Diagnostic: ${url}`);
console.log(`userDataDir: ${userDataDir}, exists=${existsSync(userDataDir)}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir,
  args: ['--no-sandbox', '--lang=en-US'],
});
const page = (await browser.pages())[0] || await browser.newPage();
await page.setViewport({ width: 1280, height: 1100 });

// Warm-up: load IG home so the session cookies attach normally.
await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 40000 });
await sleep(2000);
const cookies = await page.cookies('https://www.instagram.com');
const loggedIn = cookies.some(c => c.name === 'sessionid' && c.value);
console.log(`logged in: ${loggedIn}`);

await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
await page.waitForSelector('article, main', { timeout: 15000 }).catch(() => console.log('!! article/main never appeared'));
await sleep(2500);

const dump = await page.evaluate(() => {
  const og = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content') || '';
  const ogTitle = og('og:title');
  const ogDesc = og('og:description');
  const ogImage = og('og:image');
  const ogUrl = og('og:url');
  // JSON-LD blobs
  const ldBlobs = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    ldBlobs.push((s.textContent || '').slice(0, 800));
  }
  // Article anchors and their hrefs
  const article = document.querySelector('article');
  const articleAnchors = article
    ? [...article.querySelectorAll('a[href]')].slice(0, 30).map(a => ({ href: a.getAttribute('href'), text: (a.innerText || '').slice(0, 40) }))
    : null;
  // All header (incl. navbar) anchors for comparison
  const headerAnchors = [...document.querySelectorAll('header a[href]')].slice(0, 30).map(a => ({ href: a.getAttribute('href'), text: (a.innerText || '').slice(0, 40) }));
  // Article text snapshot
  const articleText = article ? article.innerText.slice(0, 600) : '(no article)';
  // Title tag
  const docTitle = document.title;
  return { docTitle, ogTitle, ogDesc, ogImage, ogUrl, ldCount: ldBlobs.length, ldBlobs, articleAnchorsCount: articleAnchors?.length ?? -1, articleAnchors, headerAnchors, articleText };
});

console.log('\n===== HEAD =====');
console.log('title       :', dump.docTitle);
console.log('og:title    :', JSON.stringify(dump.ogTitle));
console.log('og:desc     :', JSON.stringify(dump.ogDesc));
console.log('og:url      :', dump.ogUrl);
console.log('og:image    :', dump.ogImage ? dump.ogImage.slice(0, 100) + '...' : '(none)');
console.log('JSON-LD blobs:', dump.ldCount);
dump.ldBlobs.forEach((b, i) => console.log(`  [${i}] ${b.slice(0, 300)}${b.length > 300 ? ' ...' : ''}`));

console.log('\n===== ARTICLE =====');
console.log('anchor count:', dump.articleAnchorsCount);
if (dump.articleAnchors) {
  dump.articleAnchors.slice(0, 15).forEach((a, i) => console.log(`  [${i}] href=${a.href}  text=${JSON.stringify(a.text)}`));
}
console.log('article text (first 600 chars):');
console.log(dump.articleText);

console.log('\n===== HEADER (navbar) =====');
dump.headerAnchors.slice(0, 10).forEach((a, i) => console.log(`  [${i}] href=${a.href}  text=${JSON.stringify(a.text)}`));

await browser.close();
console.log('\nDone.');
