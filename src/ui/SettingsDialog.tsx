/**
 * Settings: for now just how often to autosave. A fuller menu comes later.
 */
import { useEffect } from "preact/hooks";
import { AUTOSAVE_OPTIONS, settings, settingsOpen } from "./settings";

export function SettingsDialog() {
  if (!settingsOpen.value) return null;
  return <SettingsBody />;
}

function SettingsBody() {
  const close = () => (settingsOpen.value = false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="panel modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button class="close" title="Close (Esc)" onClick={close}>
          ×
        </button>
        <h2 id="settings-title">Settings</h2>

        <fieldset class="setting">
          <legend>Autosave</legend>
          <p class="dim">
            Times are in game time. The three most recent autosaves are kept. Whatever you choose,
            reloading or reopening the game picks up where you left off.
          </p>
          {AUTOSAVE_OPTIONS.map((o) => (
            <label class="setting-choice" key={o.id}>
              <input
                type="radio"
                name="autosave"
                checked={settings.value.autosave === o.id}
                onChange={() => (settings.value = { ...settings.value, autosave: o.id })}
              />
              <span>{o.label}</span>
              <span class="dim">{o.hint}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}
