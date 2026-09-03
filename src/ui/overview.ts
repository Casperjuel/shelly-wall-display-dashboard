import type { RoomCfg } from '../generated/config';
import { el, text, cls, num, type Tile } from './dom';
import { icon } from './icons';
import { bindPress } from './press';
import { sceneTile, K, type Ctx } from './tiles';
import { buildPanel } from './panel';
import { applyAccentTo } from './theme';

/**
 * Whole-house view for the kitchen Wall Display XL (1280×752, RK3566).
 *
 * The XL has roughly 4× the pixel area and a far better SoC, so it earns the
 * role of house dashboard rather than a room panel. Tapping a room card slides
 * in that room's full panel — the same `buildPanel` the 4" displays run, so
 * there is exactly one implementation of a room to maintain.
 *
 * Room panels are built lazily on first open and then cached: building all 9
 * up front would blow the DOM budget, rebuilding every open would stutter.
 */
export function buildOverview(ctx: Ctx): Tile {
  const root = el('div', 'ov');
  const tiles: Tile[] = [];
  /** elements whose accent must be recomputed when day/night flips */
  const accentTargets: [HTMLElement, string][] = [];

  const header = el('header', 'ov-hdr');
  const title = el('div', 'ov-title');
  text(title, 'Hjem');
  const clock = el('div', 'ov-clock tabular');
  header.append(title, clock);

  const grid = el('div', 'ov-grid');
  const cards: { cfg: RoomCfg; render: () => void }[] = [];

  for (const room of ctx.cfg.rooms) {
    const card = el('div', 'tile ov-card press');
    card.dataset.key = K('ov.room', room.slug);
    card.dataset.testid = K('ov.room', room.slug);

    // Each card carries its own room's accent. Custom properties inherit, so
    // setting them here re-colours everything inside this card only.
    applyAccentTo(card, room.accent, ctx.theme.current());
    accentTargets.push([card, room.accent]);

    const top = el('div', 'ov-top');
    const cIcon = el('div', 'ov-ic');
    cIcon.innerHTML = icon(room.icon, 22);
    const cName = el('div', 'ov-name');
    text(cName, room.short);
    // Inline light toggle: the single most common action, reachable without
    // opening the room. Swallows the gesture so it can't also open the detail.
    top.append(cIcon, cName);

    const cTemp = el('div', 'ov-temp tabular');
    const cTarget = el('div', 'ov-target tabular');
    const cNow = el('div', 'ov-now');

    // Bottom action row: the two things you actually want to do to another
    // room from the kitchen, without opening it.
    const acts = el('div', 'ov-acts');
    const cLysBtn = el('button', 'ov-act press');
    cLysBtn.dataset.key = K('ov.lys', room.slug);
    cLysBtn.innerHTML = `${icon('bulb', 19)}<span>Lys</span>`;
    acts.append(cLysBtn);

    let cMedBtn: HTMLButtonElement | undefined;
    if (room.media) {
      cMedBtn = el('button', 'ov-act press');
      cMedBtn.dataset.key = K('ov.musik', room.slug);
      acts.append(cMedBtn);
    }

    card.append(top, cTemp, cTarget, cNow, acts);

    const render = () => {
      const t = room.temperature
        ? ctx.store.get(room.temperature)?.state
        : room.climate ? ctx.store.attr(room.climate, 'current_temperature') : undefined;
      text(cTemp, num(t) + '°');

      const target = room.climate ? ctx.store.attr<number>(room.climate, 'temperature', NaN) : NaN;
      const heating = !!room.climate && ctx.store.attr(room.climate, 'hvac_action') === 'heating';
      text(cTarget, Number.isNaN(target) ? '' :
        `${heating ? 'varmer' : 'mål'} ${num(target, target % 1 === 0 ? 0 : 1)}°`);

      const on = room.lights.filter((l) => ctx.store.isOn(l.entity)).length;
      const playing = !!room.media && ctx.store.get(room.media)?.state === 'playing';
      const title = playing ? ctx.store.attr<string>(room.media!, 'media_title', '') : '';
      text(cNow, playing ? title : on ? `${on} lys tændt` : '');
      cls(cNow, 'playing', playing);

      cls(card, 'lit', on > 0);
      cls(card, 'heating', heating);
      cls(cLysBtn, 'on', on > 0);
      if (cMedBtn) {
        cMedBtn.innerHTML = `${icon(playing ? 'pause' : 'play', 17, true)}<span>${playing ? 'Pause' : 'Afspil'}</span>`;
        cls(cMedBtn, 'on', playing);
      }
    };

    const watch = [room.temperature, room.climate, room.media, ...room.lights.map((l) => l.entity)]
      .filter(Boolean) as string[];
    const off = ctx.store.subscribe(watch, render);
    tiles.push({ el: card, destroy: off });
    render();
    cards.push({ cfg: room, render });

    bindPress(card, () => openRoom(room), { immediate: true });
    bindPress(cLysBtn, () => {
      const ids = room.lights.map((l) => l.entity);
      ctx.actions.setLightsInBulk(ids, !ids.some((e) => ctx.store.isOn(e)));
    }, { immediate: true, stop: true });
    if (cMedBtn) bindPress(cMedBtn, () => ctx.actions.playPause(room.media!),
                           { immediate: true, stop: true });
    grid.append(card);
  }

  // The 5×2 grid has one cell spare with 9 rooms — a house summary is more
  // useful there than a gap, and keeps the grid visually complete.
  const summary = el('div', 'tile ov-sum');
  const sumLys = el('div', 'ov-sum-row');
  const sumVarme = el('div', 'ov-sum-row');
  const sumMusik = el('div', 'ov-sum-row');
  summary.append(el('div', 'ov-sum-hd', 'Hele huset'), sumLys, sumVarme, sumMusik);
  const allLights = ctx.cfg.rooms.flatMap((r) => r.lights.map((l) => l.entity));
  const allMedia = ctx.cfg.rooms.map((r) => r.media).filter(Boolean) as string[];
  const allClimate = ctx.cfg.rooms.map((r) => r.climate).filter(Boolean) as string[];
  const renderSum = () => {
    const on = allLights.filter((e) => ctx.store.isOn(e)).length;
    const playing = allMedia.filter((e) => ctx.store.get(e)?.state === 'playing').length;
    const heating = allClimate.filter((e) => ctx.store.attr(e, 'hvac_action') === 'heating').length;
    sumLys.innerHTML = `${icon('bulb', 16)}<b>${on}</b><span>lys tændt</span>`;
    sumVarme.innerHTML = `${icon('thermo', 16)}<b>${heating}</b><span>rum varmer</span>`;
    sumMusik.innerHTML = `${icon('music', 16)}<b>${playing}</b><span>spiller</span>`;
  };
  const unsubSum = ctx.store.subscribe([...allLights, ...allMedia, ...allClimate], renderSum);
  renderSum();
  tiles.push({ el: summary, destroy: unsubSum });
  grid.append(summary);

  // house-wide scenes, taken from the first room's list (scope === 'house')
  const houseScenes = (ctx.cfg.rooms[0]?.scenes ?? []).filter((s) => s.scope === 'house');
  const sceneBar = el('div', 'ov-scenes');
  for (const s of houseScenes) { const t = sceneTile(ctx, s, 'ov'); tiles.push(t); sceneBar.append(t.el); }

  // House-wide light control sits beside the scenes: two taps that get used
  // more than any scene ever will.
  const bAllOn = el('button', 'ov-house lys press');
  bAllOn.dataset.key = 'ov.alt.lys.on';
  bAllOn.innerHTML = `${icon('bulb', 24)}<span>Alt lys tændt</span>`;
  const bAllOff = el('button', 'ov-house lys press');
  bAllOff.dataset.key = 'ov.alt.lys.off';
  bAllOff.innerHTML = `${icon('power', 24)}<span>Alt lys slukket</span>`;
  bindPress(bAllOn,  () => ctx.actions.setLightsInBulk(allLights, true),  { immediate: true });
  bindPress(bAllOff, () => ctx.actions.setLightsInBulk(allLights, false), { immediate: true });
  sceneBar.append(bAllOn, bAllOff);

  // ── room detail overlay ──────────────────────────────────────────────────
  const overlay = el('div', 'ov-detail');
  const back = el('button', 'ov-back press');
  back.dataset.key = 'ov.back';
  back.innerHTML = `${icon('chevron', 22)}<span>Tilbage</span>`;
  const detailHost = el('div', 'ov-detail-host');
  overlay.append(back, detailHost);

  const built = new Map<string, Tile>();
  let openSlug: string | null = null;

  function openRoom(room: RoomCfg) {
    let p = built.get(room.slug);
    if (!p) { p = buildPanel(ctx, room); built.set(room.slug, p); detailHost.append(p.el); }
    // The detail view takes on the room you opened — the kitchen panel feels
    // like it travelled to that room rather than staying kitchen-coloured.
    applyAccentTo(overlay, room.accent, ctx.theme.current());
    if (!accentTargets.some(([e]) => e === overlay)) accentTargets.push([overlay, room.accent]);
    else accentTargets[accentTargets.findIndex(([e]) => e === overlay)][1] = room.accent;
    for (const [slug, t] of built) cls(t.el, 'show', slug === room.slug);
    openSlug = room.slug;
    cls(overlay, 'open', true);
    cls(root, 'detail-open', true);
  }
  function closeRoom() {
    cls(overlay, 'open', false);
    cls(root, 'detail-open', false);
    openSlug = null;
  }
  bindPress(back, closeRoom, { immediate: true });

  root.append(header, grid, sceneBar, overlay);

  const tick = () => {
    const d = new Date();
    text(clock, `${d.getHours()}.${String(d.getMinutes()).padStart(2, '0')}`);
  };
  tick();
  const timer = setInterval(tick, 20000);

  // Element-scoped accents are theme-dependent (an accent that reads well on
  // near-black needs darkening on off-white), so redo them on every flip.
  const unsubTheme = ctx.theme.onChange((t) => {
    for (const [elm, hex] of accentTargets) applyAccentTo(elm, hex, t);
  });

  return {
    el: root,
    destroy() {
      clearInterval(timer);
      unsubTheme();
      tiles.forEach((t) => t.destroy());
      built.forEach((t) => t.destroy());
      void openSlug;
    },
  };
}
