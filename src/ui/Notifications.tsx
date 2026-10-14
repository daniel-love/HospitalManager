/**
 * The notifications feed (GAME_DESIGN §11): warnings and events from the
 * sim, newest first. Clicking one with a location jumps the camera there;
 * a staffing one opens the Staff screen.
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
              disabled={!n.at && !n.staff && !n.finance && !n.hospital}
              title={
                n.staff
                  ? "Open the Staff screen"
                  : n.finance
                    ? "Open Finance"
                    : n.hospital
                      ? "Open the Hospital dialog"
                      : n.at
                        ? "Show on the map"
                        : undefined
              }
              onClick={() => {
                if (n.staff) game.openStaff(n.staff.tab, n.staff.id ?? null);
                else if (n.finance) game.openFinance(n.finance);
                else if (n.hospital) game.openHospital(n.hospital);
                else if (n.at) game.focus(n.at);
              }}
            >
              <span class="when">{n.when.replace(/^\w{3} \d+ \w{3}( Y\d+)?\s+/, "")}</span>
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
