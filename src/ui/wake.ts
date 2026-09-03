import type { WakeCfg } from '../generated/config';
import { el, text, cls, type Tile } from './dom';

/**
 * Vågeur — a moon-to-sun sleep clock for the children's rooms.
 *
 * Design constraints that drove this, in order:
 *
 *  1. A four-year-old cannot read "06:42". The answer to "can I get up?" has to
 *     be legible as a *picture*: moon = stay in bed, sun = get up. The clock
 *     face is secondary and deliberately small.
 *  2. A bright panel in a dark bedroom is worse than no panel. Night runs at a
 *     few percent brightness with a near-black sky; the device brightness is
 *     driven down through the Shelly RPC as well, not just the CSS.
 *  3. Nothing may animate continuously. The sky and the celestial bodies are
 *     positioned from the clock and repainted once a minute — a wall panel that
 *     animates all night would never let the GPU idle.
 *
 * Phases:
 *   night   sleep_at → wake_at − dawn      moon high, stars, almost black
 *   dawn    the dawn window before wake    moon sets, sun climbs, sky warms
 *   morning wake_at → +morning_minutes     sun up, warm, "du må godt stå op"
 *   off     otherwise                      normal dashboard
 */

export type Phase = 'night' | 'dawn' | 'morning' | 'off';

const mins = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Minutes from `a` to `b`, going forward through midnight if needed. */
const forward = (a: number, b: number) => (b - a + 1440) % 1440;

export interface WakeState {
  phase: Phase;
  /** 0 at the start of the dawn window, 1 at wake time */
  progress: number;
  /** minutes until wake time */
  until: number;
  /** 0 at bedtime, 1 at wake time — drives the moon across the whole sky */
  nightProgress: number;
}

/**
 * Overrides supplied by Home Assistant, when those entities exist.
 * `wakeAt` lets a parent move tomorrow's wake time from their phone;
 * `enabled` turns the clock off entirely (sleepover, holiday, illness).
 * Both are optional — the panel computes everything locally without them, so
 * an HA outage at 3 a.m. cannot leave a child's room dark or blazing.
 */
export interface WakeOverride { wakeAt?: string; enabled?: boolean }

export function wakeState(cfg: WakeCfg, now = new Date(), ov?: WakeOverride): WakeState {
  if (ov?.enabled === false) return { phase: 'off', progress: 0, until: 0, nightProgress: 0 };
  const t = now.getHours() * 60 + now.getMinutes();
  const sleep = mins(cfg.sleepAt);
  const wake = mins(ov?.wakeAt || cfg.wakeAt);
  const dawnStart = (wake - cfg.dawnMinutes + 1440) % 1440;

  const untilWake = forward(t, wake);

  // morning: the window just after wake time
  const sinceWake = forward(wake, t);
  const nightLen = forward(sleep, wake);
  const nightProgress = Math.max(0, Math.min(1, forward(sleep, t) / nightLen));

  if (sinceWake < cfg.morningMinutes) {
    return { phase: 'morning', progress: 1, until: 0, nightProgress: 1 };
  }

  // is it inside the night window at all? (sleep → wake, across midnight)
  const intoNight = forward(sleep, t);
  if (intoNight >= nightLen) return { phase: 'off', progress: 0, until: untilWake, nightProgress: 0 };

  // dawn: the last stretch before wake
  const intoDawn = forward(dawnStart, t);
  if (intoDawn < cfg.dawnMinutes) {
    return { phase: 'dawn', progress: intoDawn / cfg.dawnMinutes, until: untilWake, nightProgress };
  }
  return { phase: 'night', progress: 0, until: untilWake, nightProgress };
}

