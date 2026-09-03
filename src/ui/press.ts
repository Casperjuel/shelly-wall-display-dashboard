/**
 * Touch interaction primitives.
 *
 * Why not `click`? Android WebView fires `click` ~80–300 ms after the finger
 * lifts (double-tap-zoom disambiguation, gesture arbitration). `touch-action:
 * manipulation` in tokens.css removes most of it, but pointer events remove
 * all of it and give us the down/up split we want:
 *
 *   pointerdown → repaint the press state NOW (this is what the eye reads as
 *                 "the panel responded")
 *   pointerup   → run the action, if the finger stayed inside the slop box
 *
 * Net effect: visible acknowledgement ~1 frame after contact, on a Cortex-A7.
 */

import { emit, registerKey } from './bus';

const SLOP = 12;         // px of movement still counted as a tap
const HOLD_MS = 450;     // long-press threshold

export interface PressOpts {
  /** Run the action on pointerdown instead of pointerup. Use only for
   *  non-destructive, non-scrollable controls where snap matters most. */
  immediate?: boolean;
  onLongPress?: () => void;
  haptic?: boolean;
  /** Fire repeatedly while held — for +/- steppers. */
  repeat?: { after: number; every: number };
  /** Stop the gesture from reaching an outer pressable (nested controls). */
  stop?: boolean;
}

export function haptic(ms = 8) {
  try { (navigator as any).vibrate?.(ms); } catch { /* not supported; fine */ }
}

export function bindPress(el: HTMLElement, handler: () => void, opts: PressOpts = {}) {
  let x0 = 0, y0 = 0, cancelled = false, holdTimer: any = null, repeatTimer: any = null;
  let fired = false;

  // `data-key` makes the control addressable from the debug harness, so a test
  // on a PC can press it without synthesising real pointer events.
  const key = el.dataset.key;
  let unregister: (() => void) | undefined;
  if (key) {
    unregister = registerKey(key, () => { emit({ type: 'tap', key }); handler(); });
  }
  const run = () => { if (key) emit({ type: 'tap', key }); handler(); };

  const down = (e: PointerEvent) => {
    if (e.button != null && e.button !== 0) return;
    if (opts.stop) e.stopPropagation();
    cancelled = false; fired = false;
    x0 = e.clientX; y0 = e.clientY;
    el.classList.add('down');
    if (opts.haptic !== false) haptic();

    if (opts.immediate) { run(); fired = true; }

    if (opts.onLongPress) {
      holdTimer = setTimeout(() => {
        if (cancelled) return;
        cancelled = true;           // a long press consumes the tap
        haptic(18);
        opts.onLongPress!();
      }, HOLD_MS);
    }

    if (opts.repeat) {
      repeatTimer = setTimeout(function tick() {
        if (cancelled) return;
        run(); fired = true; haptic(5);
        repeatTimer = setTimeout(tick, opts.repeat!.every);
      }, opts.repeat.after);
    }
  };

  const move = (e: PointerEvent) => {
    if (cancelled) return;
    if (Math.abs(e.clientX - x0) > SLOP || Math.abs(e.clientY - y0) > SLOP) {
      cancelled = true;
      el.classList.remove('down');
      clearTimeout(holdTimer); clearTimeout(repeatTimer);
    }
  };

  const up = (e: PointerEvent) => {
    if (opts.stop) e.stopPropagation();
    el.classList.remove('down');
    clearTimeout(holdTimer); clearTimeout(repeatTimer);
    if (!cancelled && !fired) run();
    cancelled = true;
  };

  const cancel = () => {
    cancelled = true;
    el.classList.remove('down');
    clearTimeout(holdTimer); clearTimeout(repeatTimer);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);

  return () => {
    unregister?.();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('pointerleave', cancel);
  };
}

export interface SliderOpts {
  /** Current value 0–100, read when a drag starts. */
  get: () => number;
  /** Called while dragging, rate-limited. Send the service call here. */
  onInput: (v: number) => void;
  /** Called once on release with the final value. */
  onCommit?: (v: number) => void;
  vertical?: boolean;
  /** ms between onInput calls while dragging. */
  throttle?: number;
}

/**
 * Drag slider.
 *
 * Two independent rates on purpose:
 *   • the fill repaints every frame (transform: scaleX — no layout, no paint
 *     of anything but the bar itself)
 *   • the service call fires at most every `throttle` ms
 * Dragging a Hue brightness slider at 60 Hz would otherwise queue 60
 * light.turn_on calls per second and melt the bridge.
 */
export function bindSlider(el: HTMLElement, fill: HTMLElement, opts: SliderOpts) {
  const throttle = opts.throttle ?? 140;
  let dragging = false, last = 0, pending: number | null = null, frame = 0;

  const valueFrom = (e: PointerEvent): number => {
    const r = el.getBoundingClientRect();
    const raw = opts.vertical
      ? 1 - (e.clientY - r.top) / r.height
      : (e.clientX - r.left) / r.width;
    return Math.max(0, Math.min(100, Math.round(raw * 100)));
  };

  const paint = (v: number) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fill.style.transform = opts.vertical ? `scaleY(${v / 100})` : `scaleX(${v / 100})`;
    });
  };

  const maybeSend = (v: number) => {
    const now = Date.now();
    if (now - last >= throttle) { last = now; opts.onInput(v); pending = null; }
    else pending = v;
  };

  const down = (e: PointerEvent) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    haptic();
    const v = valueFrom(e);
    paint(v); maybeSend(v);
  };

  const move = (e: PointerEvent) => {
    if (!dragging) return;
    const v = valueFrom(e);
    paint(v); maybeSend(v);
  };

  const up = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    el.classList.remove('dragging');
    const v = pending ?? valueFrom(e);
    paint(v);
    pending = null;
    (opts.onCommit ?? opts.onInput)(v);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  return {
    /** Repaint from external state — ignored mid-drag so HA echoes can't
     *  yank the bar out from under the finger. */
    sync(v: number) { if (!dragging) paint(v); },
    isDragging: () => dragging,
  };
}
