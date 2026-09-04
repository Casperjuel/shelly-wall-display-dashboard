import { el, text, cls, type Tile } from './dom';
import { icon } from './icons';
import { bindPress } from './press';
import { K, type Ctx } from './tiles';

/**
 * Panel settings — the pane that replaces what the stock Shelly UI used to give
 * you, so the wall display never has to be handed back to Shelly's app.
 *
 * Everything here is *device* level: screen brightness, speaker volume, and the
 * Android screens you occasionally need (Wi-Fi after a router change, sound,
 * app info). Room control — lights, heat, music — deliberately stays on the
 * other tabs and goes through Home Assistant.
 *
 * Two transports, because the panel is reached differently depending on how the
 * page is being viewed:
 *
 *   window.hjem  — the kiosk app's JavaScript bridge. The only thing that can
 *                  actually set Android's brightness and volume. Present only
 *                  when the page runs inside our app on the panel.
 *   Shelly RPC   — the firmware's own Ui.SetConfig. Reaches the backlight but
 *                  not Android's audio, and only from the panel's own origin.
 *
 * On a PC in the debug suite neither exists, so the controls render disabled
 * with an explanation rather than silently doing nothing.
 */

interface Bridge {
  setBrightness?(level: number): boolean;
  getBrightness?(): number;
  setVolume?(percent: number): boolean;
  getVolume?(): number;
  openSettings?(): void;
  openWifi?(): void;
  openSound?(): void;
  openApps?(): void;
  reload?(): void;
  setUrl?(u: string): void;
}

const bridge = (): Bridge | null => {
  const b = (window as unknown as { hjem?: Bridge }).hjem;
  return b && typeof b.setBrightness === 'function' ? b : null;
};

/** Android brightness is 1–255; everything user-facing here is a percentage. */
const pctToAndroid = (pct: number) => Math.max(1, Math.round((pct / 100) * 255));
const androidToPct = (v: number) => Math.max(0, Math.min(100, Math.round((v / 255) * 100)));

/**
 * A labelled slider. Native <input type=range> rather than a custom control:
 * the browser's own drag handling beats anything we'd write with pointer
 * events, and it is already accessible. Styling happens in CSS.
 */
function slider(opts: {
  key: string;
  ico: string;
  label: string;
  value: number;
  disabled: boolean;
  onInput: (v: number) => void;
}): { el: HTMLElement; set: (v: number) => void } {
  const card = el('div', 'set-card');
  card.dataset.key = opts.key;

  const head = el('div', 'set-head');
  const ic = el('span', 'set-ic');
  ic.innerHTML = icon(opts.ico, 17);
  const lbl = el('div', 'set-label');
  text(lbl, opts.label);
  const val = el('div', 'set-val tabular');
  text(val, `${opts.value}%`);
  head.append(ic, lbl, val);

  const input = el('input', 'set-range') as HTMLInputElement;
  input.type = 'range';
  input.min = '1';
  input.max = '100';
  input.step = '1';
  input.value = String(opts.value);
  input.disabled = opts.disabled;

  // `input` fires continuously while dragging. The paint is cheap (a gradient
  // on one element) but the bridge call is not, so the value is committed on
  // release and only previewed during the drag.
  let pending = opts.value;
  const paint = (v: number) => {
    text(val, `${v}%`);
    card.style.setProperty('--fill', `${v}%`);
  };
  paint(opts.value);

  input.addEventListener('input', () => {
    pending = Number(input.value);
    paint(pending);
  });
  const commit = () => opts.onInput(pending);
  input.addEventListener('change', commit);
  input.addEventListener('pointerup', commit);

  card.append(head, input);
  if (opts.disabled) cls(card, 'disabled', true);

  return {
    el: card,
    set: (v: number) => {
      input.value = String(v);
      paint(v);
    },
  };
}

