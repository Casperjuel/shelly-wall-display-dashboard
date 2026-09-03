import type { ConnState, EntitiesEvent } from './types';
import { emit } from '../ui/bus';

type Listener = (ev: EntitiesEvent) => void;
type StateListener = (s: ConnState, detail?: string) => void;

/**
 * Minimal Home Assistant WebSocket client.
 *
 * Deliberately NOT home-assistant-js-websocket: that library keeps a full
 * denormalised state map plus collection machinery we don't need, and pulls in
 * ~40 KB. On MTK6580 every kilobyte of parse time is visible. This is ~3 KB and
 * speaks the `subscribe_entities` compressed protocol directly, which sends
 * only deltas after the first frame.
 */
export class HaConnection {
  private ws: WebSocket | null = null;
  private id = 1;
  private entityListeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private pending = new Map<number, { ok: (v: any) => void; err: (e: any) => void }>();
  private retry = 0;
  private retryTimer: any = null;
  private pingTimer: any = null;
  private lastPong = 0;
  private closed = false;

  state: ConnState = 'idle';

  constructor(private url: string, private token: string) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────
  connect() {
    this.closed = false;
    this.open();
  }

  disconnect() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private setState(s: ConnState, detail?: string) {
    if (this.state === s) return;
    this.state = s;
    emit({ type: 'conn', state: s, detail });
    this.stateListeners.forEach((l) => l(s, detail));
  }

  private wsUrl(): string {
    const u = this.url.replace(/\/+$/, '');
    return u.replace(/^http/, 'ws') + '/api/websocket';
  }

  private open() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.setState(this.retry ? 'connecting' : 'connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch (e) {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      this.setState('lost');
      this.scheduleRetry();
    };
    ws.onerror = () => { /* onclose always follows */ };
  }

  /**
   * Exponential backoff capped at 15 s. These panels are always-on and the
   * router reboots at night; a tight retry loop would spin the CPU on a device
   * that has none to spare.
   */
  private scheduleRetry() {
    if (this.closed) return;
    const delay = Math.min(15000, 500 * Math.pow(1.7, this.retry++));
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private send(msg: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendWithId(msg: any): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, err) => {
      this.pending.set(id, { ok, err });
      this.send({ ...msg, id });
      // Don't leak pending entries if HA never answers.
      setTimeout(() => {
        if (this.pending.delete(id)) err(new Error('timeout'));
      }, 10000);
    });
  }

  private onMessage(ev: MessageEvent) {
    let msg: any;
    try { msg = JSON.parse(ev.data as string); } catch { return; }

    switch (msg.type) {
      case 'auth_required':
        this.setState('auth');
        this.send({ type: 'auth', access_token: this.token });
        return;

      case 'auth_invalid':
        this.setState('lost', 'auth_invalid');
        this.closed = true; // a bad token will never fix itself by retrying
        this.ws?.close();
        return;

      case 'auth_ok':
        this.retry = 0;
        this.subscribe();
        this.startHeartbeat();
        this.setState('ready');
        return;

      case 'event':
        if (msg.event) this.entityListeners.forEach((l) => l(msg.event as EntitiesEvent));
        return;

      case 'pong':
        this.lastPong = Date.now();
        {
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); p.ok(null); }
        }
        return;

      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.success ? p.ok(msg.result) : p.err(msg.error);
        return;
      }
    }
  }

  private subscribe() {
    // `subscribe_entities` gives one full snapshot then compressed diffs.
    this.send({ id: ++this.id, type: 'subscribe_entities' });
  }

  /**
   * WebSockets on this hardware can half-open silently (Wi-Fi sleep, AP
   * roam) — the socket looks OPEN but nothing arrives. Ping every 20 s and
   * force a reconnect if two go unanswered.
   */
  private startHeartbeat() {
    clearInterval(this.pingTimer);
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > 55000) {
        this.ws?.close();
        return;
      }
      this.sendWithId({ type: 'ping' }).catch(() => {});
    }, 20000);
  }

  // ── public API ────────────────────────────────────────────────────────────
  onEntities(l: Listener) { this.entityListeners.add(l); return () => this.entityListeners.delete(l); }
  onState(l: StateListener) { this.stateListeners.add(l); l(this.state); return () => this.stateListeners.delete(l); }

  callService(domain: string, service: string, target?: any, data?: Record<string, any>) {
    return this.sendWithId({
      type: 'call_service',
      domain,
      service,
      service_data: data,
      target,
    });
  }
}
