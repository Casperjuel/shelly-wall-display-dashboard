import type { Store } from '../ha/store';
import type { ThemeCfg } from '../generated/config';

export type ThemeName = 'dark' | 'light';

// ── colour maths ───────────────────────────────────────────────────────────
// Done in JS rather than with CSS color-mix() so the palette works on an
// un-updated Android 11 WebView (color-mix needs Chrome 111+).

type RGB = [number, number, number];

function hex2rgb(h: string): RGB {
  const s = h.replace('#', '');
  const n = s.length === 3
    ? s.split('').map((c) => c + c).join('')
    : s;
  const v = parseInt(n, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const mix = (a: RGB, b: RGB, t: number): RGB =>
  [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t)];
const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Perceived luminance (Rec. 601), used to keep accent text legible. */
const lum = (c: RGB) => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 / 255;

const DARK_BASE: RGB = [20, 24, 30];
const LIGHT_BASE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/**
 * Derives the accent ramp for one colour in one theme.
 *
 * Returned as plain custom properties so it can be applied to :root (the whole
 * panel takes the room's colour) or to a single element (each room card on the
 * kitchen XL carries its own room's colour, since custom properties inherit
 * down from wherever they are set).
 */
export function accentVars(accentHex: string, theme: ThemeName): Record<string, string> {
  const a = hex2rgb(accentHex);
  const dark = theme === 'dark';
  const base = dark ? DARK_BASE : LIGHT_BASE;

  // On a light background a mid-tone accent needs darkening to stay legible.
  const text = dark ? a : (lum(a) > 0.55 ? mix(a, BLACK, 0.42) : mix(a, BLACK, 0.2));

  // A cooler companion hue, rotated toward blue. Used as a second pool so the
  // page and cards read as two colours meeting rather than one flat tint —
  // the same trick the scene tiles use.
  const cool = mix(a, [70, 120, 255], 0.6);

  return {
    '--accent': css(a),
    '--accent-text': css(text),
    '--accent-cool': css(cool),
    '--accent-soft': rgba(a, dark ? 0.22 : 0.16),
    '--accent-line': rgba(a, dark ? 0.46 : 0.5),
    '--lys': css(text),
    '--lys-dim': css(mix(base, a, dark ? 0.24 : 0.17)),

    // Page wash: warm pool top-centre, cool pool bottom-right.
    '--page-wash':
      `radial-gradient(90% 60% at 88% 112%, ${rgba(cool, dark ? 0.14 : 0.16)} 0%, rgba(0,0,0,0) 68%), ` +
      `radial-gradient(120% 68% at 42% -12%, ${rgba(a, dark ? 0.17 : 0.20)} 0%, rgba(0,0,0,0) 66%)`,

    // Cards carry a faint version of the same two-pool idea.
    '--card-grad':
      `radial-gradient(120% 140% at 100% 0%, ${rgba(cool, dark ? 0.10 : 0.09)} 0%, rgba(0,0,0,0) 60%), ` +
      `radial-gradient(130% 150% at 0% 100%, ${rgba(a, dark ? 0.11 : 0.10)} 0%, rgba(0,0,0,0) 62%), ` +
      `linear-gradient(180deg, ${dark ? '#171C23' : '#FFFFFF'} 0%, ${dark ? '#12171E' : '#FBF9F5'} 100%)`,
  };
}

export function applyAccentTo(elm: HTMLElement, accentHex: string, theme: ThemeName) {
  const vars = accentVars(accentHex, theme);
  for (const k in vars) elm.style.setProperty(k, vars[k]);
}

export const applyAccent = (accentHex: string, theme: ThemeName) =>
  applyAccentTo(document.documentElement, accentHex, theme);

// ── theme selection ────────────────────────────────────────────────────────

const hhmm = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * Chooses day or night.
 *
 * `sun.sun` is preferred over a clock because Home Assistant already computes
 * real sunrise/sunset for your coordinates. In Denmark that ranges from ~03:30
 * in June to ~08:45 in December — a fixed schedule would have panels glaringly
 * light before dawn in winter and dark in broad daylight in summer.
 */
export function resolveTheme(cfg: ThemeCfg, store: Store, now = new Date()): ThemeName {
  if (cfg.mode === 'dark' || cfg.mode === 'light') return cfg.mode;

  if (cfg.mode === 'sun') {
    const sun = store.get(cfg.sun_entity)?.state;
    if (sun === 'above_horizon') return 'light';
    if (sun === 'below_horizon') return 'dark';
    // sun.sun missing (HA still starting, or entity renamed) — fall through
  }

  const mins = now.getHours() * 60 + now.getMinutes();
  const from = hhmm(cfg.light_from), to = hhmm(cfg.light_to);
  return mins >= from && mins < to ? 'light' : 'dark';
}

export interface ThemeController {
  current(): ThemeName;
  stop(): void;
  set(t: ThemeName | 'auto'): void;
  /** Fires whenever day/night flips, so element-scoped accents can be redone. */
  onChange(cb: (t: ThemeName) => void): () => void;
}

export function startTheme(cfg: ThemeCfg, store: Store, accentHex: string): ThemeController {
  let manual: ThemeName | null = null;
  let applied: ThemeName | null = null;
  let fadeTimer: any = null;
  const listeners = new Set<(t: ThemeName) => void>();

  const apply = (t: ThemeName, animate: boolean) => {
    if (t === applied) return;
    const root = document.documentElement;

    // The crossfade transitions are gated behind `.theming` so they exist only
    // during the change — leaving them on would add a transition to every
    // colour property during ordinary interaction.
    if (animate && applied !== null) {
      root.style.setProperty('--t-theme', cfg.transition_ms + 'ms');
      root.classList.add('theming');
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => root.classList.remove('theming'), cfg.transition_ms + 60);
    }

    root.dataset.theme = t;
    applyAccent(accentHex, t);
    applied = t;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0B0D10' : '#F2EFEA');

    listeners.forEach((cb) => cb(t));
  };

  const evaluate = (animate = true) => apply(manual ?? resolveTheme(cfg, store, new Date()), animate);

  apply(manual ?? resolveTheme(cfg, store, new Date()), false);

  // React the moment HA reports the sun crossing the horizon…
  const unsub = store.subscribe([cfg.sun_entity], () => evaluate(true));
  // …and re-check on a slow timer, which covers the time-based fallback and
  // the case where sun.sun only appears after HA finishes starting up.
  const timer = setInterval(() => evaluate(true), 60000);

  return {
    current: () => applied!,
    stop() { unsub(); clearInterval(timer); clearTimeout(fadeTimer); },
    set(t) {
      manual = t === 'auto' ? null : t;
      evaluate(true);
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
