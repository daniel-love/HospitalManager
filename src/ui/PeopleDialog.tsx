/**
 * The People dialog: everyone in the hospital at a glance. The Patients tab
 * shows each patient's condition, triage category, where they are in their
 * visit and how they're doing against their targets; the Staff tab shows what
 * every member of staff is doing right now. The game keeps running behind it.
 * Clicking a name shows that person on the map and in the inspector.
 */
import type { Game } from "@game/game";
import { staffRoleSections } from "@data/catalogue";
import type { StaffRoleId } from "@data/schema";
import { useState } from "preact/hooks";
import {
  patientTable,
  peopleDialog,
  sidePanel,
  staffTable,
  type PatientRow,
  type PeopleTab,
  type StaffRow,
} from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

export function PeopleDialog({ game }: { game: Game }) {
  const tab = peopleDialog.value;
  if (!tab) return null;
  const setTab = (t: PeopleTab) => {
    peopleDialog.value = t;
    game.refreshPanels();
  };
  // Show the person, and get the dialog out of the way.
  const show = (id: number) => {
    peopleDialog.value = null;
    game.showAgent(id);
  };
  return (
    <section class="panel people-dialog" role="dialog" aria-label="People">
      <header class="people-header">
        <div class="tabs" role="tablist">
          {(["patients", "staff"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              class={tab === t ? "active" : ""}
              onMouseDown={noFocus}
              onClick={() => setTab(t)}
            >
              {t === "patients" ? "Patients" : "Staff"}
            </button>
          ))}
        </div>
        <button class="close" title="Close (Esc)" onClick={() => (peopleDialog.value = null)}>
          ×
        </button>
      </header>
      {tab === "patients" ? <PatientsTab onShow={show} /> : <StaffTab game={game} onShow={show} />}
    </section>
  );
}

// ---------- Patients ----------

type PatientFilter = "all" | "waiting" | "treatment" | "ward" | "attention";
type PatientSort = "urgency" | "wait" | "mood";

const PATIENT_FILTERS: { id: PatientFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting" },
  { id: "treatment", label: "Being seen" },
  { id: "ward", label: "On wards" },
  { id: "attention", label: "Needs attention" },
];

/** Overdue, over 4 hours, unhappy, or with an unmet need. */
const needsAttention = (r: PatientRow) =>
  r.overdue || r.breached || r.mood < 30 || r.needs.some((n) => n !== "At the toilet");

