/**
 * The Staff screen (GAME_DESIGN §8.2): everything about the workforce in
 * one place, under a summary strip. Team is everyone on staff: what they're
 * doing, their morale, fatigue and skill, who's off sick, leaving, or from
 * the bank or an agency, and dismissals. Hire lists every role by group,
 * with each description folded away until asked for. Rota sets the cover
 * levels (systems/rota.ts) and the gap-filling policy, with a week's grid
 * for each rota group showing how the people hired meet the cover, what
 * the cover takes in people and pay, and the patient demand behind a
 * suggested cover and hiring plan (game/staffingPlan.ts).
 */
import { useEffect, useState } from "preact/hooks";
import { staffRoleSections } from "@data/catalogue";
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import { ON_CALL, SHIFTS, type NurseBand } from "@data/staff";
import type { Game } from "@game/game";
import { peopleFor } from "@game/staffingPlan";
import { formatMoney } from "@game/tools";
import type { GapFill } from "@sim/state";
import { ListSection } from "./ListSection";
import {
  roster,
  staffHighlight,
  staffScreen,
  staffTable,
  type RosterData,
  type HireSpec,
  type RosterRole,
  type RotaRow,
  type StaffPlanData,
  type StaffPlanRow,
  type StaffRow,
  type StaffTab,
  type StaffTable,
} from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

const TAB_LABELS: Record<StaffTab, string> = { team: "Team", hire: "Hire", rota: "Rota" };

export function StaffScreen({ game }: { game: Game }) {
  const tab = staffScreen.value;
  const data = roster.value;
  const table = staffTable.value;
  if (!tab || !data || !table) return null;
  const gaps = data.rota.reduce((n, r) => n + r.gaps, 0);
  const setTab = (t: StaffTab) => game.openStaff(t);
  const tabs: StaffTab[] = data.rotas ? ["team", "hire", "rota"] : ["team", "hire"];
  const shown = tab === "rota" && !data.rotas ? "team" : tab;
  return (
    <section class="panel people-dialog staff-screen" role="dialog" aria-label="Staff">
      <header class="people-header">
        <div class="tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={shown === t}
              class={shown === t ? "active" : ""}
              onMouseDown={noFocus}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
              {t === "rota" && gaps > 0 && (
                <span class="tab-badge" title="Shifts a week short of your cover">
                  {gaps}
                </span>
              )}
              {t === "team" && table.sick + table.notice > 0 && (
                <span class="tab-badge" title="Off sick or leaving">
                  {table.sick + table.notice}
                </span>
              )}
            </button>
          ))}
        </div>
        <button class="close" title="Close (Esc)" onClick={() => (staffScreen.value = null)}>
          ×
        </button>
      </header>
      <Summary data={data} table={table} gaps={gaps} onGaps={() => setTab("rota")} />
      {shown === "team" && <TeamTab game={game} data={table} />}
      {shown === "hire" && <HireTab game={game} data={data} />}
      {shown === "rota" && <RotaTab game={game} data={data} />}
    </section>
  );
}

/** Payroll, headcount, who's at work, and anything to look into. */
function Summary(props: { data: RosterData; table: StaffTable; gaps: number; onGaps: () => void }) {
  const { data, table, gaps } = props;
  const resident = table.rows.length - table.bank - table.agency;
  return (
    <div class="staff-summary">
      <div class="stat-tiles">
        <div
          class="stat-tile"
          title="Salaries with employer costs, before unsocial hours, bank and agency"
        >
          <span class="stat-value">{formatMoney(data.payroll / 365)}</span>
          <span class="stat-label">payroll a day</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{resident}</span>
          <span class="stat-label">on staff</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{table.atWork}</span>
          <span class="stat-label">at work now{table.atWork > 0 && ` · ${table.busy} busy`}</span>
        </div>
        <div class={`stat-tile${table.bank + table.agency > 0 ? "" : " quiet"}`}>
          <span class="stat-value">
            {table.bank} / {table.agency}
          </span>
          <span class="stat-label">bank / agency in</span>
        </div>
        <div class={`stat-tile${table.sick + table.notice > 0 ? " warn" : " quiet"}`}>
          <span class="stat-value">
            {table.sick} / {table.notice}
          </span>
          <span class="stat-label">off sick / leaving</span>
        </div>
      </div>
      {!data.rotas && (
        <p class="dim small-note">
          Rotas are off for this hospital (Settings), so everyone works around the clock.
        </p>
      )}
      {data.rotas && gaps > 0 && (
        <button class="gap-banner warn-text" onMouseDown={noFocus} onClick={props.onGaps}>
          ⚠ {gaps} {gaps === 1 ? "shift" : "shifts"} a week short of your cover · see Rota
        </button>
      )}
    </div>
  );
}

