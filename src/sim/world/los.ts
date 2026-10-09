/**
 * Line of sight (ARCHITECTURE §5.4): a raycast between tile centres.
 * Standard walls and doors (always shut, for now) block it; glazed walls
 * don't. Furniture is below eye level and never blocks.
 */
import { wallByType } from "@data/catalogue";
import { inBounds, tileIndex, WallType, type FloorGrid } from "./grid";

/** Whether a tile blocks sight. */
export function isOpaque(grid: FloorGrid, x: number, y: number): boolean {
  if (!inBounds(grid, x, y)) return true;
  const i = tileIndex(grid, x, y);
  if (grid.door[i] !== 0) return true;
  const wall = grid.wall[i]!;
  return wall !== WallType.None && (wallByType.get(wall)?.blocksSight ?? true);
}

/**
 * Whether tile (x1, y1) can be seen from tile (x0, y0). Walks the Bresenham
 * line between them; the end tiles themselves don't block. A diagonal step
 * squeezing between two opaque tiles (a wall corner) is blocked.
 */
export function hasLineOfSight(
  grid: FloorGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    const stepX = e2 >= dy;
    const stepY = e2 <= dx;
    if (stepX && stepY && isOpaque(grid, x + sx, y) && isOpaque(grid, x, y + sy)) return false;
    if (stepX) {
      err += dy;
      x += sx;
    }
    if (stepY) {
      err += dx;
      y += sy;
    }
    if ((x !== x1 || y !== y1) && isOpaque(grid, x, y)) return false;
  }
  return true;
}
