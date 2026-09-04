import type { EntityId, HaState, EntitiesEvent } from './types';
import { emit } from '../ui/bus';

type Sub = (s: HaState | undefined) => void;

interface Optimistic {
  state?: string;
  attributes?: Record<string, any>;
  expires: number;
  /** when the prediction was made — used to report settle latency */
  at: number;
}

/**
 * Entity store with an optimistic overlay.
 *
 * The whole point of this file: HA's round trip (websocket out → Zigbee/Hue
 * bridge → device → state_changed back) is 150–600 ms on a good day. If the UI
 * waits for that echo before repainting, every tap feels broken. So we paint
 * the *guess* on pointerdown and reconcile when the truth lands.
 *
 * Reconciliation rules:
 *   • truth matches the guess           → drop the guess, confirmed.
 *   • truth contradicts the guess       → keep the guess until it expires.
 *     (A contradicting update this soon is almost always the *stale* echo of
 *      the state we just changed, arriving after our optimistic write. Snapping
 *      back and then forward again is the flicker we're trying to avoid.)
 *   • guess expires with no confirmation → drop it, truth wins, UI self-heals.
 */
export class Store {
  private truth = new Map<EntityId, HaState>();
  private guess = new Map<EntityId, Optimistic>();
  private subs = new Map<EntityId, Set<Sub>>();

  /** Entities changed since the last flush. */
  private dirty = new Set<EntityId>();
  private frame = 0;
  private sweepTimer: any = null;

  /** How long an unconfirmed optimistic value survives. */
  static GRACE_MS = 2500;

  /**
   * Called when a prediction expires with no confirmation from HA.
   *
   * This is the strongest evidence available that the connection is dead: the
   * user touched something, we sent it, and nothing came back. The heartbeat
   * alone takes up to a minute to notice a half-open socket — acceptable when
   * the room is empty, useless when somebody is standing at the panel wondering
   * why the light did not come on.
   */
  onUnconfirmed: ((entity: string) => void) | null = null;

  // ── reads ─────────────────────────────────────────────────────────────────
  get(id: EntityId): HaState | undefined {
    const t = this.truth.get(id);
    const g = this.guess.get(id);
    if (!g) return t;
    return {
      entity_id: id,
      state: g.state ?? t?.state ?? 'unavailable',
      attributes: g.attributes ? { ...(t?.attributes ?? {}), ...g.attributes } : (t?.attributes ?? {}),
      lu: t?.lu,
    };
  }

  isOn(id: EntityId): boolean {
    const s = this.get(id)?.state;
    return s === 'on' || s === 'playing' || s === 'home' || s === 'open';
  }

  isPending(id: EntityId): boolean { return this.guess.has(id); }

  attr<T = any>(id: EntityId, key: string, fallback?: T): T {
    const v = this.get(id)?.attributes?.[key];
    return (v === undefined ? fallback : v) as T;
  }

  // ── subscriptions ─────────────────────────────────────────────────────────
  /** Subscribe to a set of entities. Dispatch is indexed, so an update to one
   *  light never walks the other 8 rooms' tiles. */
  subscribe(ids: EntityId[], cb: Sub): () => void {
    for (const id of ids) {
      let set = this.subs.get(id);
      if (!set) this.subs.set(id, (set = new Set()));
      set.add(cb);
    }
    return () => {
      for (const id of ids) this.subs.get(id)?.delete(cb);
    };
  }

  // ── writes from HA ────────────────────────────────────────────────────────
  ingest(ev: EntitiesEvent) {
    if (ev.a) {
      for (const id in ev.a) {
        const a = ev.a[id];
        this.truth.set(id, { entity_id: id, state: a.s, attributes: a.a ?? {}, lu: a.lu });
        this.dirty.add(id);
      }
    }
    if (ev.c) {
      for (const id in ev.c) {
        const c = ev.c[id];
        const prev = this.truth.get(id);
        const next: HaState = prev
          ? { entity_id: id, state: prev.state, attributes: { ...prev.attributes }, lu: prev.lu }
          : { entity_id: id, state: 'unknown', attributes: {} };

        const plus = c['+'];
        if (plus) {
          if (plus.s !== undefined) next.state = plus.s;
          if (plus.lu !== undefined) next.lu = plus.lu;
          if (plus.a) Object.assign(next.attributes, plus.a);
        }
        const minus = c['-'];
        if (minus?.a) for (const k of minus.a) delete next.attributes[k];

        this.truth.set(id, next);
        this.reconcile(id, next);
        this.dirty.add(id);
      }
    }
    if (ev.r) {
      for (const id of ev.r) {
        this.truth.delete(id);
        this.guess.delete(id);
        this.dirty.add(id);
      }
    }
    this.flush();
  }

