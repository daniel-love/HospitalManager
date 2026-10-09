/**
 * Settings: the hospital's catchment (saved with the game), and how often to
 * autosave and whether to smooth edges (kept in this browser for every
 * game). A fuller menu comes later.
 */
import { useEffect, useState } from "preact/hooks";
import { AMBULANCES_PER_100K, CATCHMENTS, WALK_INS_PER_100K } from "@data/patients";
import type { Game } from "@game/game";
import { dailyDemand, treatableShare } from "@sim/systems/arrivals";
import { ANTIALIAS_OPTIONS, AUTOSAVE_OPTIONS, settings, settingsOpen } from "./settings";

export function SettingsDialog({ game }: { game: Game }) {
  if (!settingsOpen.value) return null;
  return <SettingsBody game={game} />;
}

/** The choice the game started with (the drawing surface can't change it later). */
const startupAntialias = settings.value.antialias;

const perDay = (perHundredK: number, population: number) =>
  Math.round((perHundredK * population) / 100_000);

function SettingsBody({ game }: { game: Game }) {
  const close = () => (settingsOpen.value = false);
  const [catchment, setCatchment] = useState(game.state.settings.catchment);
  const choose = (population: number) => {
    game.setCatchment(population);
    setCatchment(population);
  };
  // What actually comes here, given what's been built.
  const demand = dailyDemand(game.state);
  const walkIns = Math.round(demand.walkIns * treatableShare(game.state, "walk_in"));
  const ambulances = Math.round(demand.ambulances * treatableShare(game.state, "ambulance"));

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
          <legend>Catchment</legend>
          <p class="dim">
            The population your hospital serves, at real UK rates per person. Patients you can't
            treat go to a neighbouring hospital, and ambulance control sends ambulances elsewhere
            while crews are queueing outside. Saved with this game.
          </p>
          {CATCHMENTS.map((c) => (
            <label class="setting-choice" key={c.id}>
              <input
                type="radio"
                name="catchment"
                checked={catchment === c.population}
                onChange={() => choose(c.population)}
              />
              <span>
                {c.name} ({(c.population / 1000).toFixed(0)}k)
              </span>
              <span class="dim">
                ~{perDay(WALK_INS_PER_100K, c.population)} walk-ins, ~
                {perDay(AMBULANCES_PER_100K, c.population)} ambulances a day
              </span>
            </label>
          ))}
          <p class="dim">
            With what you've built, about {walkIns} walk-ins and {ambulances} ambulances a day come
            here.
          </p>
        </fieldset>

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

        <fieldset class="setting">
          <legend>Smooth edges</legend>
          <p class="dim">
            Antialiasing. On retina screens it costs a lot of drawing for little visible difference,
            and can make movement stutter in Safari.
          </p>
          {ANTIALIAS_OPTIONS.map((o) => (
            <label class="setting-choice" key={o.id}>
              <input
                type="radio"
                name="antialias"
                checked={settings.value.antialias === o.id}
                onChange={() => (settings.value = { ...settings.value, antialias: o.id })}
              />
              <span>{o.label}</span>
              <span class="dim">{o.hint}</span>
            </label>
          ))}
          {settings.value.antialias !== startupAntialias && (
            <p class="warn-text">
              Applies after a reload. Your game is kept.{" "}
              <button onClick={() => location.reload()}>Reload now</button>
            </p>
          )}
        </fieldset>
      </div>
    </div>
  );
}
