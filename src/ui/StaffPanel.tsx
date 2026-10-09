/**
 * Hiring (GAME_DESIGN §8.2, first version): hire by role and see the payroll.
 * The People dialog shows what everyone is doing and handles dismissals. Recruitment pools, pay bands and rotas come in
 * M5; for now hiring is instant and everyone works around the clock.
 */
import { useState } from "preact/hooks";
import type { SpecialtyId } from "@data/schema";
import { ON_CALL } from "@data/staff";
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import { ListSection } from "./ListSection";
import { peopleDialog, roster, sidePanel, type RosterData, type RosterRole } from "./store";

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
            {g.roles.map((r) =>
              r.specialist ? (
                <SpecialistRow key={r.id} game={game} role={r} specialties={data.specialties} />
              ) : (
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
              ),
            )}
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

/** Consultants and registrars: hired into a specialty; consultants can be on call. */
function SpecialistRow({
  game,
  role,
  specialties,
}: {
  game: Game;
  role: RosterRole;
  specialties: RosterData["specialties"];
}) {
  const [specialty, setSpecialty] = useState<SpecialtyId>(specialties[0]!.id);
  const counts = specialties
    .filter((sp) => (role.bySpecialty?.[sp.id] ?? 0) > 0)
    .map((sp) => `${sp.name} ${role.bySpecialty![sp.id]}`);
  const hire = (onCall: boolean) =>
    game.applyStaff({ type: "hire_staff", role: role.id, specialty, onCall });
  const chosen = specialties.find((sp) => sp.id === specialty);
  return (
    <div class="hire-row specialist">
      <div class="hire-info">
        <strong>{role.name}</strong>
        <span class="dim">
          {formatMoney(role.annualCost)}/yr
          {role.id === "consultant" &&
            ` resident, or ${formatMoney(ON_CALL.retainer)}/yr on call + ${formatMoney(ON_CALL.hourly)}/h when called in`}{" "}
          · {role.count} on staff{counts.length > 0 && ` (${counts.join(", ")})`}
        </span>
        <span class="hire-desc">{role.description}</span>
        <label class="hire-specialty">
          Specialty{" "}
          <select
            value={specialty}
            onChange={(e) =>
              setSpecialty((e.currentTarget as HTMLSelectElement).value as SpecialtyId)
            }
          >
            {specialties.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.name}
              </option>
            ))}
          </select>
        </label>
        {chosen && <span class="hire-desc">{chosen.description}</span>}
      </div>
      <div class="hire-buttons">
        <button class="small-button" onMouseDown={noFocus} onClick={() => hire(false)}>
          {role.id === "consultant" ? "Hire resident" : "Hire"}
        </button>
        {role.id === "consultant" && (
          <button class="small-button" onMouseDown={noFocus} onClick={() => hire(true)}>
            Hire on call
          </button>
        )}
      </div>
    </div>
  );
}