// ---------- Team ----------

/** "All", then each role in staff-group order. */
const ROLE_FILTERS: { id: StaffRoleId | "all"; label: string }[] = [
  { id: "all", label: "All roles" },
  ...staffRoleSections().flatMap((s) => s.items.map((r) => ({ id: r.id, label: r.short }))),
];

type TeamFilter = "all" | "work" | "attention";
const TEAM_FILTERS: { id: TeamFilter; label: string }[] = [
  { id: "all", label: "Everyone" },
  { id: "work", label: "At work now" },
  { id: "attention", label: "Needs attention" },
];

const STATUS_LABELS: Record<StaffRow["status"], string> = {
  free: "Free",
  on_the_way: "On the way",
  waiting: "Waiting for patient",
  working: "Working",
  at_desk: "At desk",
  no_desk: "No desk",
  off_site: "Away",
};

function TeamTab({ game, data }: { game: Game; data: StaffTable }) {
  const [role, setRole] = useState<StaffRoleId | "all">("all");
  const [filter, setFilter] = useState<TeamFilter>("all");
  const highlight = staffHighlight.value;
  // Picked out from a notification: show them whatever the filters were.
  useEffect(() => {
    if (highlight === null) return;
    setRole("all");
    setFilter("all");
    requestAnimationFrame(() =>
      document.getElementById(`staff-row-${highlight}`)?.scrollIntoView({ block: "center" }),
    );
  }, [highlight]);
  const rows = data.rows
    .filter((r) => role === "all" || r.roleId === role)
    .filter((r) => (filter === "work" ? r.atWork : filter === "attention" ? r.attention : true))
    // Who's at work first; otherwise in hiring order, roles together.
    .sort((a, b) => Number(b.atWork) - Number(a.atWork));
  const roles = ROLE_FILTERS.filter(
    (f) => f.id === "all" || data.rows.some((r) => r.roleId === f.id),
  );
  // Show the person on the map, and get the screen out of the way.
  const show = (id: number) => {
    staffScreen.value = null;
    game.showAgent(id);
  };
  return (
    <>
      <div class="people-controls">
        <div class="chips" role="group" aria-label="Show">
          {TEAM_FILTERS.map((f) => {
            const n =
              f.id === "all"
                ? data.rows.length
                : data.rows.filter((r) => (f.id === "work" ? r.atWork : r.attention)).length;
            return (
              <button
                key={f.id}
                class={filter === f.id ? "active" : ""}
                aria-pressed={filter === f.id}
                onMouseDown={noFocus}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span class="dim">{n}</span>
              </button>
            );
          })}
        </div>
        <label class="sort">
          Role{" "}
          <select
            value={role}
            onChange={(e) =>
              setRole((e.currentTarget as HTMLSelectElement).value as StaffRoleId | "all")
            }
          >
            {roles.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="people-scroll">
        {rows.length === 0 ? (
          <p class="dim empty">
            {data.rows.length === 0 ? (
              <>
                No staff yet.{" "}
                <button class="link" onMouseDown={noFocus} onClick={() => game.openStaff("hire")}>
                  Hire a team →
                </button>
              </>
            ) : (
              "No one matches."
            )}
          </p>
        ) : (
          <table class="people-table team-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Doing</th>
                <th>Where</th>
                <th title="Morale, fatigue and skill">Wellbeing</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  id={`staff-row-${r.id}`}
                  class={`${r.atWork ? "" : "away"}${highlight === r.id ? " highlight" : ""}`}
                  onClick={() => show(r.id)}
                  title="Show on the map"
                >
                  <td>
                    <strong>{r.name}</strong>
                    <span class="sub">{r.role}</span>
                    {r.flags.length > 0 && (
                      <span class="flags">
                        {r.flags.map((f) => (
                          <span key={f.label} class={`flag ${f.tone}`}>
                            {f.label}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    <span class={`status-pill ${r.status}`}>{STATUS_LABELS[r.status]}</span>
                    <span class="sub">{r.activity}</span>
                    {r.progress !== null && (
                      <div class="meter small" title={`${Math.round(r.progress * 100)}% done`}>
                        <div
                          class="meter-fill"
                          style={{ width: `${Math.min(100, r.progress * 100)}%` }}
                        />
                      </div>
                    )}
                    {r.patient && (
                      <button
                        class="link"
                        onMouseDown={noFocus}
                        onClick={(e) => {
                          e.stopPropagation();
                          show(r.patient!.id);
                        }}
                      >
                        Show patient
                      </button>
                    )}
                  </td>
                  <td>{r.where}</td>
                  <td>
                    <Wellbeing row={r} />
                  </td>
                  <td>
                    {r.flags.every((f) => f.label !== "Bank" && f.label !== "Agency") && (
                      <button
                        class="small-button"
                        onMouseDown={noFocus}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Dismiss ${r.name}?`))
                            game.applyStaff({ type: "dismiss_staff", id: r.id });
                        }}
                      >
                        Dismiss
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** Three small bars: morale, fatigue (with rotas) and skill. */
function Wellbeing({ row }: { row: StaffRow }) {
  const bar = (label: string, value: number, tone: string) => (
    <div class="wb-bar" title={`${label} ${value} / 100`}>
      <span class="wb-label">{label[0]}</span>
      <div class="meter small">
        <div class={`meter-fill${tone}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
  return (
    <div class="wellbeing">
      {bar("Morale", row.morale, row.morale < 40 ? " bad" : row.morale < 60 ? " warn" : "")}
      {row.fatigue !== null &&
        bar("Fatigue", row.fatigue, row.fatigue > 75 ? " bad" : row.fatigue > 50 ? " warn" : "")}
      {bar("Skill", row.skill, "")}
    </div>
  );
}

// ---------- Hire ----------

function HireTab({ game, data }: { game: Game; data: RosterData }) {
  return (
    <div class="staff-tab-scroll">
      {data.rotas && (
        <p class="dim small-note">
          Each person works three 12½-hour shifts a week: about five keep one post filled day and
          night.
        </p>
      )}
      <div class="hire-columns">
        {data.groups.map((g) => (
          <ListSection key={g.name} title={g.name}>
            {g.roles
              .filter((r) => data.funding !== "private" || r.id !== "registrar")
              .map((r) =>
                r.specialist ? (
                  <SpecialistRow key={r.id} game={game} role={r} data={data} />
                ) : r.bands ? (
                  <NurseRow key={r.id} game={game} role={r} data={data} />
                ) : (
                  <RoleRow
                    key={r.id}
                    role={r}
                    rotas={data.rotas}
                    pay={r.annualCost}
                    applicants={data.recruitment ? (data.applicants[r.id] ?? null) : null}
                    onHire={() => game.applyStaff({ type: "hire_staff", role: r.id })}
                  />
                ),
              )}
          </ListSection>
        ))}
      </div>
    </div>
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
  /** Recruiting: applicants for the post (null when hiring is instant). */
  applicants?: { count: number; best: number | null; nextDays: number | null } | null;
  children?: preact.ComponentChildren;
  extraButton?: preact.ComponentChildren;
}) {
  const { role } = props;
  const a = props.applicants;
  const none = !!a && a.count === 0;
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
        {a && (
          <span class={none ? "warn-text small-note" : "dim small-note"}>
            {none
              ? `No applicants${a.nextDays ? `: about one every ${a.nextDays} days` : ""}`
              : `${a.count} ${a.count === 1 ? "applicant" : "applicants"} · best skill ${a.best}`}
          </span>
        )}
        {props.children}
        {open && <span class="hire-desc">{role.description}</span>}
      </div>
      <div class="hire-buttons">
        <button
          class="small-button"
          disabled={none}
          title={none ? "Nobody is applying for this post just now" : undefined}
          onMouseDown={noFocus}
          onClick={props.onHire}
        >
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
function NurseRow({ game, role, data }: { game: Game; role: RosterRole; data: RosterData }) {
  const [band, setBand] = useState<NurseBand>(5);
  const chosen = role.bands!.find((b) => b.band === band)!;
  return (
    <RoleRow
      role={role}
      rotas={data.rotas}
      pay={chosen.annualCost}
      applicants={data.recruitment ? (data.applicants[`nurse:band${band}`] ?? null) : null}
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
  const hire = (contract: "resident" | "on_call" | "privileges") =>
    game.applyStaff({
      type: "hire_staff",
      role: role.id,
      specialty,
      onCall: contract === "on_call",
      privileges: contract === "privileges",
    });
  const consultant = role.id === "consultant";
  // A Private Hospital's consultants have practising privileges; a PHS trust employs its own;
  // a Hybrid trust can do either.
  const privateOnly = consultant && data.funding === "private";
  const privileges = consultant && data.funding !== "phs";
  return (
    <RoleRow
      role={role}
      rotas={data.rotas}
      pay={privateOnly ? 0 : role.annualCost}
      payNote={
        privateOnly
          ? " · practising privileges: they bill their own patients"
          : consultant
            ? ` · on call ${formatMoney(ON_CALL.retainer)} + ${formatMoney(ON_CALL.hourly)}/h`
            : ""
      }
      onHire={() => hire(privateOnly ? "privileges" : "resident")}
      applicants={data.recruitment ? (data.applicants[`${role.id}:${specialty}`] ?? null) : null}
      hireLabel={privateOnly ? "Grant privileges" : consultant ? "Resident" : "Hire"}
      extraButton={
        consultant &&
        !privateOnly && (
          <>
            <button class="small-button" onMouseDown={noFocus} onClick={() => hire("on_call")}>
              On call
            </button>
            {privileges && (
              <button
                class="small-button"
                title="Practising privileges: no salary; they see private patients in the Private Patient Unit and bill their own fees"
                onMouseDown={noFocus}
                onClick={() => hire("privileges")}
              >
                Privileges
              </button>
            )}
          </>
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
    <div class="staff-tab-scroll">
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

      <ListSection title="Patient demand and hiring">
        <DemandPlan game={game} plan={data.plan} />
      </ListSection>

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
            <div class="rota-cards">
              {data.rota.map((r) => (
                <RotaCard key={r.key} game={game} row={r} gapFill={data.gapFill} />
              ))}
            </div>
          </>
        )}
      </ListSection>
    </div>
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

/** "£81k", "£1.2M": money at a glance. */
function compact(n: number): string {
  if (n >= 999_500) return `£${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `£${Math.round(n / 1_000)}k`;
  return formatMoney(n);
}

/** "☀ 3 · ☾ 2". */
const coverText = (c: { day: number; night: number }) => `☀ ${c.day} · ☾ ${c.night}`;
const sameCover = (a: { day: number; night: number }, b: { day: number; night: number }) =>
  a.day === b.day && a.night === b.night;

/** "☀ 4 × 7 + ☾ 3 × 7": a cover's shifts a week, as a sum. */
function shiftSum(c: { day: number; night: number }): string {
  const parts = [c.day > 0 && `☀ ${c.day} × 7 days`, c.night > 0 && `☾ ${c.night} × 7 nights`];
  return parts.filter(Boolean).join(" + ") || "0";
}

/** How cover on each shift turns into people to hire, with examples. */
function RatioNote() {
  return (
    <div class="ratio-note">
      <strong>Shifts and people.</strong> Cover is how many are at work <em>at once</em> on each
      shift. A week has 7 day shifts and 7 night shifts, and each person works {SHIFTS.perWeek} of
      them, so:
      <ul>
        <li>
          ☀ 1 · ☾ 1 (one on every shift) = 14 shifts a week ÷ 3 = <strong>5 people</strong>
        </li>
        <li>
          ☀ 2 · ☾ 1 = 21 shifts a week ÷ 3 = <strong>7 people</strong>
        </li>
        <li>
          ☀ 1 · ☾ 0 (days only) = 7 shifts a week ÷ 3 = <strong>3 people</strong>
        </li>
      </ul>
    </div>
  );
}

/**
 * The ways to fill a cover's gaps, side by side: hiring the shortfall, the
 * bank, or an agency, a year each, with how reliable each is.
 */
function FillOptions(props: { row: RotaRow; toHire: number; gapFill: GapFill }) {
  const { row, toHire, gapFill } = props;
  const c = row.gapCost;
  const yours = (fill: "bank" | "agency") =>
    (fill === "bank" ? gapFill !== "none" : gapFill === "bank_agency") && (
      <span class="flag">your policy</span>
    );
  return (
    <div class="fill-options">
      <span class="warn-text">
        {row.gaps} {row.gaps === 1 ? "shift" : "shifts"} a week uncovered. To fill them:
      </span>
      <table>
        <tbody>
          <tr>
            <th>Hire {toHire} more</th>
            <td>{compact(row.pay * toHire + c.unsocial)}/yr</td>
            <td class="dim">every shift, by your own staff</td>
          </tr>
          <tr>
            <th>Bank {yours("bank")}</th>
            <td>{compact(c.bank)}/yr</td>
            <td class="dim">same pay, but only about {Math.round(c.bankFills * 3)} in 3 filled</td>
          </tr>
          <tr>
            <th>Agency {yours("agency")}</th>
            <td>{compact(c.agency)}/yr</td>
            <td class="dim">every shift, at twice the cost, a little slower</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function hire(game: Game, spec: HireSpec) {
  game.applyStaff({ type: "hire_staff", ...spec });
}

/**
 * What patients the hospital can expect, and the cover and hiring that
 * suggests, group by group, with what it costs.
 */
function DemandPlan({ game, plan }: { game: Game; plan: StaffPlanData }) {
  const d = plan.demand;
  const n = (x: number) => (x < 10 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));
  const here = d.hereWalkIns + d.hereAmbulances;
  const all = d.walkIns + d.ambulances;
  const hour = `${String(d.peakHour).padStart(2, "0")}:00`;
  const required = plan.rows.filter((r) => !r.optional || r.have > 0 || r.cover);
  const useAll = () => {
    for (const r of required) game.setCover(r.key, r.suggested.day, r.suggested.night);
  };
  const allSet = required.every((r) => r.cover && sameCover(r.cover, r.suggested));
  return (
    <>
      <RatioNote />
      {all > 0 ? (
        <p class="hire-desc demand-text">
          Your catchment of {d.catchment.toLocaleString("en-GB")} people sends about{" "}
          <strong>{n(all)} emergency patients a day</strong> ({n(d.walkIns)} walk in,{" "}
          {n(d.ambulances)} by ambulance)
          {d.surge && <>, more than usual: {d.surge}</>}.{" "}
          {here > 0 ? (
            <>
              With what you can treat now, about <strong>{n(here)} come here</strong>
              {all - here >= 1 && <> and {n(all - here)} go elsewhere</>}: {n(d.dayArrivals)} during
              day shifts and {n(d.nightArrivals)} at night, busiest around {hour} (
              {n(d.peakArrivals)} an hour).
            </>
          ) : (
            <>None come here yet: build the rooms their care needs (Help shows what).</>
          )}{" "}
          {d.admissions >= 0.5 && <>About {n(d.admissions)} a day need admitting. </>}
          {d.wardBeds > 0 && <>You have {d.wardBeds} ward beds to nurse. </>}
          {d.theatres > 0 && (
            <>
              {d.theatres} {d.theatres === 1 ? "theatre" : "theatres"} to staff.
            </>
          )}
        </p>
      ) : (
        <p class="hire-desc demand-text">
          No A&E: staff for your wards ({d.wardBeds} beds), theatres ({d.theatres}) and clinics.
        </p>
      )}
      {plan.rows.length === 0 ? (
        <p class="dim">Build some of the hospital to see what staff it needs.</p>
      ) : (
        <table class="capacity-table plan-table">
          <thead>
            <tr>
              <th>Group</th>
              <th title="People wanted at work at once on every day shift and every night shift, from patient demand">
                Demand suggests
                <span class="sub">at once, per shift</span>
              </th>
              <th title="People it takes to staff that cover, each working three shifts a week">
                People needed
                <span class="sub">shifts a week ÷ 3</span>
              </th>
              <th title="On the rota now">You have</th>
              <th title="People to hire to staff what demand suggests">To hire</th>
              <th title="The cover you've set on the cards below">Your cover</th>
              <th title="The suggested cover's pay a year, with unsocial hours">Pay a year</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => (
              <PlanRow key={r.key} game={game} row={r} />
            ))}
          </tbody>
        </table>
      )}
      {plan.rows.length > 0 && (
        <div class="plan-totals">
          <span class="hire-desc">
            The suggested cover takes <strong>{plan.people} people</strong>, about{" "}
            <strong>{compact(plan.cost)} a year</strong> in pay with unsocial hours (
            {formatMoney(plan.cost / 365)} a day). Your rota now: {plan.peopleNow} people,{" "}
            {compact(plan.costNow)} a year.
            {plan.blockPerDay !== null && (
              <> The block contract pays {formatMoney(plan.blockPerDay)} a day now.</>
            )}{" "}
            Your own staff are the cheapest reliable cover: the bank costs the same per shift but
            fills only about two gaps in three, and an agency fills every one at twice the cost.
          </span>
          <button
            class="small-button"
            disabled={allSet}
            onMouseDown={noFocus}
            onClick={useAll}
            title="Set every group's cover to what demand suggests (optional groups only if you have some)"
          >
            Use suggested cover
          </button>
        </div>
      )}
    </>
  );
}

function PlanRow({ game, row }: { game: Game; row: StaffPlanRow }) {
  const shifts = (row.suggested.day + row.suggested.night) * 7;
  const toHire = row.suggestedPeople - row.have;
  const coverTone = !row.cover
    ? "dim"
    : row.cover.day >= row.suggested.day && row.cover.night >= row.suggested.night
      ? "ok-text"
      : "warn-text";
  return (
    <tr>
      <th>
        {row.name}
        {row.optional && <span class="flag"> optional</span>}
        <span class="sub dim">{row.why}</span>
      </th>
      <td>{coverText(row.suggested)}</td>
      <td title={`${shiftSum(row.suggested)} = ${shifts} shifts a week, ÷ 3 each`}>
        <strong>{row.suggestedPeople}</strong>
        <span class="sub dim">{shifts} ÷ 3</span>
      </td>
      <td>{row.have}</td>
      <td class={toHire > 0 ? (row.optional ? "" : "warn-text") : "ok-text"}>
        {toHire > 0 ? `+${toHire}` : toHire === 0 ? "✓" : `✓ ${-toHire} spare`}
      </td>
      <td class={coverTone}>{row.cover ? coverText(row.cover) : "none"}</td>
      <td title={`${formatMoney(row.pay)} a year each, before unsocial hours`}>
        {compact(row.suggestedCost)}
      </td>
      <td class="plan-actions">
        {!(row.cover && sameCover(row.cover, row.suggested)) && (
          <button
            class="small-button"
            onMouseDown={noFocus}
            onClick={() => game.setCover(row.key, row.suggested.day, row.suggested.night)}
            title="Set this group's cover to what demand suggests"
          >
            Use
          </button>
        )}
        {row.hire && (
          <button
            class="small-button"
            onMouseDown={noFocus}
            onClick={() => hire(game, row.hire!)}
            title={`Hire one, ${formatMoney(row.pay)} a year`}
          >
            Hire
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * A rota group: cover steppers, and the week's 14 shifts against them; what
 * the cover takes in people and pay; and what demand suggests.
 */
function RotaCard({ game, row, gapFill }: { game: Game; row: RotaRow; gapFill: GapFill }) {
  const { cover } = row;
  const hasCover = cover.day + cover.night > 0;
  const shifts = (cover.day + cover.night) * 7;
  const toHire = Math.max(0, row.needed - row.people);
  const enough = row.people >= row.needed;
  return (
    <div class="rota-card">
      <div class="rota-card-head">
        <strong>{row.name}</strong>
        <span class="dim">
          {row.people} staff · {row.onNow} at work
          {row.hire && (
            <button
              class="small-button card-hire"
              onMouseDown={noFocus}
              onClick={() => hire(game, row.hire!)}
              title={`Hire one, ${formatMoney(row.pay)} a year`}
            >
              Hire
            </button>
          )}
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
      {hasCover ? (
        <>
          <div class={`cover-sum ${enough && row.gaps === 0 ? "ok" : "warn"}`}>
            <div>
              {shiftSum(cover)} = <strong>{shifts} shifts a week</strong>
            </div>
            <div title={`${(shifts / 3).toFixed(1)}, rounded up`}>
              ÷ 3 shifts each = <strong>{row.needed} people</strong> · you have {row.people}
              {toHire > 0 ? (
                <strong class="warn-text"> · {toHire} to hire</strong>
              ) : row.people > row.needed ? (
                <span class="dim"> · {row.people - row.needed} more than needed</span>
              ) : (
                <span class="ok-text"> · ✓</span>
              )}
            </div>
          </div>
          {row.gaps > 0 &&
            (toHire > 0 ? (
              <FillOptions row={row} toHire={toHire} gapFill={gapFill} />
            ) : (
              <span class="rota-status rota-note warn-text">
                {row.gaps} {row.gaps === 1 ? "shift" : "shifts"} a week uncovered: enough people,
                but the rota can't fit them all in (never a day straight after a night). One more
                person closes the gaps.
              </span>
            ))}
          {row.spare > 0 && row.gaps === 0 && (
            <span class="rota-status rota-note dim">
              Their {row.spare} spare {row.spare === 1 ? "shift" : "shifts"} a week go where they
              help most.
            </span>
          )}
          <span class="rota-status rota-note dim">
            Pay for this cover: about {compact(row.cost.salaries + row.cost.unsocial)} a year (
            {compact(row.cost.unsocial)} of it unsocial hours). Expect about{" "}
            {row.sick < 1 ? "one shift every few weeks" : `${Math.round(row.sick)} a week`} lost to
            sickness.
          </span>
        </>
      ) : (
        <span class="rota-status dim">
          No cover set: shifts shared 60:40 days to nights. Set cover to see gaps.
        </span>
      )}
      {row.suggested && (
        <span
          class={`rota-status rota-suggest${sameCover(row.suggested, cover) ? " ok-text" : ""}`}
          title={row.why ?? undefined}
        >
          {sameCover(row.suggested, cover) ? (
            "✓ Matches patient demand"
          ) : (
            <>
              Patient demand suggests {coverText(row.suggested)}: {peopleFor(row.suggested)} people
              <button
                class="small-button"
                onMouseDown={noFocus}
                onClick={() => game.setCover(row.key, row.suggested!.day, row.suggested!.night)}
              >
                Use
              </button>
            </>
          )}
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
