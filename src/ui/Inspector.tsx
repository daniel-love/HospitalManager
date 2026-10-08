import { formatMoney } from "@game/tools";
import { inspector } from "./store";

export function Inspector({
  onClose,
  onMove,
}: {
  onClose: () => void;
  onMove: (objectId: number) => void;
}) {
  const data = inspector.value;
  if (!data) return null;
  const { room, object } = data;
  return (
    <aside class="panel inspector" aria-label="Inspector">
      <button class="close" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
      {object && (
        <section>
          <h2>{object.name}</h2>
          <p class="dim">{object.description}</p>
          <p class="dim">
            Cost {formatMoney(object.cost)}
            {object.upkeep !== undefined && ` · upkeep ${formatMoney(object.upkeep)}/month`}
          </p>
          {object.access && <p class="dim">Access: {object.access}</p>}
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
