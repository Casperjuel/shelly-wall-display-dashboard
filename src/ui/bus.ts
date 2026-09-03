/**
 * Debug event bus.
 *
 * Every meaningful interaction emits a keyed event. In a normal panel this is
 * a handful of object allocations per tap and nothing listens. Inside the
 * debug harness (public/debug.html) the events are forwarded to the parent
 * window, which is how we can drive and verify all nine panels from a PC.
 *
 * The `settle` event is the one that matters most: it reports how long HA
 * actually took to confirm a change we had already painted. Optimistic paint
 * happens in ~1 frame; settle is typically 150–600 ms. The gap between those
 * two numbers is the entire reason this app exists.
 */
export type BusEvent =
  | { type: 'tap';     key: string; t: number }
  | { type: 'action';  key?: string; entity: string | string[]; service: string; data?: any; t: number }
  | { type: 'predict'; entity: string; state?: string; attributes?: any; t: number }
  | { type: 'settle';  entity: string; ms: number; confirmed: boolean; t: number }
  | { type: 'conn';    state: string; detail?: string; t: number }
  | { type: 'ready';   room: string; entities: number; t: number };

/** Omit must distribute over the union, otherwise it collapses to the keys
 *  every member shares (just `t`) and every emit() call fails to typecheck. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EmitArg = DistOmit<BusEvent, 't'> & { t?: number };

type Handler = (e: BusEvent) => void;
const handlers = new Set<Handler>();

/** Forward to the debug harness when embedded in one. */
const embedded = (() => { try { return window.parent !== window; } catch { return false; } })();

export function emit(e: EmitArg) {
  const ev = { ...e, t: e.t ?? Date.now() } as BusEvent;
  for (const h of handlers) h(ev);
  if (embedded) {
    try { window.parent.postMessage({ __hjem: true, room: ROOM, ev }, '*'); } catch { /* cross-origin */ }
  }
}

export function onBus(h: Handler) { handlers.add(h); return () => handlers.delete(h); }

let ROOM = '';
export function setBusRoom(slug: string) { ROOM = slug; }

/**
 * Remote control channel — lets the debug harness fire a tap in a panel by its
 * key, so a test can drive all nine panels at once. Panels register their
 * pressable elements here.
 */
const keyed = new Map<string, () => void>();
export function registerKey(key: string, fn: () => void) { keyed.set(key, fn); return () => keyed.delete(key); }
export function listKeys(): string[] { return [...keyed.keys()]; }

if (embedded) {
  window.addEventListener('message', (m: MessageEvent) => {
    const d = m.data;
    if (!d || !d.__hjemCmd) return;
    if (d.cmd === 'press') keyed.get(d.key)?.();
    if (d.cmd === 'keys') {
      try { window.parent.postMessage({ __hjem: true, room: ROOM, keys: listKeys() }, '*'); } catch { /* ignore */ }
    }
  });
}
