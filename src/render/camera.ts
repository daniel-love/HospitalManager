/**
 * 2D camera: which part of the world is on screen and how zoomed in it is.
 * Pure maths with no Pixi dependency so it can be unit-tested.
 *
 * (x, y) is the world point shown at the centre of the viewport.
 */

export interface CameraOptions {
  minZoom: number;
  maxZoom: number;
  /** World-space rectangle the camera centre is kept inside. */
  bounds: { width: number; height: number };
}

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  viewportWidth = 1;
  viewportHeight = 1;

  constructor(private readonly opts: CameraOptions) {}

  /** Changes the world size (e.g. after loading a save with a different map). */
  setBounds(width: number, height: number): void {
    this.opts.bounds = { width, height };
    this.centreOn(width / 2, height / 2);
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  centreOn(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clamp();
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + this.viewportWidth / 2,
      y: (wy - this.y) * this.zoom + this.viewportHeight / 2,
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewportWidth / 2) / this.zoom + this.x,
      y: (sy - this.viewportHeight / 2) / this.zoom + this.y,
    };
  }

  /** Moves the view by a screen-space delta (e.g. a mouse drag). */
  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** Zooms by `factor`, keeping the world point under (sx, sy) fixed on screen. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.opts.maxZoom, Math.max(this.opts.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  /** World-space rectangle currently visible, for culling. */
  visibleWorldRect(): { x: number; y: number; width: number; height: number } {
    const tl = this.screenToWorld(0, 0);
    return {
      x: tl.x,
      y: tl.y,
      width: this.viewportWidth / this.zoom,
      height: this.viewportHeight / this.zoom,
    };
  }

  private clamp(): void {
    this.x = Math.min(this.opts.bounds.width, Math.max(0, this.x));
    this.y = Math.min(this.opts.bounds.height, Math.max(0, this.y));
  }
}
