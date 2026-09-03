#!/usr/bin/env node
/**
 * Sped-up simulation of the children's sleep clock.
 *
 * Sweeps the panel's clock from evening through sunrise and captures a frame
 * per simulated step, then stitches them into a video. A 90-minute sunrise
 * compressed into a few seconds, so the whole transition can be judged at once
 * rather than by waiting up for it.
 *
 *   node tools/wake-sim.mjs [room] [server]
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const ROOM = process.argv[2] ?? 'barn_1';
const B = process.argv[3] ?? 'http://localhost:8125';
const OUT = '/tmp/wakesim';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// evening → night → the full 90-minute dawn → morning
const steps = [];
const push = (h, m) => steps.push([h, m]);
// Evening and the middle of the night are sampled sparsely — nothing happens
// but the moon creeping across. The 90-minute sunrise gets a frame every
// minute, because that is the part worth watching.
push(19, 45); push(20, 30); push(21, 30); push(22, 30);
push(23, 30); push(0, 30); push(1, 30); push(2, 30); push(3, 30); push(4, 30); push(5, 0);
for (let t = 5 * 60 + 30; t <= 7 * 60; t += 1) push(Math.floor(t / 60) % 24, t % 60);
for (let t = 7 * 60 + 2; t <= 8 * 60 + 20; t += 4) push(Math.floor(t / 60) % 24, t % 60);

const br = await chromium.launch({ channel: 'chrome' });
const page = await br.newPage({ viewport: { width: 480, height: 480 }, deviceScaleFactor: 2, hasTouch: true });

// A mutable fake clock the harness can step.
await page.addInitScript(() => {
  const Real = Date;
  let fixed = new Real();
  window.__setNow = (h, m) => { const d = new Real(); d.setHours(h, m, 0, 0); fixed = d; };
  window.Date = class extends Real {
    constructor(...a) { if (!a.length) return new Real(fixed.getTime()); return new Real(...a); }
    static now() { return fixed.getTime(); }
  };
});

await page.goto(`${B}/index.html?room=${ROOM}&token=mock-token&ha=${encodeURIComponent(B)}&theme=dark`);
await page.waitForFunction(() => window.hjem?.conn?.state === 'ready', null, { timeout: 12000 });
await page.waitForTimeout(1200);

console.log(`simulating ${steps.length} steps…`);
let n = 0;
for (const [h, m] of steps) {
  await page.evaluate(([h, m]) => {
    window.__setNow(h, m);
    window.hjem?.wake?.update?.();
  }, [h, m]);
  // let the CSS transitions settle a little without waiting the full 4 s
  await page.waitForTimeout(320);
  await page.screenshot({ path: `${OUT}/f${String(n).padStart(4, '0')}.png` });
  n++;
}
await br.close();
console.log(`captured ${n} frames`);

const FPS = process.env.SIM_FPS ?? '14';
execFileSync('ffmpeg', ['-y', '-framerate', FPS, '-i', `${OUT}/f%04d.png`,
  '-vf', 'scale=480:-1:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '/tmp/wake-sim.mp4'], { stdio: 'ignore' });
execFileSync('ffmpeg', ['-y', '-i', '/tmp/wake-sim.mp4',
  '-vf', `fps=${FPS},scale=400:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
  '-loop', '0', '/tmp/wake-sim.gif'], { stdio: 'ignore' });
console.log('→ /tmp/wake-sim.mp4  and  /tmp/wake-sim.gif');
