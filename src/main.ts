import { h, render } from "preact";
import { Game } from "@game/game";
import { Renderer } from "@render/renderer";
import { loadLastSave } from "@save/saveManager";
import { createSimState } from "@sim/state";
import { siteView } from "@sim/world/site";
import { App } from "@ui/App";
import { showToast } from "@ui/store";
import "@ui/styles.css";

/** Seed from `?seed=123` for reproducible runs, otherwise null. */
function seedParam(): number | null {
  const param = new URLSearchParams(location.search).get("seed");
  return param !== null && /^\d+$/.test(param) ? Number(param) >>> 0 : null;
}

async function main(): Promise<void> {
  const seed = seedParam();
  const state = createSimState({
    seed: seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!,
    site: true,
  });
  const renderer = await Renderer.create(document.getElementById("game")!, state);
  const game = new Game(state, renderer);
  if (state.site) game.focus(siteView(state.site));
  render(h(App, { game }), document.getElementById("ui")!);

  // Resume the last save written or loaded, unless a seed asks for a fresh run.
  if (seed === null) {
    try {
      const last = await loadLastSave();
      if (last) {
        game.loadState(last.state, last.name);
        showToast(`Resumed "${last.name}"`);
      }
    } catch (err) {
      console.error(err);
      showToast("Couldn't resume your last save, so this is a new game", "error");
    }
  }

  if (import.meta.env.DEV) {
    // Handy from the browser console: `__game.state`, `__game.setSpeed(8)`.
    (window as unknown as { __game: Game }).__game = game;
  }
}

void main();
