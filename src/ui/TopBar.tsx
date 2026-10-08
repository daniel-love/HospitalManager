import type { Game } from "@game/game";
import { SPEEDS, type Speed } from "@game/loop";
import { formatMoney } from "@game/tools";
import { hud, saveDialogOpen } from "./store";

const LABELS: Record<Speed, string> = { 0: "❚❚", 1: "1×", 2: "2×", 4: "4×", 8: "8×" };
const HINTS: Record<Speed, string> = {
  0: "Pause (Space)",
  1: "Normal speed (1)",
  2: "Fast (2)",
  4: "Faster (3)",
  8: "Fastest (4)",
};

// Don't take focus on click, or Space (pause) would re-press the button.
const noFocus = (e: MouseEvent) => e.preventDefault();

export function TopBar({ game }: { game: Game }) {
  const { clock, speed, money } = hud.value;
  return (
    <div class="topbar">
      <span class="clock">{clock}</span>
      <span class={`money${money < 0 ? " negative" : ""}`} title="Cash">
        {formatMoney(money)}
      </span>
      <div class="speeds" role="group" aria-label="Game speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            class={s === speed ? "active" : ""}
            title={HINTS[s]}
            aria-pressed={s === speed}
            onMouseDown={noFocus}
            onClick={() => game.setSpeed(s)}
          >
            {LABELS[s]}
          </button>
        ))}
      </div>
      <button
        class="menu-button"
        onMouseDown={noFocus}
        onClick={() => (saveDialogOpen.value = true)}
      >
        Save / Load
      </button>
    </div>
  );
}
