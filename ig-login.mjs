// One-time Instagram login helper.
// Opens a REAL Chrome window using a dedicated profile folder (./.ig-session).
// You log in manually (the script never sees your password); the session cookies
// are saved in that folder and reused by scrape-igposts.mjs.
//
// Run:  node ig-login.mjs
// Use a SECONDARY / burner Instagram account - automated access can get accounts flagged.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found.'); process.exit(1); }

const userDataDir = fileURLToPath(new URL('./.ig-session', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,                 // visible window so you can log in
  userDataDir,                     // session persists here for the scraper to reuse
  defaultViewport: null,
  args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US', '--start-maximized'],
});
const page = (await browser.pages())[0] || await browser.newPage();
await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });

console.log('\n=== Instagram login ===');
console.log('1) Log in to your (secondary) Instagram account in the window that opened.');
console.log('2) Once you see your feed, this will detect it and save the session automatically.');
console.log('   (You can also just close the window when done.)\n');

// Wait until logged in (sessionid cookie appears), then save & close.
let loggedIn = false;
for (let i = 0; i < 200; i++) {            // up to ~10 min
  try {
    const cookies = await page.cookies('https://www.instagram.com');
    if (cookies.some(c => c.name === 'sessionid' && c.value)) { loggedIn = true; break; }
  } catch { break; } // window closed
  await sleep(3000);
}
if (loggedIn) {
  await sleep(2000);
  console.log('✓ Logged in - session saved. You can now run: node scrape-igposts.mjs <file.csv>');
}
try { await browser.close(); } catch {}
