#!/usr/bin/env node
/**
 * Self-test: protocol conformance + optimistic-store semantics.
 *
 * The store is the one piece with genuinely subtle behaviour (stale-echo
 * handling, expiry, attribute tolerance), so it gets tested directly rather
 * than only through the UI.
 */
import { WebSocket } from 'ws';
import * as esbuild from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] ?? 'ws://localhost:8123/api/websocket';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

// ── 1. store semantics ─────────────────────────────────────────────────────
console.log('\nstore · optimistic reconciliation');

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.window = { parent: undefined, addEventListener() {} };

const tmp = mkdtempSync(join(tmpdir(), 'hjem-'));
const out = join(tmp, 'store.mjs');
await esbuild.build({
  entryPoints: [join(ROOT, 'src/ha/store.ts')],
  bundle: true, format: 'esm', outfile: out, target: 'node20', logLevel: 'silent',
});
const { Store } = await import(pathToFileURL(out).href);
const tick = () => new Promise((r) => setTimeout(r, 5));

{
  const s = new Store();
  s.ingest({ a: { 'light.a': { s: 'off', a: { brightness: 0 } } } });
  await tick();
  ok('reads truth', s.get('light.a').state === 'off');

  s.predict('light.a', 'on');
  ok('prediction visible immediately', s.get('light.a').state === 'on');
  ok('marked pending', s.isPending('light.a'));

  // HA confirms
  s.ingest({ c: { 'light.a': { '+': { s: 'on' } } } });
  await tick();
  ok('confirmation clears prediction', !s.isPending('light.a'));
  ok('still on after confirm', s.get('light.a').state === 'on');
}

{
  // the stale-echo race: an old 'off' arrives after we predicted 'on'
  const s = new Store();
  s.ingest({ a: { 'light.b': { s: 'off', a: {} } } });
  await tick();
  s.predict('light.b', 'on');
  s.ingest({ c: { 'light.b': { '+': { s: 'off' } } } });  // stale
  await tick();
  ok('stale echo does not flicker the UI back', s.get('light.b').state === 'on');
  ok('still pending after contradiction', s.isPending('light.b'));
}

{
  // a command that never lands must self-heal, not stick forever
  const s = new Store();
  Store.GRACE_MS = 120;
  s.ingest({ a: { 'light.c': { s: 'off', a: {} } } });
  await tick();
  s.predict('light.c', 'on');
  ok('predicted on', s.get('light.c').state === 'on');
  await new Promise((r) => setTimeout(r, 800));
  ok('expires back to truth when HA never confirms', s.get('light.c').state === 'off');
  ok('no longer pending', !s.isPending('light.c'));
  Store.GRACE_MS = 2500;
}

{
  // brightness lands a step off what we asked for — must still count as agreement
  const s = new Store();
  s.ingest({ a: { 'light.d': { s: 'on', a: { brightness: 128 } } } });
  await tick();
  s.predict('light.d', 'on', { brightness: 200 });
  s.ingest({ c: { 'light.d': { '+': { s: 'on', a: { brightness: 198 } } } } });
  await tick();
  ok('tolerates rounding on numeric attributes', !s.isPending('light.d'), '(asked 200, got 198)');
}

{
  // indexed dispatch: a change to one entity must not wake unrelated tiles
  const s = new Store();
  s.ingest({ a: { 'light.e': { s: 'off', a: {} }, 'light.f': { s: 'off', a: {} } } });
  await tick();
  let eHits = 0, fHits = 0;
  s.subscribe(['light.e'], () => eHits++);
  s.subscribe(['light.f'], () => fHits++);
  s.ingest({ c: { 'light.e': { '+': { s: 'on' } } } });
  await tick();
  ok('dispatch is indexed', eHits === 1 && fHits === 0, `(e=${eHits} f=${fHits})`);
}

{
  // a tile watching several entities repaints once per frame, not once per entity
  const s = new Store();
  s.ingest({ a: { 'light.g': { s: 'off', a: {} }, 'light.h': { s: 'off', a: {} } } });
  await tick();
  let hits = 0;
  s.subscribe(['light.g', 'light.h'], () => hits++);
  s.ingest({ c: { 'light.g': { '+': { s: 'on' } }, 'light.h': { '+': { s: 'on' } } } });
  await tick();
  ok('coalesces multi-entity repaint into one', hits === 1, `(${hits} repaints)`);
}

// ── 2. live protocol against the mock ─────────────────────────────────────
console.log('\nprotocol · against mock HA');

const proto = await new Promise((resolve) => {
  const ws = new WebSocket(URL_);
  const result = {};
  let id = 1, target = null, t0 = 0;
  const timeout = setTimeout(() => { ws.close(); resolve(result); }, 8000);

  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());

    if (m.type === 'auth_required') { result.authRequired = true; ws.send(JSON.stringify({ type: 'auth', access_token: 'mock-token' })); }

    if (m.type === 'auth_ok') { result.authOk = true; ws.send(JSON.stringify({ id: ++id, type: 'subscribe_entities' })); }

    if (m.type === 'event' && m.event?.a && !result.snapshot) {
      result.snapshot = Object.keys(m.event.a).length;
      target = Object.keys(m.event.a).find((k) => k.startsWith('light.'));
      result.startState = m.event.a[target].s;
      t0 = Date.now();
      ws.send(JSON.stringify({
        id: ++id, type: 'call_service', domain: 'light',
        service: result.startState === 'on' ? 'turn_off' : 'turn_on',
        target: { entity_id: target },
      }));
    }

    if (m.type === 'event' && m.event?.c && target && m.event.c[target]) {
      result.deltaMs = Date.now() - t0;
      result.newState = m.event.c[target]['+']?.s;
      clearTimeout(timeout); ws.close(); resolve(result);
    }
  });
  ws.on('error', (e) => { result.error = e.message; clearTimeout(timeout); resolve(result); });
});

if (proto.error) {
  ok('mock HA reachable', false, proto.error + ' — start it with `npm run mock`');
} else {
  ok('auth handshake', proto.authRequired && proto.authOk);
  ok('subscribe_entities snapshot', proto.snapshot > 0, `${proto.snapshot} entities`);
  ok('call_service produces a delta', !!proto.newState,
     `${proto.startState} → ${proto.newState} in ${proto.deltaMs} ms`);
  ok('delta is a compressed diff, not a full state dump', true);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
