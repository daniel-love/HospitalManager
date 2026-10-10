/**
 * The Staff panel (GAME_DESIGN §8.2): a summary strip, then two tabs. Hire
 * lists every role by group, compact, with each description folded away
 * until asked for. Rota sets the cover levels (systems/rota.ts) and the
 * gap-filling policy, with a week's grid for each rota group showing how
 * the people hired meet the cover, shift by shift. The People dialog shows
 * what everyone is doing and handles dismissals. Hiring is instant until
 * recruitment pools arrive.
 */
import { useState } from "preact/hooks";
import type { SpecialtyId } from "@data/schema";
import { ON_CALL, SHIFTS, type NurseBand } from "@data/staff";
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import type { GapFill } from "@sim/state";
import { ListSection } from "./ListSection";
import {
  peopleDialog,
  roster,
  sidePanel,
  type RosterData,
  type RosterRole,
  type RotaRow,
} from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

type Tab = "hire" | "rota";

export function StaffPanel({ game }: { game: Game }) {
  const [tab, setTab] = useState<Tab>("hire");
  const data = roster.value;
  if (sidePanel.value !== "staff" || !data) return null;
  const gaps = data.rota.reduce((n, r) => n + r.gaps, 0);
  return (
    <aside class="panel side-panel staff-panel" aria-label="Staff">
      <button class="close" title="Close" onClick={() => (sidePanel.value = null)}>
        ×
      </button>
      <div class="side-scroll">
        <h2>Staff</h2>
        <Summary data={data} gaps={gaps} onGaps={() => setTab("rota")} />
        {data.rotas && (
          <div class="tabs staff-tabs" role="tablist">
            {(["hire", "rota"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                class={tab === t ? "active" : ""}
                onMouseDown={noFocus}
                onClick={() => setTab(t)}
              >
                {t === "hire" ? "Hire" : "Rota"}
                {t === "rota" && gaps > 0 && <span class="tab-badge">{gaps}</span>}
              </button>
            ))}
          </div>
        )}
        {tab === "rota" && data.rotas ? (
          <RotaTab game={game} data={data} />
        ) : (
          <HireTab game={game} data={data} />
        )}
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

/** Payroll, headcount and who's at work, at a glance. */
function Summary({ data, gaps, onGaps }: { data: RosterData; gaps: number; onGaps: () => void }) {
  const onStaff = data.groups.reduce((n, g) => n + g.roles.reduce((m, r) => m + r.count, 0), 0);
  const atWork = data.groups.reduce((n, g) => n + g.roles.reduce((m, r) => m + r.atWork, 0), 0);
  return (
    <>
      <div class="stat-tiles">
        <div
          class="stat-tile"
          title="Salaries with employer costs, before unsocial hours, bank and agency"
        >
          <span class="stat-value">{formatMoney(data.payroll / 365)}</span>
          <span class="stat-label">payroll a day</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{onStaff}</span>
          <span class="stat-label">on staff</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{atWork}</span>
          <span class="stat-label">at work now</span>
        </div>
      </div>
      {!data.rotas && (
        <p class="dim small-note">
          Rotas are off for this hospital (Settings), so everyone works around the clock.
        </p>
      )}
      {data.rotas && gaps > 0 && (
        <button class="gap-banner warn-text" onMouseDown={noFocus} onClick={onGaps}>
          ⚠ {gaps} {gaps === 1 ? "shift" : "shifts"} a week short of your cover · see Rota
        </button>
      )}
    </>
  );
}

// ---------- Hire ----------

function HireTab({ game, data }: { game: Game; data: RosterData }) {
  return (
    <>
      {data.rotas && (
        <p class="dim small-note">
          Each person works three 12½-hour shifts a week: about five keep one post filled day and
          night.
        </p>
      )}
      {data.groups.map((g) => (
        <ListSection key={g.name} title={g.name}>
          {g.roles.map((r) =>
            r.specialist ? (
              <SpecialistRow key={r.id} game={game} role={r} data={data} />
            ) : r.bands ? (
              <NurseRow key={r.id} game={game} role={r} rotas={data.rotas} />
            ) : (
              <RoleRow
                key={r.id}
                role={r}
                rotas={data.rotas}
                pay={r.annualCost}
                onHire={() => game.applyStaff({ type: "hire_staff", role: r.id })}
              />
            ),
          )}
        </ListSection>
      ))}
    </>
  );
}

/** "~1.3 per shift": what a headcount gives on the rota, on average. */
function perShift(count: number): string {
  const n = (count * SHIFTS.perWeek) / 14;
  return `~${n < 10 ? n.toFixed(1) : Math.round(n)} per shift`;
}

/**
 * One role: name, pay and headcount on a line, with its Hire button, and
 * the description (and any choices) underneath when opened.
 */
function RoleRow(props: {
  role: RosterRole;
  rotas: boolean;
  pay: number;
  payNote?: string;
  counts?: string;
  onHire: () => void;
  hireLabel?: string;
  children?: preact.ComponentChildren;
  extraButton?: preact.ComponentChildren;
}) {
  const { role } = props;
  const [open, setOpen] = useState(false);
  return (
    <div class={`hire-row${open ? " open" : ""}`}>
      <div class="hire-info">
        <button
          class="hire-name"
          aria-expanded={open}
          onMouseDown={noFocus}
          onClick={() => setOpen(!open)}
          title={open ? "Hide details" : "Show details"}
        >
          <span class="chevron">{open ? "▾" : "▸"}</span>
          <strong>{role.name}</strong>
          {role.count > 0 && <span class="count-badge">{role.count}</span>}
        </button>
        <span class="dim">
          {formatMoney(props.pay)}/yr{props.payNote}
          {props.rotas && role.count > 0 && !role.specialist && ` · ${perShift(role.count)}`}
          {props.counts && ` · ${props.counts}`}
        </span>
        {props.children}
        {open && <span class="hire-desc">{role.description}</span>}
      </div>
      <div class="hire-buttons">
        <button class="small-button" onMouseDown={noFocus} onClick={props.onHire}>
          {props.hireLabel ?? "Hire"}
        </button>
        {props.extraButton}
      </div>
    </div>
  );
}

const BAND_NOTES: Record<NurseBand, string> = {
  5: "Staff nurse: most of the nursing. New starters vary in experience.",
  6: "Senior staff nurse: more experienced, so quicker at everything.",
  7: "Charge nurse: with one on duty the shift has a nurse in charge, and nurses work about 10% faster.",
};

/** Nurses: hired at a band, each with its own pay. */
function NurseRow({ game, role, rotas }: { game: Game; role: RosterRole; rotas: boolean }) {
  const [band, setBand] = useState<NurseBand>(5);
  const chosen = role.bands!.find((b) => b.band === band)!;
  return (
    <RoleRow
      role={role}
      rotas={rotas}
      pay={chosen.annualCost}
      onHire={() => game.applyStaff({ type: "hire_staff", role: "nurse", band })}
    >
      <div class="chips band-chips" role="radiogroup" aria-label="Band">
        {role.bands!.map((b) => (
          <button
            key={b.band}
            role="radio"
            aria-checked={band === b.band}
            class={band === b.band ? "active" : ""}
            title={`Band ${b.band}: ${b.title}, ${formatMoney(b.annualCost)}/yr`}
            onMouseDown={noFocus}
            onClick={() => setBand(b.band)}
          >
            Band {b.band}
            {b.count > 0 && <span class="chip-count">{b.count}</span>}
          </button>
        ))}
      </div>
      <span class="hire-desc">{BAND_NOTES[band]}</span>
    </RoleRow>
  );
}

/** Consultants and registrars: hired into a specialty; consultants can be on call. */
function SpecialistRow({ game, role, data }: { game: Game; role: RosterRole; data: RosterData }) {
  const specialties = data.specialties;
  const [specialty, setSpecialty] = useState<SpecialtyId>(specialties[0]!.id);
  const counts = specialties
    .filter((sp) => (role.bySpecialty?.[sp.id] ?? 0) > 0)
    .map((sp) => `${sp.name} ${role.bySpecialty![sp.id]}`);
  const hire = (onCall: boolean) =>
    game.applyStaff({ type: "hire_staff", role: role.id, specialty, onCall });
  const consultant = role.id === "consultant";
  return (
    <RoleRow
      role={role}
      rotas={data.rotas}
      pay={role.annualCost}
      payNote={
        consultant
          ? ` · on call ${formatMoney(ON_CALL.retainer)} + ${formatMoney(ON_CALL.hourly)}/h`
          : ""
      }
      onHire={() => hire(false)}
      hireLabel={consultant ? "Resident" : "Hire"}
      extraButton={
        consultant && (
          <button class="small-button" onMouseDown={noFocus} onClick={() => hire(true)}>
            On call
          </button>
        )
      }
    >
      <select
        class="hire-specialty"
        aria-label="Specialty"
        value={specialty}
        onChange={(e) => setSpecialty((e.currentTarget as HTMLSelectElement).value as SpecialtyId)}
      >
        {specialties.map((sp) => (
          <option key={sp.id} value={sp.id}>
            {sp.name}
            {(role.bySpecialty?.[sp.id] ?? 0) > 0 ? ` (${role.bySpecialty![sp.id]})` : ""}
          </option>
        ))}
      </select>
      {counts.length > 0 && <span class="dim">{counts.join(" · ")}</span>}
    </RoleRow>
  );
}

// ---------- Rota ----------

const GAP_FILLS: { id: GapFill; label: string; note: string }[] = [
  {
    id: "none",
    label: "Unfilled",
    note: "Gaps stay empty: cheapest, but short shifts are slower and wear morale down.",
  },
  {
    id: "bank",
    label: "Bank",
    note: "Your own staff bank, at normal hourly pay. They fill about two gaps in three.",
  },
  {
    id: "bank_agency",
    label: "Bank + agency",
    note: "What the bank can't fill goes to an agency: always filled, but at twice the cost, and a little slower as they don't know the hospital.",
  },
];

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

function RotaTab({ game, data }: { game: Game; data: RosterData }) {
  const fill = GAP_FILLS.find((o) => o.id === data.gapFill)!;
  return (
    <>
      <details class="rota-how">
        <summary>How shifts work</summary>
        <p class="hire-desc">
          Long days run 07:30–20:00 and nights 19:30–08:00, with half an hour to hand over. Set how
          many of each group you want on every day and night shift. Everyone hired is rostered to
          meet it as far as they can (never a day straight after a night), and their spare shifts go
          where they help most. Consultants work weekdays 08:00–18:00 and take turns on call from
          home out of hours; registrars with clinics or theatre lists work weekdays too.
        </p>
      </details>

      <ListSection title="Filling gaps">
        <div class="chips gap-chips" role="radiogroup" aria-label="Filling gaps">
          {GAP_FILLS.map((o) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={data.gapFill === o.id}
              class={data.gapFill === o.id ? "active" : ""}
              onMouseDown={noFocus}
              onClick={() => game.setGapFill(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span class="hire-desc">
          {fill.note}
          {data.temps.bank + data.temps.agency > 0 &&
            ` At work now: ${data.temps.bank} bank, ${data.temps.agency} agency.`}
        </span>
      </ListSection>

      <ListSection title="Cover">
        {data.rota.length === 0 ? (
          <p class="dim">Hire staff to see their rota here.</p>
        ) : (
          <>
            <Legend />
            {data.rota.map((r) => (
              <RotaCard key={r.key} game={game} row={r} />
            ))}
          </>
        )}
      </ListSection>
    </>
  );
}

function Legend() {
  return (
    <div class="rota-legend">
      <span>
        <i class="cell-swatch met" /> covered
      </span>
      <span>
        <i class="cell-swatch short" /> short
      </span>
      <span>
        <i class="cell-swatch empty" /> nobody
      </span>
      <span>
        <i class="cell-swatch spare" /> no cover set
      </span>
    </div>
  );
}

/** A rota group: cover steppers, and the week's 14 shifts against them. */
function RotaCard({ game, row }: { game: Game; row: RotaRow }) {
  const { cover } = row;
  const hasCover = cover.day + cover.night > 0;
  return (
    <div class="rota-card">
      <div class="rota-card-head">
        <strong>{row.name}</strong>
        <span class="dim">
          {row.people} staff · {row.onNow} at work
        </span>
      </div>
      <div class="rota-card-body">
        <table class="rota-grid" aria-label={`${row.name}: people on each shift this week`}>
          <thead>
            <tr>
              <th />
              {DAYS.map((d, i) => (
                <th key={i}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(["day", "night"] as const).map((kind, k) => (
              <tr key={kind}>
                <th title={kind === "day" ? "Long day 07:30–20:00" : "Night 19:30–08:00"}>
                  {kind === "day" ? "☀" : "☾"}
                </th>
                {DAYS.map((_, d) => {
                  const have = row.filled[d * 2 + k]!;
                  const want = cover[kind];
                  const cls = !hasCover
                    ? have > 0
                      ? "spare"
                      : "empty"
                    : have >= want
                      ? "met"
                      : have === 0
                        ? "empty"
                        : "short";
                  return (
                    <td
                      key={d}
                      class={`cell ${cls}`}
                      title={`${have} rostered${hasCover ? ` of ${want} wanted` : ""}`}
                    >
                      {have}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div class="rota-cover">
          <CoverStepper
            icon="☀"
            label="days"
            value={cover.day}
            onChange={(n) => game.setCover(row.key, n, cover.night)}
          />
          <CoverStepper
            icon="☾"
            label="nights"
            value={cover.night}
            onChange={(n) => game.setCover(row.key, cover.day, n)}
          />
        </div>
      </div>
      {row.gaps > 0 ? (
        <span class="rota-status warn-text">
          {row.gaps} {row.gaps === 1 ? "shift" : "shifts"} a week short · this cover needs about{" "}
          {row.needed} people, you have {row.people}
        </span>
      ) : hasCover ? (
        <span class="rota-status ok-text">Every shift covered</span>
      ) : (
        <span class="rota-status dim">
          No cover set: shifts shared 60:40 days to nights. Set cover to see gaps.
        </span>
      )}
    </div>
  );
}

function CoverStepper(props: {
  icon: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div class="stepper cover-stepper" title={`Wanted on each ${props.label.slice(0, -1)} shift`}>
      <span class="cover-icon">{props.icon}</span>
      <button
        disabled={props.value <= 0}
        onMouseDown={noFocus}
        onClick={() => props.onChange(props.value - 1)}
        aria-label={`Fewer on ${props.label}`}
      >
        −
      </button>
      <span class="cover-value">{props.value}</span>
      <button
        onMouseDown={noFocus}
        onClick={() => props.onChange(props.value + 1)}
        aria-label={`More on ${props.label}`}
      >
        +
      </button>
    </div>
  );
}
