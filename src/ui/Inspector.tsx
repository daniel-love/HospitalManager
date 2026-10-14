import type { SpecialtyId } from "@data/schema";
import { formatMoney } from "@game/tools";
import { inspector, type AgentInfo } from "./store";

export function Inspector({
  onClose,
  onMove,
  onRoomSpecialty,
  onMeDuty,
  onClinicSessions,
  onTheatreSessions,
  onPrivateSessions,
  onEmergencyTheatre,
  onPrivateRoom,
}: {
  onClose: () => void;
  onMove: (objectId: number) => void;
  onRoomSpecialty: (specialty: SpecialtyId | null) => void;
  onMeDuty: (staffId: number, on: boolean) => void;
  onClinicSessions: (staffId: number, sessions: number) => void;
  onTheatreSessions: (staffId: number, sessions: number) => void;
  onPrivateSessions: PrivateSessionsHandler;
  onEmergencyTheatre: (on: boolean) => void;
  onPrivateRoom: (on: boolean) => void;
}) {
  const data = inspector.value;
  if (!data) return null;
  const { room, object, agent } = data;
  return (
    <aside class="panel inspector" aria-label="Inspector">
      <button class="close" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
      {agent && (
        <AgentSection
          agent={agent}
          onMeDuty={onMeDuty}
          onClinicSessions={onClinicSessions}
          onTheatreSessions={onTheatreSessions}
          onPrivateSessions={onPrivateSessions}
        />
      )}
      {object && (
        <section>
          <h2>{object.name}</h2>
          <p class="dim">{object.description}</p>
          <p class="dim">
            Cost {formatMoney(object.cost)}
            {object.upkeep !== undefined && ` · upkeep ${formatMoney(object.upkeep)}/month`}
          </p>
          {object.access && <p class="dim">Access: {object.access}</p>}
          {object.cover && (
            <p class={object.cover.ok ? "ok-text" : "warn-text"}>{object.cover.text}</p>
          )}
          {object.capabilities.length > 0 && <Tags items={object.capabilities} />}
          {object.movable && (
            <button
              class="inspector-action"
              title="Pick up and place elsewhere (free)"
              onClick={() => onMove(object.id)}
            >
              Move
            </button>
          )}
        </section>
      )}
      {room && (
        <section>
          <h2>
            {room.name}{" "}
            <span class={room.valid ? "badge ok" : "badge bad"}>
              {room.valid ? "Valid" : "Invalid"}
            </span>
          </h2>
          <p class="dim">
            {room.department} · {room.size}
          </p>
          <p class="dim">{room.description}</p>
          {room.specialty && (
            <label class="room-specialty">
              Specialty{" "}
              <select
                value={room.specialty.value ?? ""}
                onChange={(e) => {
                  const v = (e.currentTarget as HTMLSelectElement).value;
                  onRoomSpecialty(v === "" ? null : (v as SpecialtyId));
                }}
              >
                <option value="">Any specialty</option>
                {room.specialty.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <span class="dim">{room.specialty.note}</span>
            </label>
          )}
          {room.emergency !== undefined && (
            <label class="duty-toggle">
              <input
                type="checkbox"
                checked={room.emergency}
                onChange={(e) => onEmergencyTheatre((e.currentTarget as HTMLInputElement).checked)}
              />{" "}
              Keep for emergencies
              <span class="dim">
                A CEPOD theatre: no planned lists, so emergencies never cancel anyone's operation.
                Without one, emergencies take the next free slot on a list.
              </span>
            </label>
          )}
          {room.private !== undefined && (
            <label class="duty-toggle">
              <input
                type="checkbox"
                checked={room.private}
                onChange={(e) => onPrivateRoom((e.currentTarget as HTMLInputElement).checked)}
              />{" "}
              Private Patient Unit
              <span class="dim">
                For private patients only: private clinics and theatre lists are held in the unit's
                rooms, and private inpatients stay in its side rooms. NHS work uses the rest.
              </span>
            </label>
          )}
          {room.checks.length > 0 && (
            <ul class="checklist">
              {room.checks.map((c) => (
                <li key={c.label} class={c.ok ? "ok" : "bad"}>
                  <span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> {c.label}
                  {c.detail && <span class="dim"> ({c.detail})</span>}
                </li>
              ))}
            </ul>
          )}
          {room.patientsCantReach && (
            <p class="warn-text">
              Patients can't get here without walking through another clinical room. Give it a door
              onto a corridor, waiting area or reception.
            </p>
          )}
          {room.forConditions.length > 0 && (
            <>
              <h4 title="Not needed for the room to work, but some patients can't be treated here without it">
                For some conditions
              </h4>
              <ul class="checklist">
                {room.forConditions.map((c) => (
                  <li key={c.label} class={c.ok ? "ok" : "advice"}>
                    <span aria-hidden="true">{c.ok ? "✓" : "–"}</span> {c.label}
                    {c.detail && <span class="dim"> ({c.detail})</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {room.items.length > 0 && (
            <>
              <h4>Equipment</h4>
              <ul class="items">
                {room.items.map((i) => (
                  <li key={i.name}>
                    {i.count > 1 ? `${i.count} × ` : ""}
                    {i.name}
                  </li>
                ))}
              </ul>
            </>
          )}
          {room.capabilities.length > 0 && (
            <>
              <h4>Capabilities</h4>
              <Tags items={room.capabilities} />
            </>
          )}
        </section>
      )}
    </aside>
  );
}

function moodWord(mood: number): string {
  if (mood >= 75) return "Content";
  if (mood >= 50) return "Fed up";
  if (mood >= 25) return "Unhappy";
  return "Angry: may leave";
}

/** Sessions a week in a job plan, with − and + buttons. */
function SessionStepper(props: {
  title: string;
  what: string;
  plan: { sessions: number; max: number; note: string };
  onChange: (sessions: number) => void;
}) {
  const { sessions, max, note } = props.plan;
  return (
    <div class="job-plan">
      <h4>{props.title}</h4>
      <div class="stepper">
        <button
          disabled={sessions <= 0}
          onClick={() => props.onChange(sessions - 1)}
          aria-label={`Fewer ${props.what}`}
        >
          −
        </button>
        <span>
          {sessions} a week (of {max})
        </span>
        <button
          disabled={sessions >= max}
          onClick={() => props.onChange(sessions + 1)}
          aria-label={`More ${props.what}`}
        >
          +
        </button>
      </div>
      <span class="dim">{note}</span>
    </div>
  );
}

type PrivateSessionsHandler = (
  staffId: number,
  kind: "clinic" | "theatre",
  sessions: number,
) => void;

function AgentSection({
  agent,
  onMeDuty,
  onClinicSessions,
  onTheatreSessions,
  onPrivateSessions,
}: {
  agent: AgentInfo;
  onMeDuty: (staffId: number, on: boolean) => void;
  onClinicSessions: (staffId: number, sessions: number) => void;
  onTheatreSessions: (staffId: number, sessions: number) => void;
  onPrivateSessions: PrivateSessionsHandler;
}) {
  if (agent.kind === "staff") {
    return (
      <section>
        <h2>{agent.name}</h2>
        <p class="dim">
          {agent.role} · {formatMoney(agent.annualCost)}/yr
        </p>
        <p>{agent.activity}</p>
        {agent.notice && <p class="warn-text">{agent.notice}</p>}
        <p class="dim">Works: {agent.rota}</p>
        {agent.meDuty !== undefined && (
          <label class="duty-toggle">
            <input
              type="checkbox"
              checked={agent.meDuty}
              onChange={(e) => onMeDuty(agent.id, (e.currentTarget as HTMLInputElement).checked)}
            />{" "}
            Medical Examiner duty
            <span class="dim">
              Reviews deaths at a desk, Monday to Friday 09:00 to 17:00, but never a death of a
              patient they treated. Clinical work the rest of the time.
            </span>
          </label>
        )}
        {agent.clinics && (
          <SessionStepper
            title="Outpatient clinics"
            what="clinic sessions"
            plan={agent.clinics}
            onChange={(n) => onClinicSessions(agent.id, n)}
          />
        )}
        {agent.theatre && (
          <SessionStepper
            title="Theatre lists"
            what="theatre lists"
            plan={agent.theatre}
            onChange={(n) => onTheatreSessions(agent.id, n)}
          />
        )}
        {agent.privateClinics && (
          <SessionStepper
            title="Private clinics"
            what="private clinic sessions"
            plan={agent.privateClinics}
            onChange={(n) => onPrivateSessions(agent.id, "clinic", n)}
          />
        )}
        {agent.privateTheatre && (
          <SessionStepper
            title="Private theatre lists"
            what="private theatre lists"
            plan={agent.privateTheatre}
            onChange={(n) => onPrivateSessions(agent.id, "theatre", n)}
          />
        )}
        <h4>Morale</h4>
        <div class="meter" title={`${agent.morale} / 100`}>
          <div
            class={`meter-fill${agent.morale < 40 ? " bad" : agent.morale < 60 ? " warn" : ""}`}
            style={{ width: `${agent.morale}%` }}
          />
        </div>
        <span class="dim meter-note">
          Hard or short-staffed shifts wear it down. Low morale means more sickness, and below 30
          they may resign.
        </span>
        <h4>Skill</h4>
        <div class="meter" title={`${agent.skill} / 100`}>
          <div class="meter-fill" style={{ width: `${agent.skill}%` }} />
        </div>
        <span class="dim meter-note">How quickly they work. It grows with experience.</span>
        {agent.fatigue !== null && (
          <>
            <h4>Fatigue</h4>
            <div class="meter" title={`${agent.fatigue} / 100`}>
              <div
                class={`meter-fill${agent.fatigue > 75 ? " bad" : agent.fatigue > 50 ? " warn" : ""}`}
                style={{ width: `${agent.fatigue}%` }}
              />
            </div>
            <span class="dim meter-note">
              Builds through a shift, faster when busy; above half way they slow down.
            </span>
          </>
        )}
      </section>
    );
  }
  if (agent.kind === "outpatient") {
    return (
      <section>
        <h2>{agent.name}</h2>
        <p class="dim">Outpatient · {agent.visit}</p>
        <p>{agent.status}</p>
        <p class="dim">Appointment {agent.appointment}</p>
        {agent.rtt && <p class="dim">{agent.rtt}</p>}
      </section>
    );
  }
  if (agent.afterDeath) {
    return (
      <section>
        <h2>{agent.name}</h2>
        <p class="dim">{agent.condition}</p>
        <p>{agent.status}</p>
        {agent.deathStatus && (
          <p class={`death-status ${agent.deathStatus.progress}`}>{agent.deathStatus.reason}</p>
        )}
        <ul class="checklist">
          {agent.afterDeath.map((s) => (
            <li
              key={s.label}
              class={s.done ? "ok" : s.progress ? `in-hand ${s.progress}` : "pending"}
            >
              <span aria-hidden="true">
                {s.done ? "✓" : s.progress === "blocked" ? "!" : s.progress ? "●" : "○"}
              </span>{" "}
              {s.label}
              {s.detail &&
                (s.done ? (
                  <span class="dim"> ({s.detail})</span>
                ) : (
                  <div class="step-detail">{s.detail}</div>
                ))}
            </li>
          ))}
        </ul>
        <h4>Timeline</h4>
        <ul class="timeline">
          {agent.timeline.map((t) => (
            <li key={t.label}>
              <span class="when">{t.at}</span> {t.label}
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <section>
      <h2>{agent.name}</h2>
      <p class="dim">Patient · {agent.condition}</p>
      {agent.category ? (
        <p>
          <span class="triage-chip" style={{ background: agent.category.colour }}>
            {agent.category.label}
          </span>{" "}
          <span class="dim">{agent.category.note}</span>
        </p>
      ) : (
        <p class="dim">Not yet triaged</p>
      )}
      <p>{agent.status}</p>
      {agent.reason && <p class="warn-text">{agent.reason}</p>}
      <p class={agent.breached ? "bad-text" : "dim"}>
        In A&E for {agent.inDept}
        {agent.breached && " (over 4 hours)"}
      </p>
      {agent.monitoring && (
        <>
          <h4>Monitoring</h4>
          {agent.monitoring.flag && <p class="bad-text">{agent.monitoring.flag}</p>}
          {agent.monitoring.obs ? (
            <p class={agent.monitoring.obs.overdue ? "warn-text" : ""}>
              NEWS2 {agent.monitoring.obs.news}{" "}
              <span class="dim">· {agent.monitoring.obs.text}</span>
            </p>
          ) : (
            <p class="dim">No observations yet</p>
          )}
          <p class="dim">{agent.monitoring.watch}</p>
        </>
      )}
      <h4>Mood</h4>
      <div class="meter" title={`${agent.mood} / 100`}>
        <div
          class={`meter-fill${agent.mood < 25 ? " bad" : agent.mood < 50 ? " warn" : ""}`}
          style={{ width: `${agent.mood}%` }}
        />
      </div>
      <p class="dim">{moodWord(agent.mood)}</p>
      {agent.needs.length > 0 && (
        <ul class="items">
          {agent.needs.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <h4>Timeline</h4>
      <ul class="timeline">
        {agent.timeline.map((t) => (
          <li key={t.label}>
            <span class="when">{t.at}</span> {t.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tags({ items }: { items: string[] }) {
  return (
    <div class="tags">
      {items.map((c) => (
        <span key={c} class="tag">
          {c.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}