  private reconcile(id: EntityId, truth: HaState) {
    const g = this.guess.get(id);
    if (!g) return;
    const stateAgrees = g.state === undefined || g.state === truth.state;
    const attrsAgree =
      !g.attributes ||
      Object.keys(g.attributes).every((k) => {
        const a = g.attributes![k], b = truth.attributes[k];
        // brightness/volume land within a rounding step of what we asked for
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 3;
        return a === b;
      });
    if (stateAgrees && attrsAgree) {
      this.guess.delete(id);
      emit({ type: 'settle', entity: id, ms: Date.now() - g.at, confirmed: true });
    }
  }

  // ── optimistic writes ─────────────────────────────────────────────────────
  /** Paint a predicted value right now. Returns immediately; no I/O. */
  predict(id: EntityId, state?: string, attributes?: Record<string, any>) {
    const prev = this.guess.get(id);
    this.guess.set(id, {
      state: state ?? prev?.state,
      attributes: attributes ? { ...(prev?.attributes ?? {}), ...attributes } : prev?.attributes,
      expires: Date.now() + Store.GRACE_MS,
      at: prev?.at ?? Date.now(),
    });
    emit({ type: 'predict', entity: id, state, attributes });
    this.dirty.add(id);
    // Synchronous, NOT rAF-batched. A prediction is always the direct result of
    // a tap: there is exactly one per gesture, so there is nothing to coalesce,
    // and deferring it to the next animation frame adds a whole frame of lag to
    // the one interaction where latency is most visible. Batching exists for
    // HA's inbound delta storms, not for user input.
    this.flushNow();
    this.armSweep();
  }

  /** Drop a prediction immediately (e.g. the service call was rejected). */
  rollback(id: EntityId) {
    if (this.guess.delete(id)) { this.dirty.add(id); this.flushNow(); }
  }

  /** Expire stale predictions so a failed command can't stick. */
  private armSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, g] of this.guess) {
        if (g.expires <= now) {
          this.guess.delete(id); this.dirty.add(id); changed = true;
          // expired without HA ever confirming — the command was probably lost
          emit({ type: 'settle', entity: id, ms: now - g.at, confirmed: false });
          this.onUnconfirmed?.(id);
        }
      }
      if (changed) this.flush();
      if (this.guess.size === 0) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    }, 500);
  }

  // ── batched dispatch ──────────────────────────────────────────────────────
  /** Coalesce every change in a tick into one rAF-aligned repaint. A Hue group
   *  turning on emits ~10 state_changed events in a few ms; without this we'd
   *  lay out ten times and drop frames on Mali-400. */
  private flush() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const ids = this.dirty;
      this.dirty = new Set();
      const called = new Set<Sub>();
      for (const id of ids) {
        const set = this.subs.get(id);
        if (!set) continue;
        const s = this.get(id);
        for (const cb of set) {
          // A tile watching 3 entities repaints once per frame, not 3 times.
          if (called.has(cb)) continue;
          called.add(cb);
          cb(s);
        }
      }
    });
  }

  /** Dispatch pending changes in the current task, cancelling any queued frame
   *  so a rAF flush can't run a second time over an already-empty set. */
  private flushNow() {
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
    const ids = this.dirty;
    this.dirty = new Set();
    const called = new Set<Sub>();
    for (const id of ids) {
      const set = this.subs.get(id);
      if (!set) continue;
      const s = this.get(id);
      for (const cb of set) {
        if (called.has(cb)) continue;
        called.add(cb);
        cb(s);
      }
    }
  }
}
