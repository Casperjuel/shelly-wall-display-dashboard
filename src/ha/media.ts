import type { HaConnection } from './connection';

export interface Favourite {
  title: string;
  /** artwork URL, when the source provides one */
  thumbnail?: string;
  /** the folder it came from — "Playlists", "Tracks", … */
  group?: string;
}

/**
 * A speaker's favourites, with artwork.
 *
 * `source_list` on the media_player entity gives only names. Home Assistant's
 * media browser gives the same items *with* cover art, which is the difference
 * between a row of text pills and something you can actually pick from at a
 * glance across a room.
 *
 * The tree is Favorites → {Playlists, Tracks, …} → items, so this walks one
 * level of folders and flattens. Results are cached per entity: favourites
 * change when somebody edits them in the Sonos app, not on a timer, and a
 * wall panel should not re-walk this on every render.
 */
const cache = new Map<string, { at: number; items: Favourite[] }>();
const TTL_MS = 30 * 60 * 1000;

export async function browseFavourites(
  conn: HaConnection,
  entity: string,
  { force = false } = {}
): Promise<Favourite[]> {
  const hit = cache.get(entity);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.items;

  try {
    const root: any = await conn.browseMedia(entity);
    const favs = (root?.children ?? []).find(
      (c: any) => c.media_content_type === 'favorites'
    );
    if (!favs) return [];

    const folders: any = await conn.browseMedia(
      entity, favs.media_content_type, favs.media_content_id
    );

    const items: Favourite[] = [];
    for (const folder of folders?.children ?? []) {
      // A folder here is "Playlists" / "Tracks"; a leaf is already an item.
      if (!/folder/i.test(folder.media_content_type ?? '')) {
        items.push({ title: folder.title, thumbnail: folder.thumbnail || undefined });
        continue;
      }
      const sub: any = await conn.browseMedia(
        entity, folder.media_content_type, folder.media_content_id
      ).catch(() => null);
      for (const c of sub?.children ?? []) {
        items.push({
          title: c.title,
          thumbnail: c.thumbnail || undefined,
          group: folder.title,
        });
      }
    }
    cache.set(entity, { at: Date.now(), items });
    return items;
  } catch {
    // Not every media player implements the browser. Callers fall back to the
    // favourites configured in rooms.yaml.
    cache.set(entity, { at: Date.now(), items: [] });
    return [];
  }
}
