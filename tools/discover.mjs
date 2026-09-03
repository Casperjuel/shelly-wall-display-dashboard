#!/usr/bin/env node
/**
 * Entity discovery — run once Home Assistant is back online.
 *
 *   HA_URL=http://homeassistant.local:8123 HA_TOKEN=eyJ... npm run discover
 *   ... add --write to apply.
 *
 * Reads HA's area + entity registries and matches real entity_ids to the rooms
 * in rooms.yaml, then rewrites ONLY the `?`-suffixed guesses, in place, leaving
 * every comment and all formatting untouched. A YAML round-trip would strip the
 * commentary that explains the file, so this edits the text directly.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import YAML from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const URL_ = process.env.HA_URL ?? 'http://homeassistant.local:8123';
const TOKEN = process.env.HA_TOKEN;

if (!TOKEN) {
  console.error('Set HA_TOKEN (Profile → Security → Long-lived access tokens).');
  console.error('  HA_URL=http://homeassistant.local:8123 HA_TOKEN=eyJ... npm run discover -- --write');
  process.exit(1);
}

// ── talk to HA ─────────────────────────────────────────────────────────────
function ha(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/websocket');
    let id = 1;
    const pending = new Map();
    const call = (msg) => new Promise((ok, err) => { pending.set(++id, { ok, err }); ws.send(JSON.stringify({ ...msg, id })); });
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout talking to HA')); }, 20000);

    ws.on('message', async (b) => {
      const m = JSON.parse(b.toString());
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (m.type === 'auth_invalid') { clearTimeout(timer); ws.close(); return reject(new Error('token rejected')); }
      if (m.type === 'auth_ok') {
        try {
          const [states, areas, entities, devices] = await Promise.all([
            call({ type: 'get_states' }),
            call({ type: 'config/area_registry/list' }),
            call({ type: 'config/entity_registry/list' }),
            call({ type: 'config/device_registry/list' }),
          ]);
          clearTimeout(timer); ws.close();
          resolve({ states, areas, entities, devices });
        } catch (e) { clearTimeout(timer); ws.close(); reject(e); }
      }
      if (m.type === 'result') {
        const p = pending.get(m.id); if (!p) return;
        pending.delete(m.id);
        m.success ? p.ok(m.result) : p.err(new Error(JSON.stringify(m.error)));
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

console.log(`connecting to ${URL_} …`);
const { states, areas, entities, devices } = await ha(URL_, TOKEN);
console.log(`  ${states.length} states · ${areas.length} areas · ${devices.length} devices\n`);

// ── indexes ────────────────────────────────────────────────────────────────
const stateOf = new Map(states.map((s) => [s.entity_id, s]));
const devById = new Map(devices.map((d) => [d.id, d]));
const areaById = new Map(areas.map((a) => [a.area_id, a]));

/** An entity's area: its own, else its device's. */
const areaOf = (e) => e.area_id ?? (e.device_id ? devById.get(e.device_id)?.area_id : null) ?? null;

const norm = (s) => (s ?? '')
  .toLowerCase()
  .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Manufacturer/integration of the device behind an entity. */
function vendor(e) {
  const d = e.device_id ? devById.get(e.device_id) : null;
  const bits = [e.platform, d?.manufacturer, d?.model].filter(Boolean).join(' ').toLowerCase();
  if (bits.includes('hue')) return 'hue';
  if (bits.includes('shelly')) return 'shelly';
  if (bits.includes('sonos')) return 'sonos';
  if (bits.includes('wavin') || bits.includes('sentio') || bits.includes('ahc')) return 'wavin';
  return e.platform ?? '';
}

// ── match rooms ────────────────────────────────────────────────────────────
/**
 * Resolve the room manifest.
 *
 * `rooms.yaml` describes a specific house and is gitignored, so a fresh clone
 * has only `rooms.example.yaml`. Copy it across on first run rather than
 * failing: the whole project should build straight after `npm install`.
 */
function manifestPath(root) {
  const mine = join(root, 'rooms.yaml');
  if (existsSync(mine)) return mine;
  const example = join(root, 'rooms.example.yaml');
  if (existsSync(example)) {
    copyFileSync(example, mine);
    console.log('  rooms.yaml created from rooms.example.yaml — edit it to describe your house\n');
    return mine;
  }
  throw new Error('no rooms.yaml or rooms.example.yaml found');
}

const MANIFEST = manifestPath(ROOT);
const man = YAML.parse(readFileSync(MANIFEST, 'utf8'));
let text = readFileSync(MANIFEST, 'utf8');

