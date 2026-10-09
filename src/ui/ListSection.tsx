/**
 * A titled section of a panel list: the Hire panel's staff groups and the
 * build palettes' sections. Every grouped list uses this, so spacing between
 * headings is the same everywhere (see .list-section in styles.css).
 */
import type { ComponentChildren } from "preact";

export function ListSection({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="list-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
