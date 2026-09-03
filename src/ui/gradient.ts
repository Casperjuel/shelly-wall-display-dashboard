/**
 * State-aware gradients.
 *
 * The point is that a gradient should *mean* something: a scene tile previews
 * the light that scene produces, and a light tile shows the colour the bulb is
 * actually emitting right now. A gradient that is merely decorative is weight
 * we can't afford on this hardware.
 *
 * All of these are STATIC once painted — they change only when an entity's
 * state changes (a few times an hour), never per frame. That is what keeps
 * them affordable on a Mali-400 with no blur available: the softness comes
 * from radial falloff, not from a filter.
 */

export type RGB = [number, number, number];

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
export const rgbStr = (c: RGB, a = 1) =>
  a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function hexToRgb(h: string): RGB {
  const s = h.replace('#', '');
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const v = parseInt(n, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Colour temperature → RGB (Tanner Helland's approximation).
 *
 * Hue bulbs report `color_temp_kelvin` in roughly 2000–6500 K. This is what
 * lets a "Hygge" scene at 2200 K render visibly amber while "Rengøring" at
 * 5500 K renders cool white — without hard-coding a colour per scene.
 */
export function kelvinToRgb(kelvin: number): RGB {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r: number, g: number, b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [clamp255(r), clamp255(g), clamp255(b)];
}

/** Mix toward a target, t in 0–1. */
export const mixRgb = (a: RGB, b: RGB, t: number): RGB =>
  [clamp255(a[0] + (b[0] - a[0]) * t), clamp255(a[1] + (b[1] - a[1]) * t), clamp255(a[2] + (b[2] - a[2]) * t)];

/** Perceived luminance, 0–1. */
export const luma = (c: RGB) => (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255;

// ── light tiles ────────────────────────────────────────────────────────────

export interface LightLook { rgb: RGB; brightness: number }

/**
 * What colour is this bulb actually emitting?
 * Prefers `rgb_color` (colour mode), falls back to colour temperature, then to
 * a warm 2700 K default for plain on/off relays like the Shelly Pro.
 */
export function lightLook(state: string | undefined, attrs: Record<string, any>): LightLook | null {
  if (state !== 'on') return null;

  const brightness = typeof attrs.brightness === 'number' ? attrs.brightness / 255 : 1;

  const rgbAttr = attrs.rgb_color;
  if (Array.isArray(rgbAttr) && rgbAttr.length >= 3) {
    return { rgb: [clamp255(rgbAttr[0]), clamp255(rgbAttr[1]), clamp255(rgbAttr[2])], brightness };
  }

  let kelvin: number | undefined = attrs.color_temp_kelvin;
  if (!kelvin && typeof attrs.color_temp === 'number' && attrs.color_temp > 0) {
    kelvin = 1e6 / attrs.color_temp;             // mireds → kelvin
  }
  return { rgb: kelvinToRgb(kelvin ?? 2700), brightness };
}

/**
 * A soft glow from the top-left of a light tile, in the bulb's own colour,
 * with intensity following brightness. Dimming a lamp visibly dims the tile.
 */
export function lightGradient(look: LightLook | null, dark: boolean): string {
  if (!look) return 'none';
  const { rgb, brightness } = look;
  // Keep a floor so a 1 % bulb is still visibly "on", and a ceiling so a white
  // bulb at 100 % doesn't wash out the text sitting on top of it.
  const peak = (dark ? 0.46 : 0.32) * (0.35 + 0.65 * brightness);
  const mid = peak * 0.42;
  // A cool counter-pool on the far side gives the tile depth; without it a lit
  // tile is a single flat wash. Shifted toward the bulb's complement so a warm
  // bulb picks up a faint cool edge, like real light falling across a surface.
  const cool = mixRgb(rgb, [90, 140, 255], 0.55);
  return (
    `radial-gradient(70% 150% at 96% 120%, ${rgbStr(cool, peak * 0.3)} 0%, ${rgbStr(cool, 0)} 70%), ` +
    `radial-gradient(135% 130% at 10% -14%, ${rgbStr(rgb, peak)} 0%, ` +
    `${rgbStr(rgb, mid)} 38%, ${rgbStr(rgb, 0)} 74%)`
  );
}

/**
 * A bulb colour corrected for legibility as text/fill.
 * A 5500 K bulb is near-white: fine on a dark panel, invisible on a light one.
 * A 2000 K bulb is deep orange: fine on light, muddy on dark.
 */
export function bulbInk(look: LightLook | null, dark: boolean): string | null {
  if (!look) return null;
  const c = look.rgb;
  if (dark) {
    // lift dim/very warm bulbs toward white so they don't disappear
    return rgbStr(luma(c) < 0.55 ? mixRgb(c, [255, 255, 255], 0.3) : c);
  }
  return rgbStr(mixRgb(c, [0, 0, 0], luma(c) > 0.75 ? 0.55 : 0.35));
}

// ── scene tiles ────────────────────────────────────────────────────────────

export interface Mood {
  /** colour temperature the scene sets, in kelvin */
  k?: number;
  /** explicit colour, overrides k */
  hex?: string;
  /** a second colour, pooled from the opposite corner */
  hue2?: string;
  /** 0–1, how bright the scene is — drives the gradient's intensity */
  level: number;
}

const moodPrimary = (m: Mood): RGB => (m.hex ? hexToRgb(m.hex) : kelvinToRgb(m.k ?? 2700));

/**
 * A scene tile's gradient is a *preview of the room under that scene*: warm and
 * dim for Hygge, cool and bright for Rengøring, almost nothing for Alt slukket.
 * You should be able to pick a scene by its swatch without reading the label.
 */
export function moodGradient(mood: Mood, dark: boolean): string {
  const c1 = moodPrimary(mood);
  const c2 = mood.hue2 ? hexToRgb(mood.hue2) : null;
  const lv = Math.max(0, Math.min(1, mood.level));

  // A dark scene should read as genuinely dark, not as a faint version of a
  // bright one — so intensity is curved, not linear.
  const strength = Math.pow(lv, 0.7);
  const peak = (dark ? 0.62 : 0.42) * strength;
  const mid = peak * 0.42;

  // Primary pool spills from the bottom-left, as light entering the tile.
  const layers = [
    `radial-gradient(96% 120% at 20% 106%, ${rgbStr(c1, peak)} 0%, ` +
      `${rgbStr(c1, mid)} 40%, ${rgbStr(c1, 0)} 76%)`,
  ];

  // The second hue pools from the opposite corner and overlaps in the middle.
  // Two colours reading against each other is what stops the tile looking like
  // a flat swatch — one hue alone always reads as tinted grey at these alphas.
  if (c2) {
    const p2 = peak * 0.82;
    layers.unshift(
      `radial-gradient(86% 104% at 92% -8%, ${rgbStr(c2, p2)} 0%, ` +
        `${rgbStr(c2, p2 * 0.4)} 42%, ${rgbStr(c2, 0)} 78%)`
    );
  }
  return layers.join(', ');
}

/** Text/icon colour that stays legible on a given mood. */
export function moodInk(mood: Mood, dark: boolean): string {
  // Ink follows the SECOND hue when there is one: it's the more saturated of
  // the pair, so it gives the icon a colour you can actually name.
  const rgb = mood.hue2 ? hexToRgb(mood.hue2) : moodPrimary(mood);
  if (!dark) return rgbStr(mixRgb(rgb, [0, 0, 0], 0.62));
  // On dark, lift the scene colour toward white so dim/warm scenes stay readable.
  const lift = 0.45 + 0.35 * (1 - Math.min(1, mood.level));
  return rgbStr(mixRgb(rgb, [255, 255, 255], lift));
}

/**
 * Page-scale version of a mood, used as feedback when a scene is activated:
 * the whole panel takes on the light that scene just set. Bigger, softer pools
 * than the tile version, positioned so they read as light entering the room
 * rather than as a coloured overlay.
 */
export function scenePageWash(mood: Mood, dark: boolean): string {
  const c1 = moodPrimary(mood);
  const c2 = mood.hue2 ? hexToRgb(mood.hue2) : mixRgb(c1, [90, 140, 255], 0.5);
  const lv = Math.max(0, Math.min(1, mood.level));
  const strength = 0.35 + 0.65 * Math.pow(lv, 0.6);
  const a1 = (dark ? 0.30 : 0.26) * strength;
  const a2 = (dark ? 0.24 : 0.21) * strength;
  return (
    `radial-gradient(85% 55% at 82% 104%, ${rgbStr(c2, a2)} 0%, ${rgbStr(c2, 0)} 70%), ` +
    `radial-gradient(105% 62% at 18% -8%, ${rgbStr(c1, a1)} 0%, ${rgbStr(c1, 0)} 68%)`
  );
}

/**
 * Brightness half of the feedback. A "Godnat" scene should make the panel
 * visibly darker and a "Rengøring" scene visibly brighter — colour alone does
 * not communicate level. Returned as a flat overlay colour.
 */
export function sceneScrim(mood: Mood, dark: boolean): string {
  const lv = Math.max(0, Math.min(1, mood.level));
  if (lv < 0.5) {
    // sleep / off: deepen toward black, strongest at level 0
    const t = (0.5 - lv) / 0.5;
    return `rgba(0,0,0,${(dark ? 0.55 : 0.30) * t})`;
  }
  // bright scenes lift the panel slightly
  const t = (lv - 0.5) / 0.5;
  return dark ? `rgba(255,255,255,${0.05 * t})` : `rgba(255,255,255,${0.35 * t})`;
}

/**
 * Dominant colours from album art, for the now-playing aura.
 *
 * Runs once per track change on a 12×12 downscale — a few hundred pixels, not
 * a few hundred thousand. Colours are bucketed in a coarse RGB grid and the
 * most-populated buckets win, which is crude but stable: it picks the poster
 * colours a human would name rather than an average, which is always mud.
 *
 * Returns null if the canvas is tainted (art served cross-origin), and callers
 * fall back to the configured palette.
 */
export function artColors(img: HTMLImageElement, want = 3): string[] | null {
  try {
    const N = 12;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    const { data } = ctx.getImageData(0, 0, N, N);   // throws if tainted

    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      // skip near-black, near-white and near-grey: they carry no identity and
      // would otherwise dominate most covers
      if (mx < 40 || mn > 225 || mx - mn < 28) continue;
      const key = ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5);
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      buckets.set(key, e);
    }
    if (!buckets.size) return null;

    const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, want);
    const out = sorted.map((e) => {
      // lift toward a usable saturation — cover art is often dark
      let c: RGB = [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)];
      if (luma(c) < 0.28) c = mixRgb(c, [255, 255, 255], 0.3);
      return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    });
    while (out.length < want) out.push(out[out.length - 1] ?? '#4fd08a');
    return out;
  } catch {
    return null;   // tainted canvas — art is on another origin
  }
}

