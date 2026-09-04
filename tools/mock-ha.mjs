#!/usr/bin/env node
/**
 * Mock Home Assistant — WebSocket API + static file server.
 *
 * Exists because the real HA is offline and because a mock lets us inject
 * latency we can't reproduce on a healthy LAN. `--lag` simulates the Hue
 * bridge / Wavin controller round trip; crank it to 800 and the optimistic
 * layer is the only reason the UI still feels alive.
 *
 *   node tools/mock-ha.mjs --lag 350 --port 8123
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import YAML from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const PORT = +arg('port', 8123);
let LAG = +arg('lag', 300);            // ms before a "device" reports back
let JITTER = +arg('jitter', 150);
const TOKEN = 'mock-token';

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

const man = YAML.parse(readFileSync(manifestPath(ROOT), 'utf8'));
const clean = (e) => String(e).replace(/\?$/, '');

// ── seed a plausible house ─────────────────────────────────────────────────
const states = new Map();
const set = (id, state, attributes = {}) => states.set(id, { s: state, a: attributes });

// `pic` mirrors Home Assistant's `entity_picture` on a real Sonos player.
const TRACKS = [
  { t: 'Ghosteen',      ar: 'Nick Cave & The Bad Seeds', pic: '/cover1.svg' },
  { t: 'Sort Sol',      ar: 'Efterklang',                pic: '/cover2.svg' },
  { t: 'Hjertestarter', ar: 'Rasmus Seebach',            pic: '/cover3.svg' },
  { t: 'Vesterbro',     ar: 'Kesi',                      pic: '/cover4.svg' },
];

// The panels theme themselves off sun.sun, so the mock must provide it.
set('sun.sun', 'below_horizon', { friendly_name: 'Sun', elevation: -12.4 });

man.rooms.forEach((r, i) => {
  const e = r.entities ?? {};
  (e.lights ?? []).forEach((l, j) => {
    const on = (i + j) % 3 === 0;
    // Hue reports a colour temperature; a Shelly relay reports nothing, so the
    // panel falls back to a warm default. Both paths are exercised here.
    const kelvin = [2200, 2700, 3200, 4000][(i + j) % 4];
    set(clean(l.entity), on ? 'on' : 'off', {
      friendly_name: `${r.name} ${l.name}`,
      brightness: on ? 90 + j * 55 : 0,
      supported_color_modes: l.kind === 'hue' ? ['color_temp', 'xy'] : ['onoff'],
      ...(l.kind === 'hue' ? { color_temp_kelvin: kelvin, color_mode: 'color_temp' } : {}),
    });
  });
  if (e.climate) set(clean(e.climate), 'heat', {
    friendly_name: `${r.name} gulvvarme`,
    current_temperature: +(19.5 + (i % 4) * 0.7).toFixed(1),
    temperature: [20, 21, 21.5, 22][i % 4],
    min_temp: man.heating.min, max_temp: man.heating.max, target_temp_step: man.heating.step,
    hvac_modes: ['heat', 'off'], hvac_action: i % 3 === 0 ? 'heating' : 'idle',
  });
  if (e.media) {
    const playing = i % 4 === 0;
    const tr = TRACKS[i % TRACKS.length];
    set(clean(e.media), playing ? 'playing' : 'paused', {
      friendly_name: `Sonos ${r.name}`,
      media_title: tr.t, media_artist: tr.ar, entity_picture: tr.pic,
      volume_level: 0.18 + (i % 5) * 0.07, is_volume_muted: false,
      source_list: (man.sonos_favourites ?? []).map((f) => f.source),
      supported_features: 84031,
    });
  }
  if (e.temperature) set(clean(e.temperature), (19.8 + (i % 5) * 0.6).toFixed(1), {
    friendly_name: `${r.name} temperatur`, unit_of_measurement: '°C', device_class: 'temperature',
  });
  if (e.humidity) set(clean(e.humidity), String(38 + (i % 7) * 3), {
    friendly_name: `${r.name} luftfugtighed`, unit_of_measurement: '%', device_class: 'humidity',
  });
  (man.scenes ?? []).forEach((s) => {
    const id = s.scope === 'house' ? `scene.${s.id}` : `scene.${r.slug}_${s.id}`;
    set(id, 'unknown', { friendly_name: s.name });
  });
});

// ── static files ───────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };

const http = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // let the debug harness dial device latency at runtime
  if (url.pathname === '/__lag') {
    LAG = Math.max(0, +url.searchParams.get('ms') || 0);
    JITTER = Math.round(LAG * 0.4);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ lag: LAG, jitter: JITTER }));
    return;
  }
  if (url.pathname === '/__sun') {
    const want = url.searchParams.get('s');
    const st = states.get('sun.sun');
    st.s = want === 'up' ? 'above_horizon' : want === 'down' ? 'below_horizon'
         : st.s === 'above_horizon' ? 'below_horizon' : 'above_horizon';
    broadcast('sun.sun');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sun: st.s }));
    return;
  }
  // set a light's colour temperature, for eyeballing the state-aware gradients
  if (url.pathname === '/__ct') {
    const e = url.searchParams.get('e'), k = +url.searchParams.get('k');
    const st = states.get(e);
    if (st) { st.a.color_temp_kelvin = k; st.s = 'on'; broadcast(e); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ entity: e, kelvin: k, ok: !!st }));
    return;
  }
  // A real panel POSTs its measured canvas/latency here, so the numbers land
  // in a file on the dev machine instead of being read off a 4" screen.
  if (url.pathname === '/__measure') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const line = JSON.stringify({ at: new Date().toISOString(), ip: req.socket.remoteAddress, ...data });
        appendFileSync(join(ROOT, 'measurements.jsonl'), line + '\n');
        console.log('\n📐 MEASUREMENT FROM DEVICE');
        console.log('   ' + (data.ua || '').slice(0, 90));
        console.log(`   canvas ${data.innerWidth}x${data.innerHeight} @dpr ${data.dpr}  →  physical ${Math.round(data.innerWidth*data.dpr)}x${Math.round(data.innerHeight*data.dpr)}`);
        console.log(`   cores ${data.cores}  ram ${data.ram}GB`);
        console.log(`   fps ${data.fps} (peak ${data.fpsPeak})   touch→paint ${data.touchAvg ?? '–'} ms over ${data.touchN ?? 0} taps`);
      } catch (e) { console.log('bad measurement payload'); }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end('{"ok":true}');
    });
    return;
  }
  // Live reload for on-device iteration. The panel is on a wall; walking over
  // to hard-refresh it after every CSS tweak is not a workflow.
  if (url.pathname === '/__show') {
    if (url.searchParams.has('room')) SHOW_ROOM = url.searchParams.get('room') ?? '';
    if (url.searchParams.has('p')) SHOW = url.searchParams.get('p') ?? '';
    for (const send of reloadClients) send();   // push the panel straight there
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ showing: SHOW || 'dashboard', room: SHOW_ROOM || '(from url)' }));
    return;
  }
  // panel-config.json is served dynamically so the dev channel can inject a
  // room override on top of whatever was deployed
  if (url.pathname === '/panel-config.json') {
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(join(ROOT, 'public/panel-config.json'), 'utf8')); } catch {}
    if (SHOW_ROOM) cfg.force_room = SHOW_ROOM;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(cfg));
    return;
  }
  if (url.pathname === '/__demo') {
    const secs = url.searchParams.get('s') ?? '30';
    for (const send of reloadClients) send('demo:' + secs);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ demo: +secs }));
    return;
  }
  if (url.pathname === '/__reload') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 2000\n\n');
    const send = (msg = 'reload') => { try { res.write(`data: ${msg}\n\n`); } catch {} };
    reloadClients.add(send);
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { reloadClients.delete(send); clearInterval(ka); });
    return;
  }
  // ── failure injection ────────────────────────────────────────────────────
  // A wall panel runs for months. It will meet every one of these, and none of
  // them are reproducible by hand at a useful cadence.
  if (url.pathname === '/__kill') {
    // HA restarts: every socket closes, then the server comes back.
    let n = 0;
    for (const c of clients) { try { c.ws.close(); n++; } catch {} }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ closed: n }));
    return;
  }
  if (url.pathname === '/__auth') {
    // Token revoked or expired: HA answers auth with auth_invalid.
    AUTH_OK = url.searchParams.get('ok') !== 'false';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth_ok: AUTH_OK }));
    return;
  }
  if (url.pathname === '/__deaf') {
    // Half-open socket: the connection looks alive but nothing arrives. This
    // is what a Wi-Fi roam or an AP reboot actually looks like to the panel.
    DEAF = url.searchParams.get('on') !== 'false';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ deaf: DEAF }));
    return;
  }
  if (url.pathname === '/__unavailable') {
    // A device drops off: HA keeps the entity but reports `unavailable`.
    const e = url.searchParams.get('e');
    const on = url.searchParams.get('on') !== 'false';
    const st = states.get(e);
    if (st) {
      if (on) { st._was = st._was ?? st.s; st.s = 'unavailable'; }
      else if (st._was) { st.s = st._was; delete st._was; }
      broadcast(e);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ entity: e, state: st?.s ?? null }));
    return;
  }
  if (url.pathname === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries(states)));
    return;
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;

  // Short room URLs: /sove, /kokken, /tv  →  serve the app, it reads the room
  // off the path. A wall panel's URL gets typed on a 4" touchscreen once, so
  // it needs to be short enough to actually type.
  const bare = p.replace(/^\/+|\/+$/g, '');
  if (bare && !bare.includes('.') && !bare.startsWith('__')) {
    const hit = man.rooms.find((r) => r.slug === bare || r.slug.startsWith(bare));
    if (hit) p = SHOW ? '/' + SHOW : '/index.html';
  }

  const file = join(ROOT, 'public', p);
  if (existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found: ' + p);
});

// ── dev channel ────────────────────────────────────────────────────────────
// The panel is on a wall running a kiosk app locked to ONE url. Rather than
// re-typing that url on a 4" touchscreen every time we want to look at
// something else, the server decides what that url serves. Flip it from here:
//   curl '/__show?p=anim.html'   → the panel shows the animation benchmark
//   curl '/__show?p='            → back to the dashboard
let SHOW = '';
let AUTH_OK = true;   // /__auth?ok=false makes the server reject credentials
let DEAF = false;     // /__deaf     stops the server answering pings
// Room override for the dev channel, so a wall-mounted panel can be pointed at
// a different room without re-typing its url on a 4" touchscreen.
let SHOW_ROOM = '';

// ── live reload ────────────────────────────────────────────────────────────
const reloadClients = new Set();
{
  const watched = join(ROOT, 'public');
  let last = 0, timer = null;
  try {
    const { watch } = await import('node:fs');
    watch(watched, { recursive: true }, (_e, f) => {
      if (!f || !/\.(js|css|html|json)$/.test(f)) return;
      clearTimeout(timer);
      // debounce: esbuild writes several files in a burst
      timer = setTimeout(() => {
        const now = Date.now();
        if (now - last < 300) return;
        last = now;
        if (reloadClients.size) console.log(`↻ reloading ${reloadClients.size} panel(s) — ${f}`);
        for (const send of reloadClients) send();
      }, 250);
    });
  } catch (e) { console.log('live reload unavailable:', e.message); }
}

// ── websocket API ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: http, path: '/api/websocket' });
const clients = new Set();

function broadcast(id) {
  if (DEAF) return;
  const st = states.get(id);
  if (!st) return;
  const msg = JSON.stringify({
    type: 'event', id: 1,
    event: { c: { [id]: { '+': { s: st.s, a: st.a, lu: Date.now() / 1000 } } } },
  });
  for (const c of clients) if (c.subscribed && c.ws.readyState === 1) c.ws.send(msg);
}

/** Apply a change after a device-like delay, so we can see the optimistic gap. */
function later(fn) {
  setTimeout(fn, LAG + Math.random() * JITTER);
}

