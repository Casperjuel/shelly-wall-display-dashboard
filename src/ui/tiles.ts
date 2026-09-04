import type { Store } from '../ha/store';
import type { Actions } from '../ha/actions';
import type { LightCfg, SceneCfg, Config } from '../generated/config';
import type { ThemeController } from './theme';
import type { MoodWash } from './moodwash';
import { el, text, cls, num, type Tile } from './dom';
import { icon } from './icons';
import { bindPress, bindSlider } from './press';
import { lightLook, lightGradient, bulbInk, moodGradient, moodInk, auraGradient, artColors } from './gradient';

/**
 * Absolute URL for a media player's album art.
 * HA gives `entity_picture` as a root-relative path; when the panel is served
 * from HA that resolves on its own, but a panel served from the dev server has
 * to be pointed back at HA explicitly.
 */
export function artUrl(ctx: Ctx, entity: string): string | null {
  const pic = ctx.store.attr<string>(entity, 'entity_picture', '');
  if (!pic) return null;
  if (/^https?:/.test(pic)) return pic;
  const base = (localStorage.getItem('hjem.url') ?? '').replace(/\/+$/, '');
  return base && !pic.startsWith('/local/') ? base + pic : pic;
}

/**
 * Load art, then derive the aura from its dominant colours.
 * Falls back to the configured palette when the art is missing or the canvas
 * is tainted. Runs once per artwork, not per frame.
 */
