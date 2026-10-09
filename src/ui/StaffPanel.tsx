/**
 * Hiring (GAME_DESIGN §8.2, first version): hire by role and see the payroll.
 * The People dialog shows what everyone is doing and handles dismissals. Recruitment pools, pay bands and rotas come in
 * M5; for now hiring is instant and everyone works around the clock.
 */
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import { ListSection } from "./ListSection";
import { peopleDialog, roster, sidePanel } from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

export function StaffPanel({ game }: { game: Game }) {
  const data = roster.value;
  if (sidePanel.value !== "staff" || !data) return null;
  return (
    <aside class="panel side-panel" aria-label="Hire staff">
      <button class="close" title="Close" onClick={() => (sidePanel.value = null)}>
        ×
      </button>
      <div class="side-scroll">
        <h2>Hire staff</h2>
        <p class="dim">
          Payroll {formatMoney(data.payroll)} a year ({formatMoney(data.payroll / 365)} a day),
          including employer costs. Until rotas arrive, everyone works around the clock.
        </p>
        {data.groups.map((g) => (
          <ListSection key={g.name} title={g.name}>
            {g.roles.map((r) => (
              <div key={r.id} class="hire-row">
                <div class="hire-info">
                  <strong>{r.name}</strong>
                  <span class="dim">
                    {formatMoney(r.annualCost)}/yr · {r.count} on staff
                  </span>
                  <span class="hire-desc">{r.description}</span>
                </div>
                <button
                  class="small-button"
                  onMouseDown={noFocus}
                  onClick={() => game.applyStaff({ type: "hire_staff", role: r.id })}
                >
                  Hire
                </button>
              </div>
            ))}
          </ListSection>
        ))}
        <p class="hire-footer">
          <button
            class="link"
            onMouseDown={noFocus}
            onClick={() => {
              peopleDialog.value = "staff";
              game.refreshPanels();
            }}
          >
            See what everyone is doing →
          </button>
        </p>
      </div>
    </aside>
  );
}
