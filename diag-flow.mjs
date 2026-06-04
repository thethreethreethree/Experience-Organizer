// End-to-end diagnostic: load #elnido grid, pick the first 3 fresh post URLs,
// open each one and report what IG actually serves. Mirrors the real scrape flow
// so what we see here matches what the scrape sees.

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

const HEADLESS = process.argv.includes('--show') ? false : true;
console.log(`Launching Chrome (headless=${HEADLESS})…`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  userDataDir,
  defaultViewport: HEADLESS ? null : null,
  args: ['--no-sandbox', '--lang=en-US', ...(HEADLESS ? [] : ['--start-maximized'])],
});
const page = (await browser.pages())[0] || await browser.newPage();
await page.setViewport({ width: 1280, height: 1100 });

await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 40000 });
await sleep(2500);
const cookies = await page.cookies('https://www.instagram.com');
console.log(`logged in: ${cookies.some(c => c.name === 'sessionid' && c.value)}`);

// Step 1: hashtag grid - confirm it renders and pick fresh shortcodes.
await page.goto('https://www.instagram.com/explore/tags/elnido/', { waitUntil: 'networkidle2', timeout: 45000 });
await sleep(3500);
const gridInfo = await page.evaluate(() => {
  const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
  const codes = [];
  const seen = new Set();
  for (const a of links) {
    const m = (a.getAttribute('href') || '').match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (m && !seen.has(m[2])) { seen.add(m[2]); codes.push(`/${m[1]}/${m[2]}/`); }
    if (codes.length >= 3) break;
  }
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
  return { gridUrl: location.href, linkCount: links.length, codes, ogImage, title: document.title, bodyChars: document.body.innerText.length };
});
console.log('\n===== GRID =====');
console.log('url       :', gridInfo.gridUrl);
console.log('title     :', gridInfo.title);
console.log('a[/p/]    :', gridInfo.linkCount);
console.log('og:image  :', gridInfo.ogImage ? gridInfo.ogImage.slice(0, 80) + '...' : '(none)');
console.log('first 3   :', gridInfo.codes);
console.log('body chars:', gridInfo.bodyChars);

// Step 2: visit each fresh shortcode and report.
for (const href of gridInfo.codes) {
  const url = `https://www.instagram.com${href}`;
  console.log(`\n===== POST ${href} =====`);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('article, main', { timeout: 10000 }).catch(() => {});
    await sleep(2500);
    const info = await page.evaluate(() => {
      const og = p => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content') || '';
      const article = document.querySelector('article');
      const anchors = article ? [...article.querySelectorAll('a[href]')].slice(0, 12).map(a => a.getAttribute('href')) : [];
      return {
        url: location.href,
        title: document.title,
        ogTitle: og('og:title'),
        ogDesc: og('og:description'),
        ogImage: og('og:image'),
        ldCount: document.querySelectorAll('script[type="application/ld+json"]').length,
        bodyChars: document.body.innerText.length,
        articleAnchors: anchors,
        bodySnippet: document.body.innerText.slice(0, 300),
      };
    });
    console.log('current url:', info.url);
    console.log('title      :', info.title);
    console.log('og:title   :', JSON.stringify(info.ogTitle));
    console.log('og:desc    :', JSON.stringify(info.ogDesc).slice(0, 200));
    console.log('og:image   :', info.ogImage ? info.ogImage.slice(0, 80) + '...' : '(none)');
    console.log('ld+json    :', info.ldCount);
    console.log('body chars :', info.bodyChars);
    console.log('article a  :', info.articleAnchors);
    console.log('body snip  :', JSON.stringify(info.bodySnippet));
  } catch (e) {
    console.log('!! error:', e.message);
  }
  await sleep(3000);
}

await browser.close();
console.log('\nDone.');
