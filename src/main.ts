import './ui/tokens.css';
import './ui/app.css';
import './ui/overview.css';
import './ui/wake.css';

import { CONFIG, roomBySlug, roomEntities } from './generated/config';
import { HaConnection } from './ha/connection';
import { Store } from './ha/store';
import { Actions } from './ha/actions';
import { buildPanel } from './ui/panel';
import { buildOverview } from './ui/overview';
import { el, text } from './ui/dom';
import { icon } from './ui/icons';
import type { Ctx } from './ui/tiles';
import { setBusRoom, emit } from './ui/bus';
import { startTheme } from './ui/theme';
import { createMoodWash } from './ui/moodwash';

const LS_TOKEN = 'hjem.token';
const LS_URL = 'hjem.url';

const qs = new URLSearchParams(location.search);
const app = document.getElementById('app')!;

/** Which room is this panel? `?room=` wins, then a build-time default, then
 *  the first room. Each display gets its own URL in the kiosk config. */
/** Room comes from ?room=, else the path (/sove), else panel-config.json,
 *  else the first room. A wall panel should need no query string at all. */
const pathSlug = location.pathname.replace(/^\/+|\/+$/g, '').split('/').pop() ?? '';
let slug =
  qs.get('room') ??
  (roomBySlug(pathSlug) ? pathSlug : undefined) ??
  CONFIG.rooms.find((r) => r.slug.startsWith(pathSlug) && pathSlug.length >= 3)?.slug ??
  '';

const haUrl = qs.get('ha') ?? localStorage.getItem(LS_URL) ?? CONFIG.meta.ha_url;
let token = qs.get('token') ?? localStorage.getItem(LS_TOKEN);

/**
 * Panel credentials, in order of preference:
 *   1. ?token= in the URL          (one-off / debugging)
 *   2. localStorage                (remembered after first load)
 *   3. panel-config.json           (deployed alongside the app)
 *
 * (3) exists because a wall panel's URL has to be typed on a 4" touchscreen.
 * A long-lived HA token is ~200 characters — nobody is thumbing that in. The
 * token ships next to the app instead, so the URL stays short enough to type:
 *   /local/hjem/index.html?room=sovevaerelse
 * Anyone who can read that file can already read the app itself, so this adds
 * no meaningful exposure beyond what serving the panel already implies.
 */
let cfgRoom = '';
let forcedRoom = '';
async function loadPanelConfig(): Promise<void> {
  try {
    const r = await fetch('panel-config.json', { cache: 'no-store' });
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg.room) cfgRoom = cfg.room;
    // force_room is the dev channel overriding whatever the url said
    if (cfg.force_room) { forcedRoom = cfg.force_room; }
    if (token) return;
    if (cfg.token) {
      token = cfg.token;
      localStorage.setItem(LS_TOKEN, cfg.token);
      if (cfg.ha_url) localStorage.setItem(LS_URL, cfg.ha_url);
    }
  } catch { /* not deployed with one; fall through to the setup screen */ }
}

let room = slug ? roomBySlug(slug) : undefined;

loadPanelConfig().then(() => {
  // panel-config.json may name this panel's room, so the URL can be bare
  if (forcedRoom && roomBySlug(forcedRoom)) { slug = forcedRoom; room = roomBySlug(forcedRoom); }
  if (!room && cfgRoom) { slug = cfgRoom; room = roomBySlug(cfgRoom); }
  if (!room) room = CONFIG.rooms[0];
  if (!token) renderSetup();
  else start(token, localStorage.getItem(LS_URL) ?? haUrl);
});

/** First-run screen. A long-lived access token is created once in HA under
 *  Profile → Security → Long-lived access tokens, then pasted here per panel. */
function renderSetup() {
  const wrap = el('div', 'setup');
  wrap.innerHTML = `
    <h1>Opsæt panel · ${room!.name}</h1>
    <p>Indsæt en <b>long-lived access token</b> fra Home Assistant
       (Profil → Sikkerhed → Langtidsholdbare adgangstokens).</p>`;
  const urlInput = el('input');
  urlInput.value = haUrl;
  urlInput.placeholder = 'http://homeassistant.local:8123';
  const tokInput = el('input');
  tokInput.placeholder = 'eyJhbGciOi…';
  const save = el('button');
  text(save, 'Gem og forbind');
  save.onclick = () => {
    if (!tokInput.value.trim()) return;
    localStorage.setItem(LS_TOKEN, tokInput.value.trim());
    localStorage.setItem(LS_URL, urlInput.value.trim());
    location.reload();
  };
  wrap.append(urlInput, tokInput, save);
  app.append(wrap);
}

function start(tok: string, url: string) {
  const store = new Store();
  const conn = new HaConnection(url, tok);
  const actions = new Actions(conn, store);


  conn.onEntities((ev) => store.ingest(ev));
  // A tap that HA never acknowledged is the earliest reliable sign the link is
  // dead — check immediately instead of waiting out the heartbeat.
  store.onUnconfirmed = () => conn.checkAlive();

  // Offline veil: shown only after a short delay so a 200 ms Wi-Fi blip during
  // an AP roam doesn't flash a scary overlay across the wall.
  const veil = el('div', 'offline-veil');
  veil.innerHTML = `<div class="veil-box">${icon('wifiOff', 30)}<span>Ingen forbindelse til Home Assistant</span></div>`;
  document.body.append(veil);

  let veilTimer: any = null;
  conn.onState((s, detail) => {
    if (s === 'ready') {
      clearTimeout(veilTimer);
      document.body.classList.remove('offline');
    } else if (s === 'lost' || s === 'connecting') {
      clearTimeout(veilTimer);
      veilTimer = setTimeout(() => document.body.classList.add('offline'), 2500);
    }
    if (detail === 'auth_invalid') {
      localStorage.removeItem(LS_TOKEN);
      veil.innerHTML = `<div class="veil-box">${icon('wifiOff', 30)}<span>Token afvist — genindlæs for at indsætte en ny</span></div>`;
    }
  });

  const model = CONFIG.models[room!.display];
  document.documentElement.dataset.model = room!.display;
  document.documentElement.dataset.room = room!.slug;

  // Accent + day/night. Started before the view is built so the first paint is
  // already in the right theme — no white flash on a bedroom panel at 3 a.m.
  const theme = startTheme(CONFIG.theme, store, room!.accent);
  // ?theme=light|dark pins the theme — used by the debug harness and handy when
  // checking a panel's daytime look at night.
  const forced = qs.get('theme');
  if (forced === 'light' || forced === 'dark') theme.set(forced);

  const mood = createMoodWash(theme, room!.slug);
  const ctx: Ctx = { store, actions, cfg: CONFIG, theme, mood };

  setBusRoom(room!.slug);
  const view = model.shell === 'overview' ? buildOverview(ctx) : buildPanel(ctx, room!);
  app.append(view.el);
  emit({ type: 'ready', room: room!.slug, entities: roomEntities(room!).length });

  conn.connect();

  // A wall panel runs for months. Reconnect promptly when the screen wakes,
  // rather than waiting out the backoff with stale state on screen.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && conn.state !== 'ready') { conn.disconnect(); conn.connect(); }
  });

  // Merge rather than replace: the panel may already have attached test hooks
  // (the sleep clock exposes `wake` so tooling can step it).
  (window as any).hjem = { ...((window as any).hjem ?? {}), conn, store, actions, ctx, theme, mood };
}
