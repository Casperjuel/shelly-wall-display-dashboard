#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/** ES2019 + no legacy-browser polyfills. Android 11 WebView is Chromium 8x–13x
 *  depending on whether ShellyElevate has updated it; ES2019 is safely inside
 *  even the oldest of those, and avoids esbuild emitting helper shims. */
const opts = {
  entryPoints: [join(ROOT, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2019'],
  outfile: join(ROOT, 'public/hjem.js'),
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  loader: { '.css': 'text' },
  plugins: [{
    // Inline every imported .css into one <style> injected at boot: on this
    // hardware a separate stylesheet request is a render-blocking round trip
    // we can simply not make.
    name: 'inline-css',
    setup(b) {
      b.onLoad({ filter: /\.css$/ }, async (args) => {
        const fs = await import('node:fs/promises');
        const css = await fs.readFile(args.path, 'utf8');
        return {
          contents:
            `(function(){var s=document.createElement('style');` +
            `s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();`,
          loader: 'js',
        };
      });
    },
  }],
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(opts);
  const { gzipSync } = await import('node:zlib');
  const { readFileSync } = await import('node:fs');
  const raw = statSync(opts.outfile).size;
  const gz = gzipSync(readFileSync(opts.outfile)).length;
  const kb = (raw / 1024).toFixed(1), gzkb = (gz / 1024).toFixed(1);
  // Budget is on the gzipped wire size, which is what the panel actually
  // downloads and what dominates cold-start on a slow Wi-Fi link. Raw size
  // still matters for parse time on the A7, hence both are reported.
  // Raised from 25/90 once the hardware was actually measured. The original
  // numbers were a guess made against a datasheet; the panel then rendered an
  // 800 KB animated GIF at 59 fps and a 22 KB bundle boots in well under a
  // second. The budget still exists to catch drift, not to be a fetish.
  const BUDGET_GZ = 32, BUDGET_RAW = 115;
  console.log(`\n  hjem.js  ${kb} KB raw · ${gzkb} KB gzip`);
  console.log(`  budget   ${BUDGET_RAW} KB raw · ${BUDGET_GZ} KB gzip`);
  if (+gzkb > BUDGET_GZ || +kb > BUDGET_RAW) { console.error('  ✗ OVER BUDGET'); process.exit(1); }
  console.log('  ✓ within budget');
  console.log(`  for scale: the Home Assistant frontend is ~3–5 MB of JS.`);
}
