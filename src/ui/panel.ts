import type { RoomCfg } from '../generated/config';
import { el, text, cls, num, type Tile } from './dom';
import { icon } from './icons';
import { bindPress } from './press';
import { lightTile, climateTile, mediaTile, sceneTile, sensorChip, roomTemperature, artUrl, auraFromArt, K, type Ctx } from './tiles';
import { auraGradient } from './gradient';
import { buildWakeClock, wakeState, type WakeOverride } from './wake';

const TABS = [
  { id: 'hjem',  label: 'Hjem',  ico: 'home' },
  { id: 'lys',   label: 'Lys',   ico: 'bulb' },
  { id: 'varme', label: 'Varme', ico: 'thermo' },
  { id: 'musik', label: 'Musik', ico: 'music' },
] as const;

/**
 * Room panel for the 4" Wall Display.
 *
 * All four panes are built once and kept in the DOM; switching tabs toggles a
 * class. Rebuilding a pane per switch would cost 40–80 ms of layout on an A7 —
 * the exact stutter we're here to eliminate. The cost is a permanently larger
 * DOM, which is why tiles use `contain: layout style paint` and why the budget
 * in rooms.yaml caps node count.
 */
export function buildPanel(ctx: Ctx, room: RoomCfg): Tile {
  const root = el('div', 'panel');
  root.dataset.testid = K(room.slug, 'panel');
  const tiles: Tile[] = [];
  const kb = room.slug;

  // ── header ───────────────────────────────────────────────────────────────
  const header = el('header', 'hdr');
  const hTitle = el('div', 'hdr-title');
  text(hTitle, room.short);
  const hRight = el('div', 'hdr-right');
  const clock = el('div', 'clock tabular');
  const chips = el('div', 'chips');
  if (room.temperature) { const t = sensorChip(ctx, room.temperature, 'thermo', '°'); tiles.push(t); chips.append(t.el); }
  if (room.humidity)    { const h = sensorChip(ctx, room.humidity, 'drop', '%', 0); tiles.push(h); chips.append(h.el); }
  hRight.append(chips, clock);
  header.append(hTitle, hRight);

  // ── panes ────────────────────────────────────────────────────────────────
  const panes = el('div', 'panes');
  const pane = (id: string) => { const p = el('section', `pane pane-${id} scroll`); panes.append(p); return p; };

  // Hjem — the glance view: what the room is doing, and one tap to change it.
  // Each status tile navigates to its own tab; the small button on a tile does
  // that domain's primary action without leaving Hjem.
  const pHjem = pane('hjem');

  // ── now playing ──────────────────────────────────────────────────────────
  const npTile = el('div', 'tile home-np');
  npTile.dataset.key = K(kb, 'home.musik');
  const npAura = el('div', 'home-np-aura');
  const npArt = el('img', 'home-np-art') as HTMLImageElement;
  npArt.alt = '';
  const npMeta = el('div', 'home-np-meta');
  const npT = el('div', 'home-np-title');
  const npA = el('div', 'home-np-artist');
  npMeta.append(npT, npA);
  const npBtn = el('button', 'home-np-btn press');
  npBtn.dataset.key = K(kb, 'home.playpause');
  npTile.append(npAura, npArt, npMeta, npBtn);
  pHjem.append(npTile);

  // ── varme + lys ──────────────────────────────────────────────────────────
  const duo = el('div', 'home-duo');

  const varmeTile = el('div', 'tile home-stat home-varme');
  varmeTile.dataset.key = K(kb, 'home.varme');
  const vVal = el('div', 'home-stat-val tabular');
  const vSub = el('div', 'home-stat-sub tabular');
  const vLbl = el('div', 'home-stat-lbl');
  vLbl.innerHTML = `${icon('thermo', 15)}<span>Varme</span>`;
  varmeTile.append(vLbl, vVal, vSub);

  const lysTile = el('div', 'tile home-stat home-lys');
  lysTile.dataset.key = K(kb, 'home.lys');
  const lVal = el('div', 'home-stat-val');
  const lSub = el('div', 'home-stat-sub');
  const lLbl = el('div', 'home-stat-lbl');
  lLbl.innerHTML = `${icon('bulb', 15)}<span>Lys</span>`;
  const lBtn = el('button', 'home-lys-btn press');
  lBtn.dataset.key = K(kb, 'home.lys.toggle');
  lysTile.append(lLbl, lVal, lSub, lBtn);

  duo.append(varmeTile, lysTile);
  pHjem.append(duo);

  // ── scener ───────────────────────────────────────────────────────────────
  const sceneGrid = el('div', 'scene-grid');
  for (const s of room.scenes) { const t = sceneTile(ctx, s, kb); tiles.push(t); sceneGrid.append(t.el); }
  pHjem.append(sceneGrid);

  const lightIds = room.lights.map((l) => l.entity);

  // Lys
  const pLys = pane('lys');
  if (room.lights.length) {
    room.lights.forEach((l, i) => { const t = lightTile(ctx, l, K(kb, 'lys', i)); tiles.push(t); pLys.append(t.el); });
  } else pLys.append(el('div', 'empty', 'Ingen lys konfigureret'));

  // Varme
  const pVarme = pane('varme');
  if (room.climate) { const t = climateTile(ctx, room.climate, K(kb, 'varme'), room.temperature); tiles.push(t); pVarme.append(t.el); }
  else pVarme.append(el('div', 'empty', 'Ingen gulvvarme i dette rum'));

  // Musik
  const pMusik = pane('musik');
  if (room.media) { const t = mediaTile(ctx, room.media, K(kb, 'musik')); tiles.push(t); pMusik.append(t.el); }
  else pMusik.append(el('div', 'empty', 'Ingen højttaler i dette rum'));

  // ── tab bar ──────────────────────────────────────────────────────────────
  const tabbar = el('nav', 'tabbar');
  const tabEls: Record<string, HTMLElement> = {};
  let active = 'hjem';

  const select = (id: string) => {
    if (id === active) return;
    active = id;
    for (const t of TABS) {
      cls(tabEls[t.id], 'active', t.id === id);
      cls(panes.querySelector(`.pane-${t.id}`) as HTMLElement, 'show', t.id === id);
    }
  };

  for (const t of TABS) {
    const b = el('button', 'tab press');
    b.dataset.key = K(kb, 'tab', t.id);
    b.innerHTML = `<span class="tab-ic">${icon(t.ico, 22)}</span><span class="tab-lbl">${t.label}</span>`;
    bindPress(b, () => select(t.id), { immediate: true });
    tabEls[t.id] = b;
    tabbar.append(b);
  }
  cls(tabEls.hjem, 'active', true);
  cls(pHjem, 'show', true);

  root.append(header, panes, tabbar);

  // ── vågeur ───────────────────────────────────────────────────────────────
  // In the children's rooms the sleep clock takes the whole panel between
  // bedtime and the end of the morning window. It is built lazily and torn
  // down when it goes off, so rooms without one pay nothing.
  let wake: ReturnType<typeof buildWakeClock> | null = null;
  let wakeTimer: any = null;
  let peekUntil = 0;

  if (room.wake) {
    const cfg = room.wake;

    /** Drive the panel's physical backlight, not just the CSS. */
    const setBrightness = (pct: number) => {
      ctx.actions.setPanelBrightness(pct);
    };

    /** Home Assistant overrides, when those helper entities exist. */
    const override = (): WakeOverride | undefined => {
      const wakeAt = ctx.store.get(cfg.wakeEntity)?.state;
      const en = ctx.store.get(cfg.enabledEntity)?.state;
      if (!wakeAt && en === undefined) return undefined;
      return {
        // input_datetime reports "07:00:00"
        wakeAt: wakeAt && /^\d{2}:\d{2}/.test(wakeAt) ? wakeAt.slice(0, 5) : undefined,
        enabled: en === undefined ? undefined : en === 'on',
      };
    };

    const evaluate = () => {
      const active =
        wakeState(cfg, new Date(), override()).phase !== 'off' && Date.now() >= peekUntil;
      if (active && !wake) {
        wake = buildWakeClock(cfg, setBrightness, override);
        const exit = el('button', 'wake-exit');
        exit.dataset.key = K(kb, 'wake.exit');
        // Tap anywhere shows the normal panel for two minutes, then the clock
        // comes back on its own. Deliberately self-healing: a child poking it
        // cannot switch the sleep clock off for the night, and an adult never
        // has to remember to re-enable it.
        bindPress(exit, () => { peekUntil = Date.now() + 2 * 60 * 1000; evaluate(); },
                  { immediate: true });
        wake.el.appendChild(exit);
        root.appendChild(wake.el);
        // test hook: lets tooling step the clock and repaint on demand
        (window as any).hjem = { ...((window as any).hjem ?? {}), wake };
      } else if (!active && wake) {
        wake.destroy();
        wake.el.remove();
        wake = null;
      }
    };
    evaluate();
    // react immediately when a parent changes the time from HA
    tiles.push({
      el: root,
      destroy: ctx.store.subscribe([cfg.wakeEntity, cfg.enabledEntity], evaluate),
    });
    wakeTimer = setInterval(evaluate, 20000);
  }

  // ── Hjem interactions ────────────────────────────────────────────────────
  bindPress(npTile, () => select('musik'), { immediate: true });
  bindPress(varmeTile, () => select('varme'), { immediate: true });
  bindPress(lysTile, () => select('lys'), { immediate: true });
  if (room.media) {
    bindPress(npBtn, () => ctx.actions.playPause(room.media!), { immediate: true, stop: true });
  }
  bindPress(lBtn, () => {
    ctx.actions.setLightsInBulk(lightIds, !lightIds.some((e) => ctx.store.isOn(e)));
  }, { immediate: true, stop: true });

  let lastArt: string | null = null, lastAura = '';
  // Aura colours: the configured palette until album art is decoded, then the
  // art's own colours. Cached so later renders don't revert to the default.
  let auraCols = ctx.cfg.aura;
  const renderHome = () => {
    // now playing
    const playing = !!room.media && ctx.store.get(room.media)?.state === 'playing';
    const title = room.media ? ctx.store.attr<string>(room.media, 'media_title', '') : '';
    text(npT, !room.media ? 'Ingen højttaler'
      : title || (playing ? 'Afspiller' : 'Intet afspilles'));
    text(npA, room.media ? ctx.store.attr<string>(room.media, 'media_artist', '') : '');
    npBtn.innerHTML = icon(playing ? 'pause' : 'play', 22, true);
    cls(npTile, 'playing', playing);
    cls(npBtn, 'hidden', !room.media);
    const url = room.media ? artUrl(ctx, room.media) : null;
    if (url !== lastArt) {
      lastArt = url;
      if (url) { npArt.src = url; cls(npArt, 'show', true); } else cls(npArt, 'show', false);
      auraFromArt(ctx, url, ctx.theme.current() === 'dark', (colors) => {
        auraCols = colors; lastAura = ''; renderHome();
      });
    }
    const aura = auraGradient(auraCols, ctx.theme.current() === 'dark', playing);
    if (aura !== lastAura) { npAura.style.backgroundImage = aura; lastAura = aura; }

    // varme
    const cur = roomTemperature(ctx, room);
    const target = room.climate ? ctx.store.attr<number>(room.climate, 'temperature', NaN) : NaN;
    const heating = !!room.climate && ctx.store.attr(room.climate, 'hvac_action') === 'heating';
    text(vVal, Number.isNaN(cur) ? '–' : num(cur) + '°');
    text(vSub, Number.isNaN(target) ? (room.climate ? '' : 'ingen zone')
      : `${heating ? 'varmer' : 'mål'} ${num(target, target % 1 === 0 ? 0 : 1)}°`);
    cls(varmeTile, 'heating', heating);

    // lys
    const on = lightIds.filter((e) => ctx.store.isOn(e)).length;
    text(lVal, lightIds.length ? `${on}/${lightIds.length}` : '–');
    text(lSub, on ? 'tændt' : 'slukket');
    cls(lysTile, 'on', on > 0);
    cls(lBtn, 'on', on > 0);
    lBtn.innerHTML = icon('power', 18);
  };

  // ── live header bits ─────────────────────────────────────────────────────
  const tick = () => {
    const d = new Date();
    text(clock, `${d.getHours()}.${String(d.getMinutes()).padStart(2, '0')}`);
  };
  tick();
  const clockTimer = setInterval(tick, 20000);

  const watch = [room.temperature, room.climate, room.media, ...lightIds].filter(Boolean) as string[];
  const unsub = ctx.store.subscribe(watch, renderHome);
  const unsubTheme = ctx.theme.onChange(() => { lastArt = null; lastAura = ''; renderHome(); });
  renderHome();

  return {
    el: root,
    destroy() {
      clearInterval(clockTimer);
      clearInterval(wakeTimer);
      wake?.destroy();
      unsub();
      unsubTheme();
      tiles.forEach((t) => t.destroy());
    },
  };
}