// ── media tile ─────────────────────────────────────────────────────────────

/**
 * Layered soft blobs for the now-playing card. Three radial gradients with wide
 * falloff give the "aura" look with no filter: blur is unavailable to us on
 * Mali-400, and radial falloff is already soft.
 */
export function auraGradient(hexes: string[], dark: boolean, active: boolean): string {
  if (!active) return 'none';
  const a = dark ? 1 : 0.72;
  const [c1, c2, c3] = hexes.map(hexToRgb);

  // Each blob's falloff must reach zero BEFORE the card edge, or the rounded
  // rect slices through a still-bright part of the gradient and you see a hard
  // rectangular seam. Reach = centre ± (radius × final-stop):
  //   c1  64 ± 44×0.72 ≈ 32…96      c2  30 ± 38×0.72 ≈ 3…57
  //   c3  80 ± 28×0.75 ≈ 59…101
  return [
    `radial-gradient(44% 56% at 64% 30%, ${rgbStr(c1, 0.52 * a)} 0%, ${rgbStr(c1, 0)} 72%)`,
    `radial-gradient(38% 46% at 30% 72%, ${rgbStr(c2, 0.46 * a)} 0%, ${rgbStr(c2, 0)} 72%)`,
    `radial-gradient(56% 28% at 50% 80%, ${rgbStr(c3, 0.38 * a)} 0%, ${rgbStr(c3, 0)} 75%)`,
  ].join(', ');
}
