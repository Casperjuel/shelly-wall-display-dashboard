import type { Mood } from './gradient';
import { scenePageWash, sceneScrim } from './gradient';
import type { ThemeController } from './theme';

const LS_KEY = 'hjem.mood';

export interface MoodWash {
  /** Adopt a scene's light. Pass null to fall back to the room accent wash. */
  set(mood: Mood | null, sceneId?: string | null): void;
  /** id of the scene currently reflected, if any */
  activeScene(): string | null;
  onChange(cb: (sceneId: string | null) => void): () => void;
  destroy(): void;
}

/**
 * Whole-panel feedback for scene activation.
 *
 * `background-image` is not an animatable property, so a single layer would
 * snap. Instead there are two stacked layers and we crossfade their opacity —
 * opacity is compositor-only, which is the one kind of animation Mali-400
 * handles without complaint.
 *
 * The wash persists after the tap: the scene is still on, so the panel should
 * keep reflecting it. That makes the background a readable indicator of what
 * the room is currently doing, not just a 300 ms flourish.
 */
export function createMoodWash(theme: ThemeController, roomSlug: string): MoodWash {
  const layers: HTMLDivElement[] = [];
  for (let i = 0; i < 2; i++) {
    const d = document.createElement('div');
    d.className = 'mood-wash';
    document.body.appendChild(d);
    layers.push(d);
  }
  const scrim = document.createElement('div');
  scrim.className = 'mood-scrim';
  document.body.appendChild(scrim);

  let front = 0;
  let current: Mood | null = null;
  let currentScene: string | null = null;
  const listeners = new Set<(s: string | null) => void>();

  const paint = (mood: Mood | null, animate: boolean) => {
    const dark = theme.current() === 'dark';
    const back = 1 - front;

    if (!mood) {
      layers[front].style.opacity = '0';
      layers[back].style.opacity = '0';
      scrim.style.backgroundColor = 'transparent';
      return;
    }

    layers[back].style.backgroundImage = scenePageWash(mood, dark);
    if (!animate) {
      layers[back].style.transition = 'none';
      // force style flush so the disabled transition actually applies
      void layers[back].offsetHeight;
    }
    layers[back].style.opacity = '1';
    layers[front].style.opacity = '0';
    if (!animate) {
      void layers[back].offsetHeight;
      layers[back].style.transition = '';
    }
    scrim.style.backgroundColor = sceneScrim(mood, dark);
    front = back;
  };

  // restore whatever scene was last activated on this panel
  let restored: { mood: Mood; scene: string } | null = null;
  try {
    const raw = localStorage.getItem(LS_KEY + '.' + roomSlug);
    if (raw) restored = JSON.parse(raw);
  } catch { /* private mode / corrupt value */ }
  if (restored) { current = restored.mood; currentScene = restored.scene; paint(current, false); }

  const offTheme = theme.onChange(() => paint(current, true));

  return {
    set(mood, sceneId = null) {
      current = mood;
      currentScene = mood ? sceneId : null;
      paint(mood, true);
      try {
        if (mood && sceneId) localStorage.setItem(LS_KEY + '.' + roomSlug, JSON.stringify({ mood, scene: sceneId }));
        else localStorage.removeItem(LS_KEY + '.' + roomSlug);
      } catch { /* storage unavailable; the wash still works for this session */ }
      listeners.forEach((cb) => cb(currentScene));
    },
    activeScene: () => currentScene,
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    destroy() { offTheme(); layers.forEach((l) => l.remove()); scrim.remove(); },
  };
}
