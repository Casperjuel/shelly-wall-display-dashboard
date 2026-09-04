#!/usr/bin/env node
/**
 * Resilience tests — the failure modes a wall panel meets over months.
 *
 * These are the ones that matter and that nobody reproduces by hand: Home
 * Assistant restarting overnight, an access point rebooting, a bulb dropping
 * off the mesh, a token being revoked. Each is injected into the mock and the
 * panel's recovery is asserted on.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:8125';
const CFG = JSON.parse(readFileSync(new URL('../public/rooms.json', import.meta.url), 'utf8'));
const ROOM = CFG.rooms.find((r) => r.display === 'wd').slug;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${x ? '  ' + x : ''}`); };
const inject = (p) => fetch(BASE + p).then((r) => r.json()).catch(() => null);

const br = await chromium.launch({ channel: 'chrome' });
const page = await br.newPage({ viewport: { width: 480, height: 480 }, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const connState = () => page.evaluate(() => window.hjem?.conn?.state ?? 'none');
const waitFor = async (want, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await connState() === want) return Date.now() - t0;
    await page.waitForTimeout(250);
  }
  return -1;
};

await inject('/__auth?ok=true');
await inject('/__deaf?on=false');
await page.goto(`${BASE}/index.html?room=${ROOM}&token=mock-token&ha=${encodeURIComponent(BASE)}`);
await page.waitForFunction(() => window.hjem?.conn?.state === 'ready', null, { timeout: 15000 });
await page.waitForTimeout(600);

// ── 1. Home Assistant restarts ─────────────────────────────────────────────
console.log('\nHome Assistant restarts');
const before = await page.evaluate(() => document.querySelectorAll('*').length);
await inject('/__kill');
await page.waitForTimeout(500);
const dropped = await connState();
ok('notices the connection dropped', dropped !== 'ready', `state: ${dropped}`);
const backMs = await waitFor('ready', 30000);
ok('reconnects on its own', backMs >= 0, backMs >= 0 ? `${(backMs / 1000).toFixed(1)}s` : 'never');
const after = await page.evaluate(() => document.querySelectorAll('*').length);
ok('does not rebuild the DOM on reconnect', before === after, `${before} → ${after}`);
ok('state is live again after reconnect', await page.evaluate(async () => {
  const e = window.hjem.ctx.cfg.rooms.find((r) => r.slug === document.documentElement.dataset.room).lights[0].entity;
  const was = window.hjem.store.isOn(e);
  window.hjem.actions.toggleLight(e);
  await new Promise((r) => setTimeout(r, 2500));
  return window.hjem.store.isOn(e) !== was;
}), 'a tap still reaches HA');

// ── 2. Wi-Fi drops (half-open socket) ──────────────────────────────────────
console.log('\nWi-Fi drops — socket open but silent');
await inject('/__deaf?on=true');
const deafDetect = await waitFor('lost', 90000);
ok('detects a half-open socket via heartbeat', deafDetect >= 0,
   deafDetect >= 0 ? `${(deafDetect / 1000).toFixed(0)}s` : 'never — it hangs forever');
// The important case: a user taps while the link is silently dead. The panel
// should work that out from the unanswered tap, not from the heartbeat.
await inject('/__deaf?on=true');
await waitFor('ready', 40000).catch(() => {});
await inject('/__deaf?on=false');
await waitFor('ready', 20000);
await inject('/__deaf?on=true');
await page.waitForTimeout(500);
const t0 = Date.now();
await page.evaluate(() => {
  const e = window.hjem.ctx.cfg.rooms.find((r) => r.slug === document.documentElement.dataset.room).lights[0].entity;
  window.hjem.actions.toggleLight(e);
});
const noticed = await waitFor('lost', 20000);
ok('a tap that goes unanswered exposes the dead link fast', noticed >= 0 && noticed < 12000,
   noticed >= 0 ? `${((Date.now() - t0) / 1000).toFixed(1)}s after the tap` : 'never');

await inject('/__deaf?on=false');
const deafBack = await waitFor('ready', 40000);
ok('recovers when the network returns', deafBack >= 0,
   deafBack >= 0 ? `${(deafBack / 1000).toFixed(1)}s` : 'never');

// ── 3. A device drops off the mesh ─────────────────────────────────────────
console.log('\nA bulb goes unavailable');
const light = await page.evaluate(() =>
  window.hjem.ctx.cfg.rooms.find((r) => r.slug === document.documentElement.dataset.room).lights[0].entity);
await page.locator(`[data-key="${ROOM}.tab.lys"]`).tap();
await page.waitForTimeout(300);
await inject(`/__unavailable?e=${light}&on=true`);
await page.waitForTimeout(1200);
const un = await page.evaluate(() => {
  const t = document.querySelector('.light-tile');
  return { cls: t?.className, sub: t?.querySelector('.light-sub')?.textContent };
});
ok('the tile shows it as unavailable', /unavailable/.test(un.cls ?? ''), un.sub ?? '');
ok('and says so in Danish', un.sub === 'utilgængelig', un.sub ?? '');
await inject(`/__unavailable?e=${light}&on=false`);
await page.waitForTimeout(1200);
ok('recovers when the device returns',
   !/unavailable/.test(await page.evaluate(() => document.querySelector('.light-tile')?.className ?? '')));

// ── 4. Token revoked ───────────────────────────────────────────────────────
console.log('\nToken revoked');
await inject('/__auth?ok=false');
await inject('/__kill');
await page.waitForTimeout(4000);
const authState = await connState();
const veil = await page.evaluate(() => document.body.classList.contains('offline'));
ok('stops retrying a credential that will never work', authState === 'lost', `state: ${authState}`);
ok('tells the user rather than sitting blank', veil, veil ? 'offline veil shown' : 'no veil');
const retries = await page.evaluate(() => window.__authAttempts ?? 'not counted');
console.log(`     (auth attempts: ${retries})`);

await inject('/__auth?ok=true');
ok('no uncaught JS errors throughout', errs.length === 0, errs[0]?.slice(0, 90) ?? '');

await br.close();
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