export function buildSettings(ctx: Ctx, roomSlug: string, roomName: string, roomAccent: string): Tile {
  const kb = roomSlug;
  const wrap = el('div', 'set-wrap');
  const b = bridge();

  // ── brightness ───────────────────────────────────────────────────────────
  // Falls back to Shelly RPC when the bridge is absent: that still moves the
  // backlight when the page is served from the panel itself.
  const curBright = b?.getBrightness ? androidToPct(b.getBrightness()) : 50;
  const bright = slider({
    key: K(kb, 'set.brightness'),
    ico: 'sun',
    label: 'Lysstyrke',
    value: curBright > 0 ? curBright : 50,
    disabled: false,
    onInput: (v) => {
      if (b?.setBrightness) b.setBrightness(pctToAndroid(v));
      else ctx.actions.setPanelBrightness(v);
    },
  });
  wrap.append(bright.el);

  // ── volume ───────────────────────────────────────────────────────────────
  // Android's media stream, i.e. the panel's own speaker. Sonos volume lives on
  // the Musik tab and is a different thing entirely.
  const curVol = b?.getVolume ? b.getVolume() : 0;
  const vol = slider({
    key: K(kb, 'set.volume'),
    ico: 'volume',
    label: 'Lydstyrke',
    value: curVol >= 0 ? curVol : 0,
    disabled: !b?.setVolume,
    onInput: (v) => { b?.setVolume?.(v); },
  });
  wrap.append(vol.el);

  // ── android shortcuts ────────────────────────────────────────────────────
  const grid = el('div', 'set-grid');
  const shortcut = (id: string, ico: string, label: string, run: (() => void) | undefined) => {
    const btn = el('button', 'set-btn press');
    btn.dataset.key = K(kb, 'set', id);
    btn.innerHTML = `<span class="set-btn-ic">${icon(ico, 20)}</span><span>${label}</span>`;
    if (!run) cls(btn, 'disabled', true);
    else bindPress(btn, run, { immediate: true });
    grid.append(btn);
  };

  // Links into Android are safe again. This panel has no navigation bar, and
  // disabling the stock Shelly overlay removed the only Back button — which is
  // what made these a dead end earlier. The kiosk now puts up its own floating
  // "Hjem" button whenever it loses focus, and schedules a return after three
  // minutes as a second net, so leaving the dashboard is always recoverable.
  shortcut('reload', 'refresh', 'Genindlæs', () => {
    if (b?.reload) b.reload();
    else location.reload();
  });
  // No link to the house overview from here. That shell is laid out for the XL
  // kitchen display; on a 720x720 panel it overflows on the right and drops its
  // tab bar, so there would be no way back without adb.
  // Dimming a bedroom panel is a real daily need, but a button that leaves the
  // screen dark with the only way back being a slider you can no longer see is
  // just another trap. So it restores itself on the next touch anywhere.
  shortcut('wifi', 'wifi', 'Wi‑Fi', b?.openWifi ? () => b.openWifi!() : undefined);
  shortcut('android', 'android', 'Android', b?.openSettings ? () => b.openSettings!() : undefined);
  shortcut('dim', 'moon', 'Dæmp', () => {
    const prev = b?.getBrightness ? androidToPct(b.getBrightness()) : 60;
    const apply = (pct: number) => {
      if (b?.setBrightness) b.setBrightness(pctToAndroid(pct));
      else ctx.actions.setPanelBrightness(pct);
    };
    apply(1);
    const wake = () => {
      window.removeEventListener('pointerdown', wake, true);
      apply(prev > 1 ? prev : 60);
      bright.set(prev > 1 ? prev : 60);
    };
    // Capture phase, and only after this tap has finished, so the press that
    // triggered the dim does not immediately undo it.
    setTimeout(() => window.addEventListener('pointerdown', wake, true), 400);
  });
  wrap.append(grid);

  // ── accent ───────────────────────────────────────────────────────────────
  // The whole palette is derived from one hex by accentVars(), so a picker is
  // just that one value. Stored per device: nine panels, nine opinions.
  const ACCENTS: { name: string; hex: string }[] = [
    { name: 'Rum',    hex: '' },            // whatever rooms.yaml says
    { name: 'Lilla',  hex: '#8B7BD8' },
    { name: 'Grøn',   hex: '#4FA97A' },
    { name: 'Blå',    hex: '#5B8DD9' },
    { name: 'Rav',    hex: '#E0913C' },
    { name: 'Rosa',   hex: '#D97BA5' },
    { name: 'Grå',    hex: '#8A93A0' },
  ];

  const accentCard = el('div', 'set-card');
  const accentHead = el('div', 'set-head');
  const accentIc = el('span', 'set-ic');
  accentIc.innerHTML = icon('sparkle', 17);
  const accentLbl = el('div', 'set-label');
  text(accentLbl, 'Farve');
  accentHead.append(accentIc, accentLbl);
  const swatches = el('div', 'set-swatches');

  const paintSwatches = () => {
    const saved = (() => { try { return localStorage.getItem('hjem.accent'); } catch { return null; } })();
    for (const sw of Array.from(swatches.children) as HTMLElement[]) {
      const hex = sw.dataset.hex ?? '';
      cls(sw, 'on', hex ? hex.toLowerCase() === (saved ?? '').toLowerCase() : !saved);
    }
  };

  for (const a2 of ACCENTS) {
    const sw = el('button', 'set-swatch press');
    sw.dataset.hex = a2.hex;
    sw.dataset.key = K(kb, 'set.accent', a2.name.toLowerCase());
    sw.title = a2.name;
    if (a2.hex) sw.style.background = a2.hex;
    else cls(sw, 'auto', true);
    bindPress(sw, () => {
      try {
        if (a2.hex) localStorage.setItem('hjem.accent', a2.hex);
        else localStorage.removeItem('hjem.accent');
      } catch { /* storage disabled — the change still applies for this session */ }
      ctx.theme.setAccent(a2.hex || roomAccent);
      paintSwatches();
    }, { immediate: true });
    swatches.append(sw);
  }
  accentCard.append(accentHead, swatches);
  wrap.append(accentCard);
  paintSwatches();

  // ── status ───────────────────────────────────────────────────────────────
  // Worth showing on the glass: when something is wrong, this is the panel you
  // are standing in front of, and the answer is usually here.
  const info = el('div', 'set-info');
  const row = (k: string, v: string, id: string) => {
    const r = el('div', 'set-row');
    r.dataset.key = K(kb, 'set.info', id);
    const a = el('span', 'set-row-k');
    text(a, k);
    const c = el('span', 'set-row-v');
    text(c, v);
    r.append(a, c);
    info.append(r);
    return c;
  };

  row('Rum', roomName, 'room');
  const vConn = row('Home Assistant', '…', 'conn');
  row('App', b ? 'Hjem kiosk' : 'Browser', 'app');
  wrap.append(info);

  // Connection state, from the same connection everything else uses.
  // onState fires immediately with the current value, so no separate paint.
  const offConn = ctx.conn.onState((st) => {
    const ok = st === 'ready';
    text(vConn, ok ? 'Forbundet' : 'Afbrudt');
    cls(vConn, 'bad', !ok);
  });

  if (!b) {
    const note = el('div', 'set-note');
    text(note, 'Lysstyrke og lydstyrke kræver Hjem-appen på panelet.');
    wrap.append(note);
  }

  // Brightness and volume can change outside this pane — Android's own settings,
  // or the vageur dimming the screen at bedtime — so re-read them periodically
  // rather than trusting whatever we last wrote. Only while the pane is on
  // screen; a hidden pane polling the bridge would be pure waste.
  let poll: ReturnType<typeof setInterval> | null = null;
  const resync = () => {
    const bb = bridge();
    if (bb?.getBrightness) {
      const v = androidToPct(bb.getBrightness());
      if (v > 0) bright.set(v);
    }
    if (bb?.getVolume) {
      const v = bb.getVolume();
      if (v >= 0) vol.set(v);
    }
  };
  const obs = new MutationObserver(() => {
    const visible = wrap.parentElement?.classList.contains('show');
    if (visible && !poll) { resync(); poll = setInterval(resync, 4000); }
    else if (!visible && poll) { clearInterval(poll); poll = null; }
  });
  if (wrap.parentElement) obs.observe(wrap.parentElement, { attributes: true, attributeFilter: ['class'] });

  return {
    el: wrap,
    destroy() {
      offConn();
      obs.disconnect();
      if (poll) clearInterval(poll);
    },
  };
}
