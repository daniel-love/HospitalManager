/**
 * Save / load screen: named save slots and autosaves in IndexedDB, plus
 * export to and import from .hospital.json files.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import {
  deleteSave,
  exportSave,
  importSaveFile,
  listSaves,
  loadGame,
  saveGame,
  type SaveSlot,
} from "@save/saveManager";
import { saveDialogOpen, showToast } from "./store";

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SaveDialog({ game }: { game: Game }) {
  if (!saveDialogOpen.value) return null;
  return <SaveDialogBody game={game} />;
}

function SaveDialogBody({ game }: { game: Game }) {
  const [slots, setSlots] = useState<SaveSlot[] | null>(null);
  const [name, setName] = useState("My hospital");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = () => (saveDialogOpen.value = false);

  const refresh = () =>
    listSaves()
      .then(setSlots)
      .catch((err: unknown) => {
        setSlots([]);
        showToast(`Couldn't read saves: ${message(err)}`, "error");
      });

  useEffect(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Runs an async action with the buttons disabled, reporting failures. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      showToast(message(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const onSave = (e: Event) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      await saveGame(game.state, trimmed);
      showToast(`Saved "${trimmed}"`);
      await refresh();
    });
  };

  const onLoad = (slot: SaveSlot) =>
    run(async () => {
      game.loadState(await loadGame(slot.id));
      if (!slot.autosave) setName(slot.meta.name);
      showToast(`Loaded "${slot.meta.name}"`);
      close();
    });

  const onDelete = (slot: SaveSlot) => {
    if (!confirm(`Delete "${slot.meta.name}"? This can't be undone.`)) return;
    void run(async () => {
      await deleteSave(slot.id);
      await refresh();
    });
  };

  const onImport = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void run(async () => {
      game.loadState(await importSaveFile(file));
      showToast(`Imported ${file.name}. Save it to keep it in your list.`);
      close();
    });
  };

  const onNewGame = () => {
    if (!confirm("Start a new hospital? Anything unsaved will be lost.")) return;
    game.newGame();
    close();
  };

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="panel modal" role="dialog" aria-modal="true" aria-labelledby="save-title">
        <button class="close" title="Close (Esc)" onClick={close}>
          ×
        </button>
        <h2 id="save-title">Save &amp; load</h2>

        <form class="save-row" onSubmit={onSave}>
          <input
            aria-label="Save name"
            value={name}
            maxLength={60}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <button class="primary" type="submit" disabled={busy || !name.trim()}>
            Save
          </button>
        </form>

        <div class="slots">
          {slots === null && <p class="dim">Loading…</p>}
          {slots?.length === 0 && <p class="dim">No saves yet.</p>}
          {slots?.map((slot) => (
            <div class="slot" key={slot.id}>
              <div class="slot-info">
                <strong>{slot.meta.name}</strong>
                <span class="dim">
                  {slot.meta.gameTime.replace(/\s+/g, " ")} · {formatMoney(slot.meta.money)} · saved{" "}
                  {dateFormat.format(new Date(slot.meta.savedAt))}
                </span>
              </div>
              <button disabled={busy} onClick={() => void onLoad(slot)}>
                Load
              </button>
              <button
                disabled={busy}
                title="Download as a .hospital.json file"
                onClick={() => void run(() => exportSave(slot.id))}
              >
                Export
              </button>
              <button disabled={busy} title="Delete" onClick={() => onDelete(slot)}>
                Delete
              </button>
            </div>
          ))}
        </div>

        <div class="modal-footer">
          <button disabled={busy} onClick={() => fileInput.current?.click()}>
            Import file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={onImport}
          />
          <button disabled={busy} onClick={onNewGame}>
            New game
          </button>
        </div>
      </div>
    </div>
  );
}
