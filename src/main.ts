import { h, render } from "preact";
import { Game } from "@game/game";
import { Renderer } from "@render/renderer";
import { createSimState } from "@sim/state";
import { App } from "@ui/App";
import "@ui/styles.css";

/** Seed from `?seed=123` for reproducible runs, otherwise random. */
function chooseSeed(): number {
  const param = new URLSearchParams(location.search).get("seed");
  if (param !== null && /^\d+$/.test(param)) return Number(param) >>> 0;
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

async function main(): Promise<void> {
  const state = createSimState({ seed: chooseSeed() });
  const renderer = await Renderer.create(document.getElementById("game")!, state);
  const game = new Game(state, renderer);
  render(h(App, { game }), document.getElementById("ui")!);

  if (import.meta.env.DEV) {
    // Handy from the browser console: `__game.state`, `__game.setSpeed(8)`.
    (window as unknown as { __game: Game }).__game = game;
  }
}

void main();
