/** Tiny DOM helpers. Building elements imperatively rather than from HTML
 *  strings keeps references we can mutate later without re-parsing. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, html?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

export const frag = () => document.createDocumentFragment();

/** Set textContent only when it actually differs — avoids needless layout
 *  invalidation on a device where every reflow is expensive. */
export function text(n: Node, v: string) {
  if (n.textContent !== v) n.textContent = v;
}

/** Toggle a class only on change, same reasoning. */
export function cls(n: HTMLElement, name: string, on: boolean) {
  if (n.classList.contains(name) !== on) n.classList.toggle(name, on);
}

export interface Tile {
  el: HTMLElement;
  destroy(): void;
}

/** Danish number formatting: comma decimal separator. */
export function num(v: number | string | undefined, digits = 1): string {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (n == null || Number.isNaN(n)) return '–';
  return n.toFixed(digits).replace('.', ',');
}
