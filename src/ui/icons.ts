/**
 * Inline SVG icon set — 24×24, stroke-based.
 *
 * Inlined as path data rather than an icon font or sprite sheet: zero extra
 * requests, zero FOUT, and the whole set costs less than one HTTP round trip
 * on this hardware. Material Design Icons (what HA ships) is a ~700 KB font.
 */
const P: Record<string, string> = {
  // rooms
  home:    'M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5',
  kitchen: 'M4 3h16v18H4zM4 10h16M8 6.5h.01M8 14v3.5',
  sofa:    'M4 12V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4M2 12h20v6H2zM6 18v2M18 18v2',
  dining:  'M12 3v18M7 3v6a5 5 0 0 0 10 0V3M4 21h16',
  desk:    'M3 8h18M4 8v12M20 8v12M8 12h8v5H8z',
  bed:     'M3 18V7M3 12h18v6M3 18h18M7 12V9h4v3',
  child:   'M12 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM9 22v-5H7l2-6h6l2 6h-2v5',
  bath:    'M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM6 12V6a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2',

  // panel settings
  gear:    'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM12 2.5l1.4 2.6 2.9-.5.6 2.9 2.6 1.4-1.4 2.6 1.4 2.6-2.6 1.4-.6 2.9-2.9-.5L12 21.5l-1.4-2.6-2.9.5-.6-2.9-2.6-1.4L5.9 12 4.5 9.4l2.6-1.4.6-2.9 2.9.5z',
  wifi:    'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.6h.01M2 9a15 15 0 0 1 20 0',
  android: 'M4 10h16v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM7 10 5.5 6.5M17 10l1.5-3.5M9.5 7.5h.01M14.5 7.5h.01',
  refresh: 'M20.5 11a8.5 8.5 0 1 0-1 5M20.5 5.5V11h-5.5',

  // domains
  bulb:    'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6h5.4c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3z',
  thermo:  'M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0zM12 9v6',
  music:   'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',

  // transport
  play:  'M7 4.5v15l12-7.5z',
  pause: 'M8 4.5h3.5v15H8zM12.5 4.5H16v15h-3.5z',
  next:  'M6 5l9 7-9 7zM18 5v14',
  prev:  'M18 5l-9 7 9 7zM6 5v14',
  volume:'M11 5 6.5 9H3v6h3.5L11 19zM15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10',
  mute:  'M11 5 6.5 9H3v6h3.5L11 19zM16 10l5 4M21 10l-5 4',

  // controls
  plus:  'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  power: 'M12 3v9M6.5 6.8a8 8 0 1 0 11 0',
  moon:  'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  flame: 'M12 22a6 6 0 0 0 6-6c0-4-3-5-3-9 0 0-3 1.5-3 5 0-2-1.5-3-1.5-3S6 11 6 16a6 6 0 0 0 6 6z',
  book:  'M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5zM4 17h15',
  sunset:'M12 3v5M5 11 3.5 9.5M19 11l1.5-1.5M3 15h18M6.5 15a5.5 5.5 0 0 1 11 0M8 19h8',
  sun:   'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  drop:  'M12 3s6 6.3 6 10a6 6 0 0 1-12 0c0-3.7 6-10 6-10z',

  // status
  wifiOff: 'M3 3l18 18M8.5 12.5a6 6 0 0 1 4-1.4M5 9a11 11 0 0 1 5-2.6M19 9a11 11 0 0 0-6-2.9M12 19h.01M9.5 15.5a3.5 3.5 0 0 1 3-1',
  chevron: 'M9 6l6 6-6 6',
  dots:    'M5 12h.01M12 12h.01M19 12h.01',
};

/** Returns an <svg> string. `size` in px; stroke inherits `currentColor`. */
export function icon(name: string, size = 24, filled = false): string {
  const d = P[name] ?? P.dots;
  const fill = filled ? 'currentColor' : 'none';
  const stroke = filled ? 'none' : 'currentColor';
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" ` +
    `stroke-linejoin="round"><path d="${d}"/></svg>`
  );
}

export const hasIcon = (n: string) => n in P;