function PatientsTab({ onShow }: { onShow: (id: number) => void }) {
  const [filter, setFilter] = useState<PatientFilter>("all");
  const [sort, setSort] = useState<PatientSort>("urgency");
  const data = patientTable.value;
  if (!data) return null;
  const c = data.counts;
  let rows = data.rows.filter((r) =>
    filter === "all"
      ? r.group !== "ward"
      : filter === "ward"
        ? r.group === "ward"
        : filter === "attention"
          ? needsAttention(r)
          : filter === "waiting"
            ? r.group === "waiting" || r.group === "arriving"
            : r.group === "treatment",
  );
  if (sort === "wait") rows = [...rows].sort((a, b) => b.inDeptMins - a.inDeptMins);
  if (sort === "mood") rows = [...rows].sort((a, b) => a.mood - b.mood);

  return (
    <>
      <p class="people-summary">
        <strong>{c.total}</strong> in A&E · {c.arriving} arriving · {c.waiting} waiting ·{" "}
        {c.treatment} being seen
        {c.breached > 0 && <span class="bad-text"> · {c.breached} over 4 hours</span>}
        {c.ward > 0 && <span> · {c.ward} on wards</span>}
        {data.longestWait && <span class="dim"> · longest stay {data.longestWait}</span>}
      </p>
      <div class="people-controls">
        <div class="chips" role="group" aria-label="Filter">
          {PATIENT_FILTERS.map((f) => (
            <button
              key={f.id}
              class={filter === f.id ? "active" : ""}
              aria-pressed={filter === f.id}
              onMouseDown={noFocus}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label class="sort">
          Sort{" "}
          <select
            value={sort}
            onChange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as PatientSort)}
          >
            <option value="urgency">Most urgent</option>
            <option value="wait">Longest in A&E</option>
            <option value="mood">Unhappiest</option>
          </select>
        </label>
      </div>
      <div class="people-scroll">
        {rows.length === 0 ? (
          <p class="dim empty">{c.total === 0 ? "No patients in A&E." : "No one matches."}</p>
        ) : (
          <table class="people-table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Triage</th>
                <th>Status</th>
                <th>Target</th>
                <th class="num">In A&E</th>
                <th>Mood</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onShow(r.id)} title="Show on the map">
                  <td>
                    <strong>{r.name}</strong>
                    <span class="sub">{r.condition}</span>
                  </td>
                  <td>
                    {r.category ? (
                      <span
                        class="triage-chip"
                        style={{ background: r.category.colour }}
                        title={`To be seen ${r.category.target}`}
                      >
                        {r.category.label}
                      </span>
                    ) : (
                      <span class="dim">Not yet</span>
                    )}
                  </td>
                  <td>
                    {r.status}
                    <span class="sub">{r.where}</span>
                    {r.reason && <span class="sub warn-text">{r.reason}</span>}
                  </td>
                  <td class={r.overdue ? "bad-text" : r.target === "Seen" ? "ok-text" : ""}>
                    {r.target}
                  </td>
                  <td class={`num${r.breached ? " bad-text" : ""}`}>{r.inDept}</td>
                  <td>
                    <div class="meter small" title={`Mood ${r.mood} / 100`}>
                      <div
                        class={`meter-fill${r.mood < 25 ? " bad" : r.mood < 50 ? " warn" : ""}`}
                        style={{ width: `${r.mood}%` }}
                      />
                    </div>
                    {r.needs.length > 0 && <span class="sub warn-text">{r.needs.join(" · ")}</span>}
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

// ---------- Staff ----------

/** "All", then each role in staff-group order. */
const ROLE_FILTERS: { id: StaffRoleId | "all"; label: string }[] = [
  { id: "all", label: "All" },
  ...staffRoleSections().flatMap((s) => s.items.map((r) => ({ id: r.id, label: r.short }))),
];

const STATUS_LABELS: Record<StaffRow["status"], string> = {
  free: "Free",
  on_the_way: "On the way",
  waiting: "Waiting for patient",
  working: "Working",
  at_desk: "At desk",
  no_desk: "No desk",
  off_site: "Off site",
};

function StaffTab({ game, onShow }: { game: Game; onShow: (id: number) => void }) {
  const [role, setRole] = useState<StaffRoleId | "all">("all");
  const data = staffTable.value;
  if (!data) return null;
  const rows = data.rows.filter((r) => role === "all" || r.roleId === role);
  return (
    <>
      <p class="people-summary">
        <strong>{data.rows.length}</strong> on staff · {data.busy} busy · {data.free} free or
        waiting at a desk
        <button
          class="small-button summary-action"
          onMouseDown={noFocus}
          onClick={() => {
            peopleDialog.value = null;
            sidePanel.value = "staff";
            game.refreshPanels();
          }}
        >
          Hire staff…
        </button>
      </p>
      <div class="people-controls">
        <div class="chips" role="group" aria-label="Role">
          {ROLE_FILTERS.map((f) => {
            const n =
              f.id === "all" ? data.rows.length : data.rows.filter((r) => r.roleId === f.id).length;
            return (
              <button
                key={f.id}
                class={role === f.id ? "active" : ""}
                aria-pressed={role === f.id}
                onMouseDown={noFocus}
                onClick={() => setRole(f.id)}
              >
                {f.label} <span class="dim">{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div class="people-scroll">
        {rows.length === 0 ? (
          <p class="dim empty">
            {data.rows.length === 0
              ? "No staff yet. Hire a team to open your A&E."
              : "No one in this role."}
          </p>
        ) : (
          <table class="people-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Doing</th>
                <th>Where</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onShow(r.id)} title="Show on the map">
                  <td>
                    <strong>{r.name}</strong>
                    <span class="sub">{r.role}</span>
                  </td>
                  <td>
                    <span class={`status-pill ${r.status}`}>{STATUS_LABELS[r.status]}</span>
                  </td>
                  <td>
                    {r.activity}
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
                          onShow(r.patient!.id);
                        }}
                      >
                        Show patient
                      </button>
                    )}
                  </td>
                  <td>{r.where}</td>
                  <td>
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