export function auraFromArt(
  ctx: Ctx, url: string | null, dark: boolean, apply: (colors: string[]) => void
) {
  if (!url) { apply(ctx.cfg.aura); return; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => apply(artColors(img) ?? ctx.cfg.aura);
  img.onerror = () => apply(ctx.cfg.aura);
  img.src = url;
  void dark;
}

export interface Ctx { store: Store; actions: Actions; cfg: Config; theme: ThemeController; mood: MoodWash }

/** Stable, human-readable control id: "<room>.<group>.<control>".
 *  Used by data-key so the debug harness can press it by name. */
export const K = (...parts: (string | number)[]) => parts.join('.');

/* ── LYS ────────────────────────────────────────────────────────────────────
   A light row is one big toggle plus a full-width drag slider underneath.
   The toggle fires `immediate` — for a light switch, snap beats caution, and
   the optimistic store makes a mis-tap trivially recoverable. */
export function lightTile(ctx: Ctx, l: LightCfg, key: string): Tile {
  const root = el('div', 'tile light-tile');
  const head = el('button', 'light-head press');
  head.dataset.key = K(key, 'toggle');
  root.dataset.testid = key;
  const ic   = el('span', 'light-ic');
  const meta = el('span', 'light-meta');
  const name = el('span', 'light-name');
  const sub  = el('span', 'light-sub tabular');
  const dot  = el('span', 'pending-dot');

  ic.innerHTML = icon('bulb', 26);
  text(name, l.name);
  meta.append(name, sub);
  head.append(ic, meta, dot);

  const track = el('div', 'slider');
  track.dataset.key = K(key, 'slider');
  const fill  = el('div', 'slider-fill');
  const knob  = el('div', 'slider-knob');
  track.append(fill, knob);

  // Separate layer for the glow so the tile's own background/border stay put.
  const glow = el('div', 'light-glow');
  root.append(glow, head, track);

  const slider = bindSlider(track, fill, {
    get: () => ctx.actions.brightnessPct(l.entity),
    onInput: (v) => ctx.actions.setBrightness(l.entity, v),
    throttle: 160,
  });

  bindPress(head, () => ctx.actions.toggleLight(l.entity), { immediate: true });

  let lastGrad = '';
  const render = () => {
    const st = ctx.store.get(l.entity);
    const on = ctx.store.isOn(l.entity);
    const pct = ctx.actions.brightnessPct(l.entity);
    const avail = st?.state !== 'unavailable';
    cls(root, 'on', on);
    cls(root, 'unavailable', !avail);
    cls(dot, 'show', ctx.store.isPending(l.entity));
    text(sub, !avail ? 'utilgængelig' : on ? `${pct} %` : 'slukket');
    slider.sync(on ? pct : 0);

    // The tile glows in the bulb's actual colour, at the bulb's actual
    // brightness. Assigned only when it changes: writing backgroundImage
    // invalidates the layer, so doing it on every unrelated repaint would
    // undo the point of `contain: paint`.
    const look = lightLook(st?.state, st?.attributes ?? {});
    const grad = lightGradient(look, ctx.theme.current() === 'dark');
    if (grad !== lastGrad) { glow.style.backgroundImage = grad; lastGrad = grad; }
    const ink = bulbInk(look, ctx.theme.current() === 'dark');
    if (ink) root.style.setProperty('--bulb-ink', ink);
    else root.style.removeProperty('--bulb-ink');
  };

  const off = ctx.store.subscribe([l.entity], render);
  // the glow is theme-dependent, so recompute it when day/night flips
  const offTheme = ctx.theme.onChange(() => { lastGrad = ''; render(); });
  render();
  return { el: root, destroy() { off(); offTheme(); } };
}

/* ── VARME (Wavin) ──────────────────────────────────────────────────────────
   Big readable setpoint with hold-to-repeat steppers. The measured room
   temperature sits underneath in a quieter weight — you glance at "what is it"
   far more often than you change "what should it be". */
export function climateTile(ctx: Ctx, entity: string, key: string, roomTemp?: string): Tile {
  const { min, max, step, presets } = ctx.cfg.heating;
  const root = el('div', 'tile climate-tile');
  root.dataset.testid = key;

  const now = el('div', 'climate-now');
  const nowVal = el('span', 'climate-now-val tabular');
  const nowUnit = el('span', 'climate-now-unit');
  text(nowUnit, '°');
  now.append(nowVal, nowUnit);
  const nowLbl = el('div', 'climate-now-lbl');
  text(nowLbl, 'måltemperatur');

  const stepper = el('div', 'stepper');
  const minus = el('button', 'step press', icon('minus', 28));
  minus.dataset.key = K(key, 'minus');
  const plus  = el('button', 'step press', icon('plus', 28));
  plus.dataset.key = K(key, 'plus');
  const setV  = el('div', 'set-val tabular');
  stepper.append(minus, setV, plus);

  const status = el('div', 'climate-status');

  const presetRow = el('div', 'preset-row');
  const presetBtns = presets.map((p) => {
    const b = el('button', 'preset press');
    b.dataset.key = K(key, 'preset', p.name.toLowerCase());
    b.innerHTML = `<span>${p.name}</span><small class="tabular">${num(p.temp, 0)}°</small>`;
    bindPress(b, () => ctx.actions.setTemperature(entity, p.temp));
    presetRow.append(b);
    return { b, temp: p.temp };
  });

  root.append(now, nowLbl, stepper, status, presetRow);

  const nudge = (d: number) => ctx.actions.nudgeTemperature(entity, d, min, max, step);
  bindPress(minus, () => nudge(-step), { immediate: true, repeat: { after: 420, every: 130 } });
  bindPress(plus,  () => nudge(+step), { immediate: true, repeat: { after: 420, every: 130 } });

  const render = () => {
    const target = ctx.store.attr<number>(entity, 'temperature', 21);
    const cur = roomTemp
      ? parseFloat(ctx.store.get(roomTemp)?.state ?? '')
      : ctx.store.attr<number>(entity, 'current_temperature', NaN);
    const action = ctx.store.attr<string>(entity, 'hvac_action', 'idle');
    const off = ctx.store.get(entity)?.state === 'off';

    text(nowVal, num(target, target % 1 === 0 ? 0 : 1));
    text(setV, num(target, target % 1 === 0 ? 0 : 1) + '°');
    text(status, off ? 'slukket' : action === 'heating'
      ? `varmer · nu ${num(cur)}°`
      : `hviler · nu ${num(cur)}°`);
    cls(root, 'heating', action === 'heating' && !off);
    cls(root, 'off', off);
    for (const p of presetBtns) cls(p.b, 'active', Math.abs(p.temp - target) < 0.01);
  };

  const watch = roomTemp ? [entity, roomTemp] : [entity];
  const unsub = ctx.store.subscribe(watch, render);
  render();
  return { el: root, destroy: unsub };
}

/* ── MUSIK (Sonos) ─────────────────────────────────────────────────────────*/
export function mediaTile(ctx: Ctx, entity: string, key: string): Tile {
  const root = el('div', 'tile media-tile');
  root.dataset.testid = key;

  const nowPlaying = el('div', 'np');
  const npArt = el('img', 'np-art') as HTMLImageElement;
  npArt.alt = '';
  const npText = el('div', 'np-text');
  const npTitle = el('div', 'np-title');
  const npArtist = el('div', 'np-artist');
  npText.append(npTitle, npArtist);
  nowPlaying.append(npArt, npText);

  const transport = el('div', 'transport');
  const bPrev = el('button', 'tbtn press', icon('prev', 24, true));
  bPrev.dataset.key = K(key, 'prev');
  const bPlay = el('button', 'tbtn tbtn-main press');
  bPlay.dataset.key = K(key, 'playpause');
  const bNext = el('button', 'tbtn press', icon('next', 24, true));
  bNext.dataset.key = K(key, 'next');
  transport.append(bPrev, bPlay, bNext);

  const volRow = el('div', 'vol-row');
  const volIc = el('button', 'vol-ic press', icon('volume', 20));
  volIc.dataset.key = K(key, 'mute');
  const volTrack = el('div', 'slider slider-vol');
  volTrack.dataset.key = K(key, 'volume');
  const volFill = el('div', 'slider-fill');
  volTrack.append(volFill, el('div', 'slider-knob'));
  const volVal = el('span', 'vol-val tabular');
  volRow.append(volIc, volTrack, volVal);

  const favRow = el('div', 'fav-row scroll');
  for (const f of ctx.cfg.favourites) {
    const b = el('button', 'fav press');
    b.dataset.key = K(key, 'fav', f.name.toLowerCase());
    b.textContent = f.name;
    bindPress(b, () => ctx.actions.selectSource(entity, f.source));
    favRow.append(b);
  }

  const auraEl = el('div', 'media-aura');
  root.append(auraEl, nowPlaying, transport, volRow, favRow);

  bindPress(bPlay, () => ctx.actions.playPause(entity), { immediate: true });
  bindPress(bPrev, () => ctx.actions.prev(entity));
  bindPress(bNext, () => ctx.actions.next(entity));
  bindPress(volIc, () => ctx.actions.toggleMute(entity));

  const vol = bindSlider(volTrack, volFill, {
    get: () => ctx.actions.volumePct(entity),
    onInput: (v) => ctx.actions.setVolume(entity, v),
    throttle: 180,
  });

  let lastAura = '', lastArt: string | null = null;
  // Colours currently driving the aura. Starts as the configured palette and is
  // replaced when album art is decoded, so later renders keep the art's colours
  // instead of reverting to the default.
  let auraCols = ctx.cfg.aura;
  const render = () => {
    const st = ctx.store.get(entity);
    const playing = st?.state === 'playing';
    // Sonos reports `idle` when it has nothing queued, and `standby` when the
    // speaker is asleep. The mock only ever produced playing/paused, so these
    // rendered as a bare em-dash until a real speaker was connected.
    const idle = !st || ['unavailable', 'off', 'idle', 'standby', 'unknown'].includes(st.state);
    const muted = ctx.store.attr<boolean>(entity, 'is_volume_muted', false);
    const v = ctx.actions.volumePct(entity);

    const title = ctx.store.attr<string>(entity, 'media_title', '');
    text(npTitle, title || (idle ? 'Intet afspilles' : 'Afspiller'));
    text(npArtist, ctx.store.attr<string>(entity, 'media_artist', ''));
    bPlay.innerHTML = icon(playing ? 'pause' : 'play', 30, true);
    volIc.innerHTML = icon(muted ? 'mute' : 'volume', 20);
    text(volVal, muted ? '×' : String(v));
    cls(root, 'playing', playing);
    cls(root, 'idle', idle);
    vol.sync(muted ? 0 : v);

    // album art + an aura mixed from its own colours
    const url = artUrl(ctx, entity);
    if (url !== lastArt) {
      lastArt = url;
      if (url) { npArt.src = url; cls(npArt, 'show', true); }
      else cls(npArt, 'show', false);
      auraFromArt(ctx, url, ctx.theme.current() === 'dark', (colors) => {
        auraCols = colors;
        lastAura = '';        // force the repaint below to run
        render();
      });
    }
    const aura = auraGradient(auraCols, ctx.theme.current() === 'dark', playing);
    if (aura !== lastAura) { auraEl.style.backgroundImage = aura; lastAura = aura; }
  };

  const off = ctx.store.subscribe([entity], render);
  const offTheme = ctx.theme.onChange(() => { lastAura = ''; render(); });
  render();
  return { el: root, destroy() { off(); offTheme(); } };
}

/* ── SCENER ────────────────────────────────────────────────────────────────
   Scenes have no queryable state, so the acknowledgement is purely local:
   a flash class that self-clears. Without it, tapping a scene feels dead. */
export function sceneTile(ctx: Ctx, s: SceneCfg, key: string): Tile {
  const b = el('button', 'tile scene-tile press');
  b.dataset.key = K(key, 'scene', s.id);
  b.dataset.testid = K(key, 'scene', s.id);
  b.innerHTML =
    `<span class="scene-ic">${icon(s.icon, 24)}</span>` +
    `<span class="scene-name">${s.name}</span>`;

  // The tile previews the light this scene produces — warm and dim for Hygge,
  // cool and bright for Rengøring, near-black for Alt slukket. You should be
  // able to pick a scene from its swatch without reading the label.
  // Repainted only on a theme flip; otherwise entirely static.
  const paint = () => {
    const dark = ctx.theme.current() === 'dark';
    b.style.backgroundImage = moodGradient(s.mood, dark);
    b.style.setProperty('--mood-ink', moodInk(s.mood, dark));
  };
  paint();
  const offTheme = ctx.theme.onChange(paint);

  let t: any = null;
  bindPress(b, () => {
    ctx.actions.activateScene(s.entity);
    // The whole panel adopts this scene's light. Scenes report no state back
    // from HA, so this is the only confirmation the user gets — and because it
    // persists, the background doubles as "what is this room doing right now".
    ctx.mood.set(s.mood, s.id);
    b.classList.add('flash');
    clearTimeout(t);
    t = setTimeout(() => b.classList.remove('flash'), 550);
  }, { immediate: true });

  const syncActive = (activeId: string | null) => cls(b, 'active', activeId === s.id);
  syncActive(ctx.mood.activeScene());
  const offMood = ctx.mood.onChange(syncActive);

  return { el: b, destroy() { clearTimeout(t); offTheme(); offMood(); } };
}

/**
 * The room's headline temperature.
 *
 * Wavin measures the room; the wall display's own sensor sits behind a warm
 * LCD and reads several degrees high (the bedroom panel reports ~30 °C in a
 * ~21 °C room). So the climate entity wins, and the panel sensor is only a
 * fallback for rooms with no heating zone.
 */
export function roomTemperature(ctx: Ctx, room: { climate?: string; temperature?: string }): number {
  if (room.climate) {
    const t = ctx.store.attr<number>(room.climate, 'current_temperature', NaN);
    if (!Number.isNaN(t) && t !== undefined) return t;
  }
  if (room.temperature) {
    const v = parseFloat(ctx.store.get(room.temperature)?.state ?? '');
    if (!Number.isNaN(v)) return v;
  }
  return NaN;
}

/* ── SENSOR CHIP ───────────────────────────────────────────────────────────*/
export function sensorChip(ctx: Ctx, entity: string, ico: string, unit: string, digits = 1): Tile {
  const root = el('div', 'chip');
  const v = el('span', 'chip-val tabular');
  root.innerHTML = `<span class="chip-ic">${icon(ico, 16)}</span>`;
  root.append(v);
  const render = () => {
    const s = ctx.store.get(entity)?.state;
    text(v, s == null || s === 'unknown' || s === 'unavailable' ? '–' : num(s, digits) + unit);
  };
  const off = ctx.store.subscribe([entity], render);
  render();
  return { el: root, destroy: off };
}
