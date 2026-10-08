/**
 * Mouse and keyboard camera controls:
 * - drag to pan: right or middle button always, left button when no build
 *   tool is selected (a build tool uses left-drag itself), and Ctrl/⌘ + left
 *   drag at any time, so you can pan mid-build without changing tool
 * - mouse wheel / trackpad pinch to zoom around the cursor
 * - WASD or arrow keys to pan (hold Shift for faster)
 */
import type { Renderer } from "./renderer";

const KEY_PAN_PX_PER_SEC = 900;
const DRAG_THRESHOLD_PX = 3;

const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

export interface CameraControlOptions {
  /** Whether a drag starting with this press should pan. */
  canPan: (e: PointerEvent) => boolean;
  /** A press and release without dragging (screen coordinates). */
  onClick: (button: number, x: number, y: number) => void;
}

/** Ctrl (or ⌘ on a Mac) held: the mouse pans instead of building. */
export function isPanModifier(e: MouseEvent | KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

export class CameraControls {
  private readonly held = new Set<string>();
  private drag: {
    id: number;
    button: number;
    /** Started with Ctrl/⌘ held: a pan gesture, never a click. */
    modified: boolean;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly renderer: Renderer,
    private readonly opts: CameraControlOptions,
  ) {
    const canvas = renderer.app.canvas;
    const listen = { signal: this.abort.signal };

    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), listen);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { ...listen, passive: false });
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e), listen);
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e), listen);
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e), listen);
    canvas.addEventListener("pointercancel", () => (this.drag = null), listen);
    canvas.addEventListener("pointerleave", () => renderer.setPointer(null), listen);

    window.addEventListener("keydown", (e) => this.onKey(e, true), listen);
    window.addEventListener("keyup", (e) => this.onKey(e, false), listen);
    window.addEventListener(
      "blur",
      () => {
        this.held.clear();
        this.setCursor();
      },
      listen,
    );
  }

  /** True while the mouse is dragging the view. */
  get dragging(): boolean {
    return this.drag?.moved ?? false;
  }

  /** Applies held-key panning. Call once per frame with real elapsed ms. */
  update(realDtMs: number): void {
    let dx = 0;
    let dy = 0;
    for (const code of this.held) {
      const dir = PAN_KEYS[code];
      if (dir) {
        dx += dir[0];
        dy += dir[1];
      }
    }
    if (dx === 0 && dy === 0) return;
    const fast = this.held.has("ShiftLeft") || this.held.has("ShiftRight") ? 2.5 : 1;
    const px = (KEY_PAN_PX_PER_SEC * fast * realDtMs) / 1000;
    // Keys move the view, so the world moves the opposite way to a drag.
    this.renderer.camera.panByScreen(-dx * px, -dy * px);
  }

  destroy(): void {
    this.abort.abort();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // deltaMode 1 = lines (some mice); normalise to pixels.
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    // Trackpad pinch arrives as a wheel event with ctrlKey and small deltas.
    const sensitivity = e.ctrlKey ? 0.01 : 0.0015;
    this.renderer.camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-delta * sensitivity));
    this.renderer.setPointer({ x: e.offsetX, y: e.offsetY });
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.drag) return;
    if (!this.opts.canPan(e)) return;
    this.drag = {
      id: e.pointerId,
      button: e.button,
      modified: isPanModifier(e),
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
    this.renderer.app.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    this.renderer.setPointer({ x: e.offsetX, y: e.offsetY });
    const drag = this.drag;
    // Modifier keys can change while focus is elsewhere; trust the event.
    if (!drag?.moved) this.setCursor(isPanModifier(e) ? "grab" : "");
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) this.setCursor("grabbing");
    drag.moved = true;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    this.renderer.camera.panByScreen(dx, dy);
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (drag?.id !== e.pointerId) return;
    this.drag = null;
    this.setCursor(isPanModifier(e) ? "grab" : "");
    if (!drag.moved && !drag.modified) this.opts.onClick(drag.button, e.offsetX, e.offsetY);
    if (this.renderer.app.canvas.hasPointerCapture(e.pointerId)) {
      this.renderer.app.canvas.releasePointerCapture(e.pointerId);
    }
  }

  private setCursor(cursor = ""): void {
    const style = this.renderer.app.canvas.style;
    if (style.cursor !== cursor) style.cursor = cursor;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (down) this.held.add(e.code);
    else this.held.delete(e.code);
    if (!this.drag?.moved) this.setCursor(isPanModifier(e) ? "grab" : "");
    if (PAN_KEYS[e.code]) e.preventDefault();
  }
}
