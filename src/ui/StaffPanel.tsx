/**
 * Hiring (GAME_DESIGN §8.2): hire by role, see the payroll, and set the
 * rota's cover levels (systems/rota.ts). The People dialog shows what
 * everyone is doing and handles dismissals. Hiring is instant until
 * recruitment pools arrive.
 */
import { useState } from "preact/hooks";
import type { SpecialtyId } from "@data/schema";
import { ON_CALL, type NurseBand } from "@data/staff";
import type { GapFill } from "@sim/state";
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
          including employer costs
          {data.rotas
            ? ", plus unsocial hours pay for nights and weekends. Each person works three 12½-hour shifts a week, so a post filled around the clock takes about five people."
            : ". Rotas are off for this hospital (Settings), so everyone works around the clock."}
        </p>
        {data.rotas && <RotaSection game={game} data={data} />}
        {data.groups.map((g) => (
          <ListSection key={g.name} title={g.name}>
            {g.roles.map((r) =>
              r.specialist ? (
                <SpecialistRow key={r.id} game={game} role={r} specialties={data.specialties} />
              ) : r.bands ? (
                <NurseRow key={r.id} game={game} role={r} rotas={data.rotas} />
              ) : (
                <div key={r.id} class="hire-row">
                  <div class="hire-info">
                    <strong>{r.name}</strong>
                    <span class="dim">
                      {formatMoney(r.annualCost)}/yr · {r.count} on staff
                      {data.rotas && r.count > 0 && `, ${r.atWork} at work now`}
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

/**
 * Cover levels: how many of each group the rota should put on every day
 * and night shift, and how well the people hired meet it.
 */
function RotaSection({ game, data }: { game: Game; data: RosterData }) {
  const rows = data.rota;
  return (
    <ListSection title="Rota">
      <p class="hire-desc">
        Long days 07:30–20:00 and nights 19:30–08:00, with half an hour to hand over. Set how many
        you want on each shift; everyone hired is rostered to meet it as far as they can, and any
        shifts left over go where they help most. Consultants work weekdays 08:00–18:00 and take
        turns on call from home out of hours, as do registrars with clinics or theatre lists
        (without the on call).
      </p>
      {rows.length === 0 && <p class="dim">Hire staff to see their rota here.</p>}
      <div class="gap-fill">
        <strong>Filling gaps</strong>
        <span class="hire-desc">
          At the start of each shift, places short of the cover (not rostered, or off sick) can be
          offered to the staff bank, your own pool paid by the hour, who fill about two in three;
          then to an agency, who always find someone, at about twice the cost and a little slower as
          they don't know the hospital.
          {data.temps.bank + data.temps.agency > 0 &&
            ` At work now: ${data.temps.bank} bank, ${data.temps.agency} agency.`}
        </span>
        {GAP_FILLS.map((o) => (
          <label key={o.id} class="setting-choice">
            <input
              type="radio"
              name="gap-fill"
              checked={data.gapFill === o.id}
              onChange={() => game.setGapFill(o.id)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.key} class="rota-row">
          <div class="hire-info">
            <strong>{r.name}</strong>
            <span class="dim">
              {r.people} on staff · {r.onNow} at work now · rostered{" "}
              {describeSpread(r.minDay, r.avgDay)} by day, {describeSpread(r.minNight, r.avgNight)}{" "}
              at night
            </span>
            {r.gaps > 0 ? (
              <span class="rota-gaps warn-text">
                {r.gaps} {r.gaps === 1 ? "shift" : "shifts"} a week short: about {r.needed} people
                needed for this cover
              </span>
            ) : (
              r.cover.day + r.cover.night === 0 && (
                <span class="hire-desc">No cover set: shifts are shared 60:40 days to nights.</span>
              )
            )}
          </div>
          <div class="rota-cover">
            <CoverStepper
              label="Days"
              value={r.cover.day}
              onChange={(n) => game.setCover(r.key, n, r.cover.night)}
            />
            <CoverStepper
              label="Nights"
              value={r.cover.night}
              onChange={(n) => game.setCover(r.key, r.cover.day, n)}
            />
          </div>
        </div>
      ))}
    </ListSection>
  );
}

const GAP_FILLS: { id: GapFill; label: string }[] = [
  { id: "none", label: "Leave them unfilled" },
  { id: "bank", label: "Bank staff only" },
  { id: "bank_agency", label: "Bank, then agency" },
];

/** Nurses: hired at a band, each with its own pay. */
function NurseRow({ game, role, rotas }: { game: Game; role: RosterRole; rotas: boolean }) {
  const [band, setBand] = useState<NurseBand>(5);
  const chosen = role.bands!.find((b) => b.band === band)!;
  const counts = role.bands!.filter((b) => b.count > 0).map((b) => `Band ${b.band} ${b.count}`);
  return (
    <div class="hire-row specialist">
      <div class="hire-info">
        <strong>Nurse</strong>
        <span class="dim">
          {formatMoney(chosen.annualCost)}/yr · {role.count} on staff
          {counts.length > 0 && ` (${counts.join(", ")})`}
          {rotas && role.count > 0 && `, ${role.atWork} at work now`}
        </span>
        <span class="hire-desc">{role.description}</span>
        <label class="hire-specialty">
          Band{" "}
          <select
            value={band}
            onChange={(e) =>
              setBand(Number((e.currentTarget as HTMLSelectElement).value) as NurseBand)
            }
          >
            {role.bands!.map((b) => (
              <option key={b.band} value={b.band}>
                Band {b.band}: {b.title}
              </option>
            ))}
          </select>
        </label>
        <span class="hire-desc">{BAND_NOTES[band]}</span>
      </div>
      <button
        class="small-button"
        onMouseDown={noFocus}
        onClick={() => game.applyStaff({ type: "hire_staff", role: "nurse", band })}
      >
        Hire
      </button>
    </div>
  );
}

const BAND_NOTES: Record<NurseBand, string> = {
  5: "A registered nurse: most of the nursing. New starters vary in experience.",
  6: "More experienced, so quicker at everything; often leads a team.",
  7: "Sister or charge nurse. With a Band 7 on duty, the shift has a nurse in charge and the whole nursing team works about 10% faster.",
};

/** "2", or "1–2" when shifts differ. */
function describeSpread(min: number, avg: number): string {
  const max = Math.ceil(avg);
  return min >= max ? String(min) : `${min}–${max}`;
}

function CoverStepper(props: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div class="stepper">
      <span class="dim">{props.label}</span>
      <button
        disabled={props.value <= 0}
        onMouseDown={noFocus}
        onClick={() => props.onChange(props.value - 1)}
        aria-label={`Fewer on ${props.label.toLowerCase()}`}
      >
        −
      </button>
      <span>{props.value}</span>
      <button
        onMouseDown={noFocus}
        onClick={() => props.onChange(props.value + 1)}
        aria-label={`More on ${props.label.toLowerCase()}`}
      >
        +
      </button>
    </div>
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
