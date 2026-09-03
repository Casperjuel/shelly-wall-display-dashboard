import type { HaConnection } from './connection';
import type { Store } from './store';
import { emit } from '../ui/bus';

/**
 * Every action here follows the same shape: predict locally, then fire.
 * The predict() call is synchronous and repaints on the next frame, so the
 * pixel changes ~16 ms after the finger lands regardless of what the network,
 * the Hue bridge or the Wavin controller are doing.
 */
export class Actions {
  constructor(private conn: HaConnection, private store: Store) {}

  private fire(domain: string, service: string, entity: string, data?: Record<string, any>) {
    emit({ type: 'action', entity, service: `${domain}.${service}`, data });
    this.conn
      .callService(domain, service, { entity_id: entity }, data)
      .catch(() => this.store.rollback(entity));
  }

  // ── lys ───────────────────────────────────────────────────────────────────
  toggleLight(entity: string) {
    const on = this.store.isOn(entity);
    this.store.predict(entity, on ? 'off' : 'on');
    this.fire('light', on ? 'turn_off' : 'turn_on', entity);
  }

  /** brightness as 0–100 %. */
  setBrightness(entity: string, pct: number) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (p === 0) {
      this.store.predict(entity, 'off');
      this.fire('light', 'turn_off', entity);
      return;
    }
    this.store.predict(entity, 'on', { brightness: Math.round((p / 100) * 255) });
    this.fire('light', 'turn_on', entity, { brightness_pct: p });
  }

  brightnessPct(entity: string): number {
    if (!this.store.isOn(entity)) return 0;
    const b = this.store.attr<number>(entity, 'brightness', 255);
    return Math.round((b / 255) * 100);
  }

  setLightsInBulk(entities: string[], on: boolean) {
    for (const e of entities) this.store.predict(e, on ? 'on' : 'off');
    emit({ type: 'action', entity: entities, service: `light.turn_${on ? 'on' : 'off'}` });
    this.conn
      .callService('light', on ? 'turn_on' : 'turn_off', { entity_id: entities })
      .catch(() => entities.forEach((e) => this.store.rollback(e)));
  }

  // ── varme (Wavin) ─────────────────────────────────────────────────────────
  setTemperature(entity: string, temp: number) {
    this.store.predict(entity, undefined, { temperature: temp });
    this.fire('climate', 'set_temperature', entity, { temperature: temp });
  }

  nudgeTemperature(entity: string, delta: number, min: number, max: number, step: number) {
    const cur = this.store.attr<number>(entity, 'temperature', 21);
    const next = Math.max(min, Math.min(max, Math.round((cur + delta) / step) * step));
    if (next === cur) return next;
    this.setTemperature(entity, next);
    return next;
  }

  setHvacMode(entity: string, mode: string) {
    this.store.predict(entity, mode);
    this.fire('climate', 'set_hvac_mode', entity, { hvac_mode: mode });
  }

  // ── musik (Sonos) ─────────────────────────────────────────────────────────
  playPause(entity: string) {
    const playing = this.store.get(entity)?.state === 'playing';
    this.store.predict(entity, playing ? 'paused' : 'playing');
    this.fire('media_player', playing ? 'media_pause' : 'media_play', entity);
  }

  next(entity: string) { this.fire('media_player', 'media_next_track', entity); }
  prev(entity: string) { this.fire('media_player', 'media_previous_track', entity); }

  /** volume as 0–100 %. */
  setVolume(entity: string, pct: number) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    this.store.predict(entity, undefined, { volume_level: p / 100 });
    this.fire('media_player', 'volume_set', entity, { volume_level: p / 100 });
  }

  volumePct(entity: string): number {
    return Math.round(this.store.attr<number>(entity, 'volume_level', 0) * 100);
  }

  toggleMute(entity: string) {
    const muted = this.store.attr<boolean>(entity, 'is_volume_muted', false);
    this.store.predict(entity, undefined, { is_volume_muted: !muted });
    this.fire('media_player', 'volume_mute', entity, { is_volume_muted: !muted });
  }

  selectSource(entity: string, source: string) {
    this.store.predict(entity, 'playing', { source });
    this.fire('media_player', 'select_source', entity, { source });
  }

  /**
   * Set the panel's own backlight.
   *
   * Goes straight to the Shelly RPC on the device rather than through Home
   * Assistant: the panel is talking about *itself*, the call is local, and it
   * must keep working even when HA is down — a child's sleep clock going to
   * full brightness because the server rebooted is exactly the failure we
   * cannot have. Fire-and-forget; a failed dim is not worth surfacing.
   */
  setPanelBrightness(pct: number) {
    const level = Math.max(0, Math.min(100, Math.round(pct)));
    emit({ type: 'action', entity: 'panel', service: 'Ui.SetConfig', data: { brightness: level } });
    fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1, method: 'Ui.SetConfig',
        params: { config: { brightness: { auto: false, level } } },
      }),
    }).catch(() => { /* not served from the panel's own origin; ignore */ });
  }

  // ── scener ────────────────────────────────────────────────────────────────
  activateScene(entity: string) {
    // Scenes have no meaningful on/off state; the visual ack is handled by the
    // tile's own press animation rather than a store prediction.
    emit({ type: 'action', entity, service: 'scene.turn_on' });
    this.conn.callService('scene', 'turn_on', { entity_id: entity }).catch(() => {});
  }

  runScript(entity: string) {
    this.conn.callService('script', 'turn_on', { entity_id: entity }).catch(() => {});
  }
}
