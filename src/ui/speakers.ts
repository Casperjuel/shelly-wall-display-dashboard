import { el, text, cls, type Tile } from './dom';
import { icon } from './icons';
import { bindPress } from './press';
import { K, type Ctx } from './tiles';

/**
 * Speaker picker and grouping for the Musik tab.
 *
 * rooms.yaml pins one speaker per room, which is right for the common case —
 * you walk into a room and press play. But grouping is a runtime fact, not a
 * configured one: which speakers are playing together changes constantly, from
 * the Sonos app, from another panel, or from a voice assistant. So the list is
 * built from live state rather than from the manifest.
 *
 * The store holds every entity in the house (`subscribe_entities` is sent with
 * no filter), so discovery costs nothing extra — no additional subscription, no
 * extra round trip.
 *
 * Two gestures, deliberately distinct:
 *   tap the name   — control that speaker from this panel
 *   tap the badge  — join it to, or remove it from, this room's group
 */

/** Sonos speakers expose `group_members`; the panel's own speaker does not. */
function sonosSpeakers(ctx: Ctx): string[] {
  return ctx.store
    .ids('media_player')
    .filter((id) => Array.isArray(ctx.store.get(id)?.attributes?.group_members))
    .sort();
}

const nameOf = (ctx: Ctx, id: string) =>
  ctx.store.attr<string>(id, 'friendly_name', '') || id.replace('media_player.', '');

export function buildSpeakerRow(
  ctx: Ctx,
  roomEntity: string | undefined,
  key: string,
  onTarget: (entity: string) => void,
): Tile & { target: () => string | undefined } {
  const root = el('div', 'spk-row scroll');
  let target = roomEntity;
  let lastSig = '';

  const render = () => {
    const speakers = sonosSpeakers(ctx);

    // Only rebuild when something actually changed. This runs on every state
    // push for any media_player in the house, and blowing away the row on each
    // volume tick would fight the user's finger.
    const sig = speakers
      .map((id) => `${id}:${ctx.store.get(id)?.state}:${(ctx.actions.groupOf(id) || []).join('+')}`)
      .join('|') + `#${target}`;
    if (sig === lastSig) return;
    lastSig = sig;

    root.textContent = '';

    // Hide only when there is genuinely nothing to choose. One Sonos still
    // matters if it is not this room's speaker: the bedroom panel's own
    // media_player cannot play favourites, so being able to drive the living
    // room's Sonos from here is the whole point rather than an edge case.
    const worthShowing =
      speakers.length > 1 || (speakers.length === 1 && speakers[0] !== roomEntity);
    if (!worthShowing) {
      cls(root, 'hidden', true);
      return;
    }
    cls(root, 'hidden', false);

    const myGroup = target ? ctx.actions.groupOf(target) : [];

    for (const id of speakers) {
      const chip = el('div', 'spk');
      const active = id === target;
      const grouped = myGroup.includes(id) && myGroup.length > 1;
      cls(chip, 'active', active);
      cls(chip, 'grouped', grouped);

      const pick = el('button', 'spk-pick press');
      pick.dataset.key = K(key, 'spk', id.replace('media_player.', ''));
      const dot = el('span', 'spk-dot');
      cls(dot, 'playing', ctx.store.get(id)?.state === 'playing');
      const label = el('span', 'spk-name');
      text(label, nameOf(ctx, id));
      pick.append(dot, label);
      bindPress(pick, () => { target = id; onTarget(id); lastSig = ''; render(); }, { immediate: true });

      chip.append(pick);

      // Grouping badge. Hidden on the speaker you are currently controlling —
      // a speaker cannot be joined to itself, and unjoining the coordinator
      // from its own group is not a thing you can express here.
      if (!active && target) {
        const badge = el('button', 'spk-badge press');
        badge.dataset.key = K(key, 'spk.group', id.replace('media_player.', ''));
        badge.innerHTML = icon(grouped ? 'minus' : 'plus', 15);
        bindPress(badge, () => {
          if (grouped) ctx.actions.unjoinSpeaker(id);
          else ctx.actions.joinSpeakers(target!, [id]);
        }, { immediate: true });
        chip.append(badge);
      }

      root.append(chip);
    }
  };

  // Re-render on any media_player change: grouping shows up as an attribute
  // change on several entities at once, so watching only the room's speaker
  // would miss half of it.
  //
  // The subscription has to be re-taken as entities appear. Panels are built
  // before connect(), so at construction the store is empty and subscribing to
  // "every media_player" subscribes to nothing — the picker would stay blank
  // until something else forced a render.
  const watch = () => ctx.store.ids('media_player');
  let off = ctx.store.subscribe(watch(), render);
  const rewatch = () => {
    off();
    off = ctx.store.subscribe(watch(), render);
    lastSig = '';
    render();
  };

  // The first snapshot arrives with `ready`; that is when the speakers appear.
  const offConn = ctx.conn.onState((st) => { if (st === 'ready') rewatch(); });

  // And again periodically, since Home Assistant discovers speakers over time
  // (a Sonos that was powered off, a new one added). Cheap: a map scan.
  const timer = setInterval(rewatch, 15000);

  render();

  return {
    el: root,
    target: () => target,
    destroy() {
      off();
      offConn();
      clearInterval(timer);
    },
  };
}
