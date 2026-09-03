#!/usr/bin/env node
/**
 * Deploy the built panel into Home Assistant's www/ folder, where it is served
 * at http://<ha>:8123/local/hjem/ — same origin as the WebSocket API, so no
 * CORS, and it survives HA restarts.
 *
 *   HA_CONFIG=/path/to/homeassistant npm run deploy
 *   npm run deploy -- --dry
 *
 * If you'd rather not touch the HA config dir, any static host works — the app
 * only needs the HA URL and a token, both of which it stores per device.
 */
import { readdirSync, mkdirSync, copyFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

const CANDIDATES = [
  process.env.HA_CONFIG,
  '/config',                                   // running inside HA OS / container
  join(process.env.HOME ?? '', 'homeassistant'),
  join(process.env.HOME ?? '', '.homeassistant'),
].filter(Boolean);

const cfgDir = CANDIDATES.find((d) => existsSync(join(d, 'configuration.yaml')));
if (!cfgDir) {
  console.error('Could not find a Home Assistant config directory.');
  console.error('Looked in:\n  ' + CANDIDATES.join('\n  '));
  console.error('\nSet it explicitly:  HA_CONFIG=/path/to/homeassistant npm run deploy');
  process.exit(1);
}

const dest = join(cfgDir, 'www', 'hjem');
const src = join(ROOT, 'public');

if (!existsSync(join(src, 'hjem.js'))) {
  console.error('public/hjem.js missing — run `npm run build` first.');
  process.exit(1);
}

console.log(`HA config : ${cfgDir}`);
console.log(`deploying : ${src}  →  ${dest}`);
console.log(`served at : /local/hjem/index.html?room=<slug>\n`);

let n = 0, bytes = 0;
for (const f of readdirSync(src)) {
  const s = join(src, f);
  if (!statSync(s).isFile()) continue;
  bytes += statSync(s).size;
  n++;
  if (DRY) { console.log('  would copy ' + f); continue; }
  mkdirSync(dest, { recursive: true });
  copyFileSync(s, join(dest, f));
  console.log('  ' + f);
}

// Panel credentials, so the on-device URL can stay short enough to type.
if (!DRY && process.env.HA_TOKEN) {
  const cfg = {
    token: process.env.HA_TOKEN,
    ha_url: process.env.HA_PANEL_URL ?? process.env.HA_URL ?? '',
  };
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'panel-config.json'), JSON.stringify(cfg, null, 2));
  console.log('  panel-config.json  (token for the panels)');
  n++;
}

console.log(`\n${DRY ? 'dry run — ' : ''}${n} files · ${(bytes / 1024).toFixed(1)} KB`);
if (!DRY) {
  console.log('\nPoint each panel at its own room — no token needed in the URL:');
  console.log('  /local/hjem/index.html?room=kokken     (XL)');
  console.log('  /local/hjem/index.html?room=sovevaerelse');
  console.log('\nHA caches /local aggressively — hard-refresh a panel after deploying.');
}
