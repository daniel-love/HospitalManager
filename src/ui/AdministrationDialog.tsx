/**
 * A Private Hospital that can't pay its debts goes into administration
 * (systems/loans.ts): game over, with the choice to keep playing anyway.
 */
import type { Game } from "@game/game";
import { administrationDismissed, hud, newGameOpen } from "./store";

export function AdministrationDialog({ game }: { game: Game }) {
  if (!hud.value.administration || administrationDismissed.value) return null;
  return (
    <div class="modal-backdrop">
      <div class="panel modal" role="alertdialog" aria-modal="true" aria-labelledby="admin-title">
        <h2 id="admin-title">The hospital is in administration</h2>
        <p>
          It couldn't pay its debts: too many missed loan repayments, or a month overdrawn.
          Administrators have taken control, and the bank won't lend again.
        </p>
        <p class="dim">
          That's the end of this hospital as a business. You can start a new one, or keep playing to
          see it through.
        </p>
        <div class="new-game-actions">
          <button
            onClick={() => {
              administrationDismissed.value = true;
            }}
          >
            Keep playing
          </button>
          <button
            class="primary"
            onClick={() => {
              administrationDismissed.value = true;
              game.setSpeed(0);
              newGameOpen.value = true;
            }}
          >
            New hospital
          </button>
        </div>
      </div>
    </div>
  );
}
