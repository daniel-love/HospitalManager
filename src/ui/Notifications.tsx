/**
 * The notifications feed (GAME_DESIGN §11): warnings and events from the
 * sim, newest first. Each leaves the feed after a few seconds (longer for
 * warnings), unless the mouse is over it; the last few dozen stay in the
 * history. Clicking one with a location jumps the camera there; a staffing
 * one opens the Staff screen.
 */
import type { Game } from "@game/game";
import { useEffect, useState } from "preact/hooks";
import { notifications, type Notification } from "./store";

const COLLAPSED = 4;
/** After the mouse leaves the feed, what's still showing stays at least this long (ms). */
const LINGER_MS = 3000;

export function Notifications({ game }: { game: Game }) {
  const [history, setHistory] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const items = notifications.value;
  const live = items.filter((n) => n.until > now);

  // Re-check expiry while anything is showing (frozen while hovered).
  useEffect(() => {
    if (hovered || live.length === 0) return;
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [hovered, live.length > 0]);
  // New notifications arrive with fresh expiry times: catch up the clock.
  useEffect(() => {
    if (!hovered) setNow(performance.now());
  }, [items]);

  if (items.length === 0) return null;
  if (!history && live.length === 0) {
    return (
      <section class="panel notifications idle" aria-label="Notifications">
        <div class="notifications-footer">
          <button onClick={() => setHistory(true)}>Notifications ({items.length})</button>
        </div>
      </section>
    );
  }
  const shown = history ? items : live.slice(0, COLLAPSED);
  const leave = () => {
    setHovered(false);
    const t = performance.now();
    // Don't snatch away what was being read.
    notifications.value = items.map((n) =>
      n.until > now && n.until < t + LINGER_MS ? { ...n, until: t + LINGER_MS } : n,
    );
    setNow(t);
  };
  return (
    <section
      class={`panel notifications${history ? " expanded" : ""}`}
      aria-label="Notifications"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={leave}
    >
      <ul>
        {shown.map((n) => (
          <Item key={n.id} n={n} game={game} />
        ))}
      </ul>
      <div class="notifications-footer">
        <button onClick={() => setHistory(!history)}>
          {history ? "Hide history" : `History (${items.length})`}
        </button>
        <button
          onClick={() => {
            notifications.value = [];
            setHistory(false);
          }}
        >
          Clear
        </button>
      </div>
    </section>
  );
}

function Item({ n, game }: { n: Notification; game: Game }) {
  return (
    <li class={n.severity}>
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
  );
}
