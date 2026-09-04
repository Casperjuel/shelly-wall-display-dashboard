#!/usr/bin/env node
/**
 * Screenshot every panel state worth looking at, into docs/shots/.
 * Requires the mock to be running:  npm run mock
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'shots');
mkdirSync(OUT, { recursive: true });

const B = process.argv[2] ?? 'http://localhost:8125';
const br = await chromium.launch({ channel: 'chrome' });

async function shot({ room, size = [480, 480], theme = 'dark', tab, prep, name }) {
  const p = await br.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2, hasTouch: true });
  await p.goto(`${B}/index.html?room=${room}&token=mock-token&ha=${encodeURIComponent(B)}&theme=${theme}`);
  await p.waitForFunction(() => window.hjem?.conn?.state === 'ready', null, { timeout: 10000 });
  if (tab) { await p.locator(`[data-key="${room}.tab.${tab}"]`).tap(); await p.waitForTimeout(200); }
  if (prep) { await p.evaluate(prep); await p.waitForTimeout(1400); }
  await p.waitForTimeout(450);
  await p.screenshot({ path: join(OUT, name + '.png') });
  await p.close();
  console.log('  ' + name);
}

const litRoom = (slug) => `() => { const a = window.hjem.actions;
  a.setBrightness('light.${slug}_hue', 85); a.setBrightness('light.${slug}_lampeudtag', 40); }`;

console.log('capturing →', OUT);
await shot({ room: 'tv_stue', name: 'wd-hjem-dark',  prep: eval(litRoom('tv_stue')) });
await shot({ room: 'tv_stue', name: 'wd-lys-dark',   tab: 'lys', prep: eval(litRoom('tv_stue')) });
await shot({ room: 'tv_stue', name: 'wd-varme-dark', tab: 'varme' });
await shot({ room: 'tv_stue', name: 'wd-musik-dark', tab: 'musik',
             prep: () => window.hjem.actions.playPause('media_player.tv_stue') });
await shot({ room: 'kontor', theme: 'light', name: 'wd-hjem-light', prep: eval(litRoom('kontor')) });
await shot({ room: 'kontor', theme: 'light', name: 'wd-lys-light', tab: 'lys', prep: eval(litRoom('kontor')) });
await shot({ room: 'kokken', size: [1280, 752], name: 'xl-dark' });
await shot({ room: 'kokken', size: [1280, 752], theme: 'light', name: 'xl-light' });

const d = await br.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1.5 });
await d.goto(`${B}/debug.html`);
await d.waitForTimeout(3000);
await d.evaluate(() => { const z = document.getElementById('zoom'); z.value = 62; z.dispatchEvent(new Event('input')); });
await d.waitForTimeout(500);
await d.evaluate(() => document.getElementById('smoke').click());
await d.waitForTimeout(6500);
await d.screenshot({ path: join(OUT, 'debug-suite.png') });
console.log('  debug-suite');
await br.close();