/** Room → HA area, by normalised name. */
function areaFor(room) {
  const want = norm(room.name), slug = norm(room.slug);
  return areas.find((a) => norm(a.name) === want)
      ?? areas.find((a) => norm(a.name) === slug)
      ?? areas.find((a) => norm(a.name).includes(want) || want.includes(norm(a.name)))
      ?? null;
}

const resolutions = [];   // [placeholderWithQ, realId, note]
const report = [];

for (const room of man.rooms) {
  const area = areaFor(room);
  const inArea = area
    ? entities.filter((e) => areaOf(e) === area.area_id && !e.disabled_by && !e.hidden_by)
    : [];
  const dom = (d) => inArea.filter((e) => e.entity_id.startsWith(d + '.'));

  const lines = [`${room.name}  ${area ? `→ area "${area.name}" (${inArea.length} entities)` : '→ NO MATCHING AREA'}`];

  // lights, split by vendor
  const lights = dom('light');
  for (const cfg of room.entities.lights ?? []) {
    if (!String(cfg.entity).endsWith('?')) continue;
    const hit = lights.find((e) => vendor(e) === cfg.kind)
             ?? lights.find((e) => norm(e.original_name ?? e.name).includes(norm(cfg.name)));
    if (hit) { resolutions.push([cfg.entity, hit.entity_id]); lines.push(`  lys/${cfg.kind.padEnd(6)} ${hit.entity_id}`); }
    else lines.push(`  lys/${cfg.kind.padEnd(6)} — ikke fundet`);
    if (hit) lights.splice(lights.indexOf(hit), 1);
  }

  const pick = (domain, want) => {
    const c = dom(domain);
    return c.find((e) => vendor(e) === want) ?? c[0] ?? null;
  };

  for (const [key, domain, want, label] of [
    ['climate', 'climate', 'wavin', 'varme '],
    ['media', 'media_player', 'sonos', 'musik '],
  ]) {
    const cur = room.entities[key];
    if (!cur || !String(cur).endsWith('?')) continue;
    const hit = pick(domain, want);
    if (hit) { resolutions.push([cur, hit.entity_id]); lines.push(`  ${label} ${hit.entity_id}`); }
    else lines.push(`  ${label} — ikke fundet`);
  }

  // sensors by device_class, preferring the wall display's own built-in ones
  for (const [key, dclass, label] of [
    ['temperature', 'temperature', 'temp  '],
    ['humidity', 'humidity', 'fugt  '],
  ]) {
    const cur = room.entities[key];
    if (!cur || !String(cur).endsWith('?')) continue;
    const cands = dom('sensor').filter((e) => stateOf.get(e.entity_id)?.attributes?.device_class === dclass);
    const hit = cands.find((e) => /wall|display|panel/i.test(e.entity_id)) ?? cands[0] ?? null;
    if (hit) { resolutions.push([cur, hit.entity_id]); lines.push(`  ${label} ${hit.entity_id}`); }
    else lines.push(`  ${label} — ikke fundet`);
  }

  report.push(lines.join('\n'));
}

// scenes — reported only, since they must be created in HA first
const sceneIds = new Set(states.filter((s) => s.entity_id.startsWith('scene.')).map((s) => s.entity_id));
const wantScenes = man.rooms.flatMap((r) =>
  (man.scenes ?? []).filter((s) => s.scope === 'room').map((s) => `scene.${r.slug}_${s.id}`))
  .concat((man.scenes ?? []).filter((s) => s.scope === 'house').map((s) => `scene.${s.id}`));
const missingScenes = wantScenes.filter((s) => !sceneIds.has(s));

console.log(report.join('\n\n'));
console.log(`\n─────────────────────────────────────────────`);
console.log(`resolved ${resolutions.length} of ${resolutions.length + (54 - resolutions.length)} placeholders`);
if (missingScenes.length) {
  console.log(`\n${missingScenes.length} scenes do not exist in HA yet — create them, or remove them from rooms.yaml:`);
  for (const s of missingScenes.slice(0, 8)) console.log('  ' + s);
  if (missingScenes.length > 8) console.log(`  … and ${missingScenes.length - 8} more`);
}

if (!WRITE) {
  console.log('\nDry run. Re-run with --write to apply these to rooms.yaml.');
  process.exit(0);
}

for (const [placeholder, real] of resolutions) {
  // replace the quoted placeholder exactly, dropping the `?` marker
  text = text.split(`"${placeholder}"`).join(`"${real}"`);
}
writeFileSync(MANIFEST, text);
console.log(`\n✓ rooms.yaml updated. Now run:  npm run gen && npm run build`);