// ── sky palettes, by phase ────────────────────────────────────────────────
// Night is almost black on purpose: the moon should be the only real light.
const SKY = {
  night:   ['#05060c', '#0a0e1c'],
  dawnLo:  ['#0a0e1c', '#241b3d'],
  dawnHi:  ['#3d2547', '#8a4a3c'],
  morning: ['#2a4a72', '#e8994a'],
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Place a body on the sky arc.
 * `u` runs 0 → 1 from the eastern horizon, over the zenith, to the west.
 * Below-horizon values are allowed so a body can rise into view.
 */
function placeOnArc(node: SVGElement, u: number, opacity: number, scale: number) {
  // u = 0 on the LEFT, 1 on the RIGHT. Not compass-accurate — the sun really
  // rises in the east — but it reads with the direction of time, which is what
  // a child is actually parsing here.
  const a = u * Math.PI;

  // The body is a 116 px box anchored at top:14%, left:50%, so its natural
  // centre is ~26% down and centred horizontally. These constants convert a
  // target position (as % of the panel) into a transform of the box itself —
  // transform rather than top/left so the move stays on the compositor.
  //   horizon (sin 0) → centre ~62% down      zenith (sin 1) → centre ~18% down
  const x = 50 - 38 * Math.cos(a);            // 12% (left) … 88% (right)
  const tx = (x - 50) * 4.14;
  const ty = 149 - 182 * Math.sin(a);
  node.style.transform = `translate3d(${tx}%, ${ty}%, 0) scale(${scale})`;
  node.style.opacity = String(clamp01(opacity));
}
function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(lerp(v, pb[i], t)).toString(16).padStart(2, '0')).join('');
}

export interface WakeView extends Tile {
  update(): WakeState;
  /** Play a whole night in `seconds`, then return to the real clock. */
  demo(seconds?: number): void;
}

