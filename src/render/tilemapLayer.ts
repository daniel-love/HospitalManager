/**
 * Draws a floor grid (ground, zone tints, walls and doors) as 32×32-tile
 * chunks. Each chunk is built once as vector geometry and only rebuilt when a
 * build command marks it dirty, and chunks outside the camera view are hidden
 * so the GPU skips them.
 */
import { Container, Graphics } from "pixi.js";
import { roomByCode } from "@data/catalogue";
import { FloorType, isWallOrDoor, tileIndex, WallType, type FloorGrid } from "@sim/world/grid";
import type { Rect } from "@sim/world/rect";
import { CHUNK_TILES, TILE_SIZE } from "./constants";
import {
  DOOR_COLOUR,
  FLOOR_COLOUR,
  GLASS_COLOUR,
  GRASS_SHADES,
  PATH_COLOUR,
  ROAD_COLOUR,
  WALL_COLOUR,
  ZONE_ALPHA,
} from "./palette";

const GRID_LINE_COLOUR = 0x000000;

interface Chunk {
  cx: number;
  cy: number;
  tiles: Graphics;
  lines: Graphics;
  dirty: boolean;
}

/** Cheap stable hash so grass shading varies per tile without touching sim RNG. */
function tileHash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export class TilemapLayer {
  readonly container = new Container();
  private readonly chunks: Chunk[] = [];
  private readonly chunksX: number;
  private readonly chunksY: number;
  visibleChunkCount = 0;

  constructor(private readonly grid: FloorGrid) {
    this.chunksX = Math.ceil(grid.width / CHUNK_TILES);
    this.chunksY = Math.ceil(grid.height / CHUNK_TILES);
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        const tiles = new Graphics();
        const lines = new Graphics();
        this.container.addChild(tiles, lines);
        this.chunks.push({ cx, cy, tiles, lines, dirty: true });
      }
    }
  }

  /** Marks every chunk overlapping the rect (grown by one tile) for rebuild. */
  markDirty(r: Rect): void {
    const cx0 = Math.max(0, Math.floor((r.x - 1) / CHUNK_TILES));
    const cy0 = Math.max(0, Math.floor((r.y - 1) / CHUNK_TILES));
    const cx1 = Math.min(this.chunksX - 1, Math.floor((r.x + r.w) / CHUNK_TILES));
    const cy1 = Math.min(this.chunksY - 1, Math.floor((r.y + r.h) / CHUNK_TILES));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) this.chunks[cy * this.chunksX + cx]!.dirty = true;
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  /** Rebuilds dirty chunks, culls to the view and fades grid lines when zoomed out. */
  update(view: { x: number; y: number; width: number; height: number }, zoom: number): void {
    const chunkPx = CHUNK_TILES * TILE_SIZE;
    const lineAlpha = zoom < 0.35 ? 0 : Math.min(0.18, (zoom - 0.35) * 0.4);
    let visible = 0;
    for (const chunk of this.chunks) {
      const x0 = chunk.cx * chunkPx;
      const y0 = chunk.cy * chunkPx;
      const onScreen =
        x0 < view.x + view.width &&
        x0 + chunkPx > view.x &&
        y0 < view.y + view.height &&
        y0 + chunkPx > view.y;
      chunk.tiles.visible = onScreen;
      chunk.lines.visible = onScreen && lineAlpha > 0;
      chunk.lines.alpha = lineAlpha;
      if (!onScreen) continue;
      visible++;
      if (chunk.dirty) this.rebuild(chunk);
    }
    this.visibleChunkCount = visible;
  }

  private rebuild(chunk: Chunk): void {
    const { grid } = this;
    const T = TILE_SIZE;
    const tx0 = chunk.cx * CHUNK_TILES;
    const ty0 = chunk.cy * CHUNK_TILES;
    const tx1 = Math.min(tx0 + CHUNK_TILES, grid.width);
    const ty1 = Math.min(ty0 + CHUNK_TILES, grid.height);

    const g = chunk.tiles.clear();
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        const i = tileIndex(grid, x, y);
        const px = x * T;
        const py = y * T;
        const surface = grid.floorType[i];
        if (surface === FloorType.Floor) {
          g.rect(px, py, T, T).fill(FLOOR_COLOUR);
          const room = roomByCode.get(grid.zone[i]!);
          if (room) g.rect(px, py, T, T).fill({ color: room.colour, alpha: ZONE_ALPHA });
        } else if (surface === FloorType.Path) {
          g.rect(px, py, T, T).fill(PATH_COLOUR);
        } else if (surface === FloorType.Road) {
          g.rect(px, py, T, T).fill(ROAD_COLOUR);
        } else {
          g.rect(px, py, T, T).fill(GRASS_SHADES[tileHash(x, y) % GRASS_SHADES.length]!);
        }

        const wall = grid.wall[i];
        if (wall === WallType.Standard) {
          g.rect(px, py, T, T).fill(WALL_COLOUR);
        } else if (wall === WallType.Glass) {
          g.rect(px, py, T, T).fill(FLOOR_COLOUR);
          g.rect(px + 2, py + 2, T - 4, T - 4).fill({ color: GLASS_COLOUR, alpha: 0.9 });
          g.rect(px, py, T, T).stroke({ width: 2, color: WALL_COLOUR, alignment: 1 });
        } else if (grid.door[i] !== 0) {
          this.drawDoor(g, x, y);
        }
      }
    }

    const l = chunk.lines.clear();
    for (let x = tx0; x <= tx1; x++) {
      l.moveTo(x * T, ty0 * T).lineTo(x * T, ty1 * T);
    }
    for (let y = ty0; y <= ty1; y++) {
      l.moveTo(tx0 * T, y * T).lineTo(tx1 * T, y * T);
    }
    l.stroke({ width: 1, color: GRID_LINE_COLOUR, pixelLine: true });

    chunk.dirty = false;
  }

  /** A door is a gap in the wall with a door leaf drawn along the wall's line. */
  private drawDoor(g: Graphics, x: number, y: number): void {
    const { grid } = this;
    const T = TILE_SIZE;
    const solid = (tx: number, ty: number) =>
      tx >= 0 &&
      ty >= 0 &&
      tx < grid.width &&
      ty < grid.height &&
      isWallOrDoor(grid, tileIndex(grid, tx, ty));
    const horizontal = solid(x - 1, y) || solid(x + 1, y);
    const px = x * T;
    const py = y * T;
    g.rect(px, py, T, T).fill(FLOOR_COLOUR);
    const leaf = T * 0.22;
    if (horizontal) {
      g.rect(px, py, T, 3).fill(WALL_COLOUR);
      g.rect(px, py + T - 3, T, 3).fill(WALL_COLOUR);
      g.rect(px, py + (T - leaf) / 2, T, leaf).fill(DOOR_COLOUR);
    } else {
      g.rect(px, py, 3, T).fill(WALL_COLOUR);
      g.rect(px + T - 3, py, 3, T).fill(WALL_COLOUR);
      g.rect(px + (T - leaf) / 2, py, leaf, T).fill(DOOR_COLOUR);
    }
  }
}