wss.on('connection', (ws) => {
  const c = { ws, subscribed: false, authed: false };
  clients.add(c);
  ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.8.0-mock' }));

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }

    if (m.type === 'auth') {
      if (!AUTH_OK || m.access_token !== TOKEN) {
        ws.send(JSON.stringify({ type: 'auth_invalid', message: 'bad token' }));
        return;
      }
      c.authed = true;
      ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.8.0-mock' }));
      return;
    }
    if (!c.authed) return;

    if (m.type === 'ping') {
      if (DEAF) return;          // socket stays open, pings go unanswered
      ws.send(JSON.stringify({ id: m.id, type: 'pong' }));
      return;
    }

    if (m.type === 'subscribe_entities') {
      ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
      const a = {};
      for (const [id, st] of states) a[id] = { s: st.s, a: st.a, lu: Date.now() / 1000 };
      ws.send(JSON.stringify({ type: 'event', id: m.id, event: { a } }));
      c.subscribed = true;
      return;
    }

    if (m.type === 'call_service') {
      ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: { context: {} } }));
      const targets = [].concat(m.target?.entity_id ?? []);
      const d = m.service_data ?? {};
      for (const id of targets) {
        const st = states.get(id);
        if (!st) continue;
        later(() => {
          switch (`${m.domain}.${m.service}`) {
            case 'light.turn_on':
              st.s = 'on';
              if (d.brightness_pct != null) st.a.brightness = Math.round(d.brightness_pct * 2.55);
              else if (!st.a.brightness) st.a.brightness = 255;
              if (d.color_temp_kelvin != null) st.a.color_temp_kelvin = d.color_temp_kelvin;
              break;
            case 'light.turn_off': st.s = 'off'; st.a.brightness = 0; break;
            case 'light.toggle':
              st.s = st.s === 'on' ? 'off' : 'on';
              st.a.brightness = st.s === 'on' ? (st.a.brightness || 255) : 0;
              break;
            case 'climate.set_temperature': st.a.temperature = d.temperature; break;
            case 'climate.set_hvac_mode':   st.s = d.hvac_mode; break;
            case 'media_player.media_play':       st.s = 'playing'; break;
            case 'media_player.media_pause':      st.s = 'paused'; break;
            case 'media_player.media_play_pause': st.s = st.s === 'playing' ? 'paused' : 'playing'; break;
            case 'media_player.volume_set':  st.a.volume_level = d.volume_level; break;
            case 'media_player.volume_mute': st.a.is_volume_muted = d.is_volume_muted; break;
            case 'media_player.select_source': st.a.source = d.source; st.s = 'playing'; break;
            case 'media_player.media_next_track': case 'media_player.media_previous_track': {
              const t = TRACKS[Math.floor(Math.random() * TRACKS.length)];
              st.a.media_title = t.t; st.a.media_artist = t.ar; st.a.entity_picture = t.pic; break;
            }
            case 'scene.turn_on': st.s = new Date().toISOString(); break;
          }
          broadcast(id);
        });
      }
      return;
    }

    ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
  });

  ws.on('close', () => clients.delete(c));
});

// drift the ambient sensors so the panel visibly lives
setInterval(() => {
  for (const [id, st] of states) {
    if (id.includes('temperatur') && st.a.device_class === 'temperature') {
      st.s = (parseFloat(st.s) + (Math.random() - 0.5) * 0.2).toFixed(1);
      broadcast(id);
    }
    if (id.startsWith('climate.')) {
      st.a.current_temperature = +(st.a.current_temperature + (Math.random() - 0.5) * 0.15).toFixed(1);
      broadcast(id);
    }
  }
}, 15000);

http.listen(PORT, () => {
  console.log(`mock HA   ws://localhost:${PORT}/api/websocket`);
  console.log(`panel     http://localhost:${PORT}/?room=tv_stue`);
  console.log(`kitchen   http://localhost:${PORT}/?room=kokken`);
  console.log(`measure   http://localhost:${PORT}/measure.html`);
  console.log(`token     ${TOKEN}`);
  console.log(`device lag ${LAG}±${JITTER} ms  ·  ${states.size} entities`);
});
