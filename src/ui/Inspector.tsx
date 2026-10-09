import type { SpecialtyId } from "@data/schema";
import { formatMoney } from "@game/tools";
import { inspector, type AgentInfo } from "./store";

export function Inspector({
  onClose,
  onMove,
  onWardSpecialty,
  onMeDuty,
}: {
  onClose: () => void;
  onMove: (objectId: number) => void;
  onWardSpecialty: (specialty: SpecialtyId | null) => void;
  onMeDuty: (staffId: number, on: boolean) => void;
}) {
  const data = inspector.value;
  if (!data) return null;
  const { room, object, agent } = data;
  return (
    <aside class="panel inspector" aria-label="Inspector">
      <button class="close" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
      {agent && <AgentSection agent={agent} onMeDuty={onMeDuty} />}
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
            <label class="ward-specialty">
              Specialty{" "}
              <select
                value={room.specialty.value ?? ""}
                onChange={(e) => {
                  const v = (e.currentTarget as HTMLSelectElement).value;
                  onWardSpecialty(v === "" ? null : (v as SpecialtyId));
                }}
              >
                <option value="">Any specialty</option>
                {room.specialty.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <span class="dim">
                Patients go to their own specialty's ward first, then one for any specialty, and
                only then to another specialty's ward (an outlier).
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

function AgentSection({
  agent,
  onMeDuty,
}: {
  agent: AgentInfo;
  onMeDuty: (staffId: number, on: boolean) => void;
}) {
  if (agent.kind === "staff") {
    return (
      <section>
        <h2>{agent.name}</h2>
        <p class="dim">
          {agent.role} · {formatMoney(agent.annualCost)}/yr
        </p>
        <p>{agent.activity}</p>
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
        <h4>Morale</h4>
        <div class="meter" title={`${agent.morale} / 100`}>
          <div
            class={`meter-fill${agent.morale < 40 ? " bad" : agent.morale < 60 ? " warn" : ""}`}
            style={{ width: `${agent.morale}%` }}
          />
        </div>
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
          <span class="dim">to be seen {agent.category.target}</span>
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
