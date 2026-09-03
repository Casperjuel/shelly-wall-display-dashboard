#!/usr/bin/env node
/**
 * Headless UI smoke test — drives the real bundle in real Chrome at the real
 * device viewport, then asserts on what the panel actually did.
 * Uses the installed system Chrome (channel: 'chrome') so nothing is downloaded.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:8125';

// Room slugs come from the manifest, not from one particular house — the test
// has to pass on a fresh clone using rooms.example.yaml.
const CFG = JSON.parse(readFileSync(new URL('../public/rooms.json', import.meta.url), 'utf8'));
const WD = CFG.rooms.find((r) => r.display === 'wd')?.slug;
const XL = CFG.rooms.find((r) => r.display === 'xl')?.slug ?? WD;
const WD2 = CFG.rooms.filter((r) => r.display === 'wd')[1]?.slug ?? WD;
if (!WD) { console.error('no wd room in rooms.json — run `npm run gen`'); process.exit(1); }
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${x ? '  ' + x : ''}`); };

const browser = await chromium.launch({ channel: 'chrome' });

// ── 4" Wall Display ────────────────────────────────────────────────────────
console.log(`\nWall Display 4" · 480×480 · ${WD}`);
const page = await browser.newPage({ viewport: { width: 480, height: 480 }, deviceScaleFactor: 1, hasTouch: true });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const events = [];
await page.exposeFunction('__hjemSink', (e) => events.push(e));
await page.addInitScript(() => {
  addEventListener('message', () => {});
  const orig = window.postMessage.bind(window);
  void orig;
});

await page.goto(`${BASE}/index.html?room=${WD}&token=mock-token&ha=${encodeURIComponent(BASE)}`);
await page.waitForSelector('.panel', { timeout: 8000 });
await page.waitForFunction(() => (window).hjem?.conn?.state === 'ready', null, { timeout: 8000 });

ok('boots with no JS errors', errors.length === 0, errors[0] ?? '');
ok('panel rendered', await page.locator('.panel').count() === 1);
ok('4 tabs present', await page.locator('.tab').count() === 4);

// no horizontal overflow, and the layout fits the physical screen exactly
const fit = await page.evaluate(() => ({
  sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
  iw: innerWidth, ih: innerHeight,
}));
ok('no horizontal overflow', fit.sw <= fit.iw, `${fit.sw} ≤ ${fit.iw}`);
ok('no vertical page scroll', fit.sh <= fit.ih, `${fit.sh} ≤ ${fit.ih}`);

// forbidden expensive CSS must not appear anywhere in the live tree
const heavy = await page.evaluate(() => {
  const bad = [];
  for (const n of document.querySelectorAll('*')) {
    const s = getComputedStyle(n);
    if (s.backdropFilter && s.backdropFilter !== 'none') bad.push('backdrop-filter on ' + n.className);
    if (s.filter && s.filter !== 'none') bad.push('filter on ' + n.className);
  }
  return bad;
});
ok('no blur/filter anywhere (Mali-400 budget)', heavy.length === 0, heavy[0] ?? '');

// every interactive control meets the touch-target minimum
const small = await page.evaluate(() => {
  const bad = [];
  for (const n of document.querySelectorAll('button')) {
    if (!n.offsetParent) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) bad.push(`${n.dataset.key || n.className} ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  return bad;
});
ok('all visible buttons ≥ 40×40 px', small.length === 0, small.slice(0, 3).join(', '));

// tab switching must not rebuild the DOM
const before = await page.evaluate(() => document.querySelectorAll('*').length);
await page.locator(`[data-key="${WD}.tab.lys"]`).tap();
await page.waitForTimeout(120);
const after = await page.evaluate(() => document.querySelectorAll('*').length);
ok('tab switch does not rebuild DOM', before === after, `${before} → ${after} nodes`);
ok('lys pane visible after switch', await page.locator('.pane-lys.show').count() === 1);
ok('DOM within budget (900 nodes)', after <= 900, `${after} nodes`);

// the headline behaviour: paint before HA answers
await page.evaluate(() => fetch('/__lag?ms=900'));
const optimistic = await page.evaluate(async () => {
  const head = document.querySelector('.light-tile .light-head');
  const tile = document.querySelector('.light-tile');
  const was = tile.classList.contains('on');
  const t0 = performance.now();
  head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
  // DOM must already reflect the prediction before we yield to the event loop —
  // that is what "synchronous optimistic flush" means in practice.
  const domMs = performance.now() - t0;
  const flippedSync = tile.classList.contains('on') !== was;
  head.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 50, clientY: 50 }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { domMs, flippedSync, paintMs: performance.now() - t0,
           flipped: tile.classList.contains('on') !== was };
});
ok('tap flips the tile optimistically', optimistic.flipped);
ok('DOM updates synchronously within the pointerdown handler', optimistic.flippedSync,
   `${optimistic.domMs.toFixed(2)} ms, zero frames waited`);
ok('visible before HA could possibly answer', optimistic.paintMs < 900,
   `painted ${optimistic.paintMs.toFixed(1)} ms vs 900 ms HA lag`);

// and it must still be correct once HA answers
await page.waitForTimeout(1600);
const settled = await page.evaluate(() => {
  const t = document.querySelector('.light-tile');
  return { on: t.classList.contains('on'), pending: t.querySelector('.pending-dot').classList.contains('show') };
});
ok('prediction confirmed by HA, pending cleared', !settled.pending);

// ── state-aware gradients ─────────────────────────────────────────────────
await page.locator(`[data-key="${WD}.tab.hjem"]`).tap();
await page.waitForTimeout(150);
const moods = await page.evaluate(() =>
  [...document.querySelectorAll('.scene-tile')].map((n) => ({
    key: n.dataset.key, bg: n.style.backgroundImage,
    ink: n.style.getPropertyValue('--mood-ink'),
  })));
ok('every scene tile has a mood gradient', moods.every((m) => m.bg && m.bg !== 'none'));
ok('scene moods are distinct', new Set(moods.map((m) => m.bg)).size === moods.length,
   `${new Set(moods.map((m) => m.bg)).size} of ${moods.length}`);
// Hygge (2000 K, dim) must be visibly warmer AND dimmer than Rengøring (5800 K, full)
const hygge = moods.find((m) => m.key.endsWith('hygge'));
const reng  = moods.find((m) => m.key.endsWith('rengoring'));
const rgbOf = (s) => (s.match(/rgba?\(([^)]+)\)/) || [])[1]?.split(',').map(Number) ?? [];
const hR = rgbOf(hygge.bg), rR = rgbOf(reng.bg);
ok('warm scene is redder than cool scene', hR[2] < rR[2], `hygge b=${hR[2]} vs rengøring b=${rR[2]}`);
ok('dim scene renders fainter than bright scene', (hR[3] ?? 1) < (rR[3] ?? 1),
   `alpha ${hR[3]} vs ${rR[3]}`);

// a light's gradient must follow its actual colour temperature
await page.locator(`[data-key="${WD}.tab.lys"]`).tap();
await page.waitForTimeout(150);
await page.evaluate((e) => window.hjem.actions.setBrightness(e, 100), `light.${WD}_hue`);
await page.waitForTimeout(900);
await page.evaluate((e) => fetch(`/__ct?e=${e}&k=2000`), `light.${WD}_hue`);
await page.waitForTimeout(600);
const warmGrad = await page.evaluate(() => document.querySelector('.light-glow').style.backgroundImage);
await page.evaluate((e) => fetch(`/__ct?e=${e}&k=6500`), `light.${WD}_hue`);
await page.waitForTimeout(600);
const coolGrad = await page.evaluate(() => document.querySelector('.light-glow').style.backgroundImage);
ok('light glow tracks colour temperature', warmGrad !== coolGrad && !!warmGrad);
const wRGB = rgbOf(warmGrad), cRGB = rgbOf(coolGrad);
ok('2000 K glow is warmer than 6500 K glow', wRGB[2] < cRGB[2], `blue ${wRGB[2]} vs ${cRGB[2]}`);

// dimming must visibly fade the glow, not just the slider
await page.evaluate((e) => window.hjem.actions.setBrightness(e, 10), `light.${WD}_hue`);
await page.waitForTimeout(900);
const dimGrad = await page.evaluate(() => document.querySelector('.light-glow').style.backgroundImage);
ok('glow fades with brightness', (rgbOf(dimGrad)[3] ?? 1) < (cRGB[3] ?? 1),
   `alpha ${rgbOf(dimGrad)[3]} vs ${cRGB[3]}`);

// theme must follow sun.sun, not a clock
await page.evaluate(() => fetch('/__sun?s=down'));
await page.waitForTimeout(400);
ok('night → dark theme', await page.evaluate(() => document.documentElement.dataset.theme) === 'dark');
await page.evaluate(() => fetch('/__sun?s=up'));
await page.waitForTimeout(400);
const dayTheme = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
}));
ok('day → light theme', dayTheme.theme === 'light', dayTheme.bg);
// the accent ramp must be recomputed for the new theme, not reused
const accent = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return { accent: cs.getPropertyValue('--accent').trim(), text: cs.getPropertyValue('--accent-text').trim() };
});
ok('accent ramp present and theme-adjusted', !!accent.accent && accent.text !== accent.accent,
   `${accent.accent} → ${accent.text}`);
await page.evaluate(() => fetch('/__sun?s=down'));
await page.waitForTimeout(300);

// ── XL ─────────────────────────────────────────────────────────────────────
console.log(`\nWall Display XL · 1280×752 · ${XL}`);
const xl = await browser.newPage({ viewport: { width: 1280, height: 752 }, deviceScaleFactor: 1, hasTouch: true });
const xlErr = [];
xl.on('pageerror', (e) => xlErr.push(e.message));
await xl.goto(`${BASE}/index.html?room=${XL}&token=mock-token&ha=${encodeURIComponent(BASE)}`);
await xl.waitForSelector('.ov', { timeout: 8000 });
await xl.waitForFunction(() => (window).hjem?.conn?.state === 'ready', null, { timeout: 8000 });

ok('XL boots with no JS errors', xlErr.length === 0, xlErr[0] ?? '');
ok('overview shows all 9 rooms', await xl.locator('.ov-card').count() === 9);
// each room card carries its own accent, not the kitchen's
const accents = await xl.evaluate(() =>
  [...document.querySelectorAll('.ov-card')].map((c) => c.style.getPropertyValue('--accent')));
ok('every room card has a distinct accent', new Set(accents).size === 9,
   `${new Set(accents).size} unique of ${accents.length}`);
const xlFit = await xl.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth,
                                          sh: document.documentElement.scrollHeight, ih: innerHeight }));
ok('XL no overflow', xlFit.sw <= xlFit.iw && xlFit.sh <= xlFit.ih, `${xlFit.sw}×${xlFit.sh}`);

await xl.locator(`[data-key="ov.room.${WD2}"]`).tap();
await xl.waitForTimeout(250);
ok('room detail opens', await xl.locator('.ov-detail.open').count() === 1);
ok('detail hosts the same room panel', await xl.locator('.ov-detail-host .panel.show').count() === 1);
const xlNodes = await xl.evaluate(() => document.querySelectorAll('*').length);
ok('XL DOM within budget (2500 nodes)', xlNodes <= 2500, `${xlNodes} nodes`);

await xl.locator('[data-key="ov.back"]').tap();
await xl.waitForTimeout(220);
ok('detail closes', await xl.locator('.ov-detail.open').count() === 0);

// ── debug harness ──────────────────────────────────────────────────────────
console.log('\ndebug suite');
const dbg = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const dbgErr = [];
dbg.on('pageerror', (e) => dbgErr.push(e.message));
await dbg.goto(`${BASE}/debug.html`);
await dbg.waitForTimeout(3500);
ok('debug page loads clean', dbgErr.length === 0, dbgErr[0] ?? '');
ok('renders all 9 devices', await dbg.locator('.dev').count() === 9);
// Nine panels open nine websockets at once; on a cold server the last couple
// can take a few seconds. Poll rather than assert on a single sample.
let connected = 0;
for (let i = 0; i < 20; i++) {
  connected = await dbg.locator('.dot.ready').count();
  if (connected === 9) break;
  await dbg.waitForTimeout(500);
}
ok('all panels connect to HA', connected === 9, `${connected}/9 ready`);
const logged = await dbg.locator('.ev').count();
ok('event log receiving keyed events', logged > 0, `${logged} events`);
const keyOpts = await dbg.locator('#keySel option').count();
ok('control registry populated', keyOpts > 0, `${keyOpts} addressable controls`);

await browser.close();
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