export function buildWakeClock(
  cfg: WakeCfg,
  onBrightness?: (pct: number) => void,
  getOverride?: () => WakeOverride | undefined
): WakeView {
  const root = el('div', 'wake');

  const sky = el('div', 'wake-sky');
  const stars = el('div', 'wake-stars');
  // Fixed star positions — random ones would move on every repaint and read as
  // flicker rather than sky.
  const STARS = [
    [12, 18, 1.6], [28, 9, 1.1], [44, 22, 1.9], [61, 12, 1.2], [78, 20, 1.5],
    [88, 8, 1.0], [20, 34, 1.2], [55, 31, 1.0], [72, 38, 1.4], [35, 44, 0.9],
    [8, 47, 1.1], [92, 33, 1.2], [66, 6, 0.9], [48, 52, 1.0],
  ];
  stars.innerHTML = STARS.map(([x, y, r]) =>
    `<i style="left:${x}%;top:${y}%;width:${r * 2}px;height:${r * 2}px"></i>`).join('');

  const bodies = el('div', 'wake-bodies');
  bodies.innerHTML = `
    <svg class="wake-moon" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M64 8a46 46 0 1 0 28 74A38 38 0 0 1 64 8z" fill="#e8eef7"/>
      <circle cx="42" cy="46" r="6"  fill="#cfd8e6" opacity=".55"/>
      <circle cx="58" cy="68" r="4"  fill="#cfd8e6" opacity=".45"/>
      <circle cx="30" cy="66" r="3"  fill="#cfd8e6" opacity=".4"/>
    </svg>
    <svg class="wake-sun" viewBox="0 0 100 100" aria-hidden="true">
      <g stroke="#ffd27a" stroke-width="5" stroke-linecap="round">
        <path d="M50 4v10M50 86v10M4 50h10M86 50h10
                 M17 17l7 7M76 76l7 7M83 17l-7 7M24 76l-7 7"/>
      </g>
      <circle cx="50" cy="50" r="26" fill="#ffc65a"/>
    </svg>`;

  const label = el('div', 'wake-label');
  const clock = el('div', 'wake-clock tabular');
  const hint = el('div', 'wake-hint');

  root.append(sky, stars, bodies, label, clock, hint);

  const moon = bodies.querySelector('.wake-moon') as SVGElement;
  const sun = bodies.querySelector('.wake-sun') as SVGElement;

  let lastBrightness = -1;

  function update(): WakeState {
    const st = wakeState(cfg, new Date(), getOverride?.());
    paint(st, new Date());
    return st;
  }

  function paint(st: WakeState, when: Date) {
    const { phase, progress, until, nightProgress } = st;

    // sky
    let a: string, b: string, starOpacity: number;
    if (phase === 'morning') {
      [a, b] = SKY.morning; starOpacity = 0;
    } else if (phase === 'dawn') {
      a = mixHex(SKY.dawnLo[0], SKY.dawnHi[0], progress);
      b = mixHex(SKY.dawnLo[1], SKY.dawnHi[1], progress);
      starOpacity = Math.max(0, 1 - progress * 1.6);
    } else {
      [a, b] = SKY.night; starOpacity = 1;
    }
    sky.style.background = `linear-gradient(180deg, ${a} 0%, ${b} 100%)`;
    stars.style.opacity = String(starOpacity);

    // Both bodies travel a real arc across the sky rather than sliding
    // vertically: rise in the east, cross overhead, set in the west. The moon
    // is driven by progress through the WHOLE night, so it is genuinely in a
    // different place at 2 a.m. than at bedtime — something a child can notice.
    const p = phase === 'morning' ? 1 : phase === 'dawn' ? progress : 0;
    placeOnArc(moon, lerp(0.18, 1.0, nightProgress), 1 - p * 1.15, lerp(1, 0.8, nightProgress));
    placeOnArc(sun, lerp(-0.06, 0.42, p), p * 1.5, lerp(0.75, 1, p));

    // words
    if (phase === 'morning') {
      text(label, 'Godmorgen');
      text(hint, 'Du må godt stå op');
    } else if (phase === 'dawn') {
      text(label, 'Snart morgen');
      text(hint, until <= 1 ? 'Lige om lidt' : `Om ${until} minutter`);
    } else {
      text(label, 'Sov godt');
      text(hint, 'Bliv i sengen til solen står op');
    }

    text(clock, `${when.getHours()}.${String(when.getMinutes()).padStart(2, '0')}`);
    cls(root, 'is-morning', phase === 'morning');
    cls(root, 'is-dawn', phase === 'dawn');
    cls(root, 'is-night', phase === 'night');

    // Drive the physical screen brightness too — CSS alone cannot make an LCD
    // stop glowing in a dark bedroom.
    // Backlight ramps *with* the sunrise rather than stepping at phase
    // boundaries — the whole point is that the room gets gradually lighter.
    const wantBrightness = phase === 'night' ? cfg.nightBrightness
      : phase === 'dawn' ? Math.round(lerp(cfg.nightBrightness, cfg.dawnBrightness, progress))
      : cfg.dayBrightness;
    // Never drive the real backlight from a demo sweep — it would strobe the
    // room and leave the panel at whatever level the sweep ended on.
    if (wantBrightness !== lastBrightness && !root.classList.contains('is-demo')) {
      lastBrightness = wantBrightness;
      onBrightness?.(wantBrightness);
    }
  }

  update();
  // 20 s: over a 90-minute sunrise that is ~270 steps of sky and brightness,
  // which reads as continuous without anything actually animating.
  const timer = setInterval(update, 20000);

  /**
   * Demo: sweep a simulated clock through bedtime → sunrise → morning so the
   * whole cycle can be watched in half a minute. Only for showing the thing
   * off — and for showing a child what the moon and sun are going to do. The
   * real clock never animates like this.
   */
  let demoRaf = 0;
  function demo(seconds = 30) {
    cancelAnimationFrame(demoRaf);
    root.classList.add('is-demo');
    const sleepM = mins(cfg.sleepAt);
    const wakeM = mins(getOverride?.()?.wakeAt || cfg.wakeAt);
    const span = forward(sleepM, wakeM) + cfg.morningMinutes;
    const t0 = performance.now();

    const step = () => {
      const k = (performance.now() - t0) / (seconds * 1000);
      if (k >= 1) {
        root.classList.remove('is-demo');
        update();                       // hand back to the real clock
        return;
      }
      // Ease so the long, uneventful middle of the night passes quickly and the
      // sunrise — the part worth watching — gets most of the time.
      const eased = k < 0.55 ? (k / 0.55) * 0.78 : 0.78 + ((k - 0.55) / 0.45) * 0.22;
      const simMinutes = (sleepM + eased * span) % 1440;
      const d = new Date();
      d.setHours(Math.floor(simMinutes / 60), Math.floor(simMinutes % 60), 0, 0);
      paint(wakeState(cfg, d, getOverride?.()), d);
      demoRaf = requestAnimationFrame(step);
    };
    demoRaf = requestAnimationFrame(step);
  }

  return {
    el: root, update, demo,
    destroy: () => { clearInterval(timer); cancelAnimationFrame(demoRaf); },
  };
}
