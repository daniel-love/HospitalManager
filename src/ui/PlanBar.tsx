/**
 * Plan mode status: what the plan contains, what it costs against the cash
 * available, and the actions to undo, clear or build it. A smaller reminder
 * shows when a saved plan exists but plan mode is off.
 */
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import { hud, planning, planSummary } from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

export function PlanBar({ game }: { game: Game }) {
  const { steps, cost } = planSummary.value;
  const money = hud.value.money;
  const changes = steps === 1 ? "1 change" : `${steps} changes`;

  if (!planning.value) {
    if (steps === 0) return null;
    return (
      <div class="planbar">
        Saved plan: {changes} · {formatMoney(cost)}
        <button onMouseDown={noFocus} onClick={() => game.setPlanning(true)}>
          Open plan
        </button>
      </div>
    );
  }

  const affordable = cost <= money;
  return (
    <div class="planbar planning" role="region" aria-label="Plan">
      <div class="planbar-text">
        <strong>Planning</strong>
        <span class="dim">Nothing is built or paid for until you build the plan.</span>
      </div>
      <div class={`planbar-cost${affordable ? "" : " bad"}`}>
        {steps === 0 ? "No changes yet" : `${changes} · ${formatMoney(cost)}`}
        {!affordable && <span> (you have {formatMoney(money)})</span>}
      </div>
      <button
        onMouseDown={noFocus}
        disabled={steps === 0}
        title="Undo the last planned change (Ctrl/⌘+Z)"
        onClick={() => game.undoPlan()}
      >
        Undo
      </button>
      <button
        onMouseDown={noFocus}
        disabled={steps === 0}
        onClick={() => confirm("Clear the whole plan?") && game.clearPlan()}
      >
        Clear
      </button>
      <button
        class="primary"
        onMouseDown={noFocus}
        disabled={steps === 0 || !affordable}
        title={
          affordable ? "Build everything in the plan now" : "You can't afford the whole plan yet"
        }
        onClick={() => game.buildPlan()}
      >
        Build plan
      </button>
      <button
        onMouseDown={noFocus}
        title="Leave plan mode (P). The plan is kept."
        onClick={() => game.setPlanning(false)}
      >
        Done
      </button>
    </div>
  );
}
