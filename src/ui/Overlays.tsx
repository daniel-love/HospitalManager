/** Small floating bits: the build cursor tooltip and toast messages. */
import { cursorInfo, toasts } from "./store";

export function CursorInfo() {
  const info = cursorInfo.value;
  if (!info) return null;
  return (
    <div
      class={`cursor-info${info.ok ? "" : " bad"}`}
      style={{ left: `${info.x + 16}px`, top: `${info.y + 18}px` }}
    >
      {info.text}
    </div>
  );
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
