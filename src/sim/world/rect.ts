/** Axis-aligned tile rectangles, as produced by drag-to-build tools. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The rectangle spanning two corner tiles, in either drag direction. */
export function rectFromCorners(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}

/** Clips a rectangle to a w×h grid; may return an empty (w or h ≤ 0) rect. */
export function clipRect(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(width, r.x + r.w);
  const y1 = Math.min(height, r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectTiles(r: Rect): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  return out;
}

/** The perimeter tiles of a rectangle (a 1-wide rect gives a straight line). */
export function outlineTiles(r: Rect): { x: number; y: number }[] {
  if (r.w <= 0 || r.h <= 0) return [];
  if (r.w <= 2 || r.h <= 2) return rectTiles(r);
  const out: { x: number; y: number }[] = [];
  for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y: r.y }, { x, y: r.y + r.h - 1 });
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) out.push({ x: r.x, y }, { x: r.x + r.w - 1, y });
  return out;
}

/** Smallest rect covering both (either may be null). */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}
