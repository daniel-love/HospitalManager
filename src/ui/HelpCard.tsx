/**
 * Hover help cards. One follows the mouse over the map; the other sits beside
 * the hovered build palette entry. Both are kept inside the window.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import type { HelpContent } from "./help";
import { mapHelp, paletteHelp } from "./store";

export function MapHelp() {
  const h = mapHelp.value;
  return h ? <Card content={h.content} x={h.x + 18} y={h.y + 18} /> : null;
}

export function PaletteHelp() {
  const h = paletteHelp.value;
  return h ? <Card content={h.content} x={h.x} y={h.y} /> : null;
}

function Card({ content: c, x, y }: { content: HelpContent; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);

  // Keep the card on screen, flipping it above/left of the anchor if needed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const left = x + width + margin > innerWidth ? Math.max(margin, x - width - 36) : x;
    const top =
      y + height + margin > innerHeight ? Math.max(margin, innerHeight - height - margin) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  return (
    <div ref={ref} class="help-card" role="tooltip" style={{ left: `${x}px`, top: `${y}px` }}>
      <div class="help-title">
        {c.title}
        {c.badge && <span class={`badge ${c.badge.ok ? "ok" : "bad"}`}>{c.badge.text}</span>}
      </div>
      {c.subtitle && <div class="help-subtitle">{c.subtitle}</div>}
      {c.body && <p>{c.body}</p>}
      {c.sections?.map((s) => (
        <div key={s.heading} class="help-section">
          <h4>{s.heading}</h4>
          <ul>
            {s.items.map((item) => (
              <li key={item.text} class={item.ok === undefined ? "" : item.ok ? "ok" : "bad"}>
                {item.ok !== undefined && <span aria-hidden="true">{item.ok ? "✓ " : "✗ "}</span>}
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {c.footer && <div class="help-footer">{c.footer}</div>}
    </div>
  );
}
