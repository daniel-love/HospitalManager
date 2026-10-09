/**
 * The notifications feed (GAME_DESIGN §11): warnings and events from the
 * sim, newest first. Clicking one with a location jumps the camera there.
 */
import type { Game } from "@game/game";
import { useState } from "preact/hooks";
import { notifications } from "./store";

const COLLAPSED = 4;

export function Notifications({ game }: { game: Game }) {
  const [expanded, setExpanded] = useState(false);
  const items = notifications.value;
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, COLLAPSED);
  return (
    <section class={`panel notifications${expanded ? " expanded" : ""}`} aria-label="Notifications">
      <ul>
        {shown.map((n) => (
          <li key={n.id} class={n.severity}>
            <button
              disabled={!n.at}
              title={n.at ? "Show on the map" : undefined}
              onClick={() => n.at && game.focus(n.at)}
            >
              <span class="when">{n.when.replace(/^\w{3} day \d+\s+/, "")}</span>
              {n.text}
            </button>
          </li>
        ))}
      </ul>
      <div class="notifications-footer">
        {items.length > COLLAPSED && (
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show fewer" : `Show all ${items.length}`}
          </button>
        )}
        <button onClick={() => (notifications.value = [])}>Clear</button>
      </div>
    </section>
  );
}
