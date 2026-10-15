/**
 * Settings: the hospital's name and catchment (saved with the game), shifts for
 * hospitals saved before rotas, and how often to
 * autosave and whether to smooth edges (kept in this browser for every
 * game). A fuller menu comes later.
 */
import { useEffect, useState } from "preact/hooks";
import { HOSPITAL_NAME_MAX, randomHospitalName } from "@data/names";
import { AMBULANCES_PER_100K, CATCHMENTS, WALK_INS_PER_100K } from "@data/patients";
import type { EventFrequency } from "@data/pressure";
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

        <NameSetting game={game} />

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
            {game.state.funding === "private"
              ? "A private hospital has no A&E: the catchment sets how many people might come for private care, and NHS patients who choose you."
              : `With what you've built, about ${walkIns} walk-ins and ${ambulances} ambulances a day come here.`}
          </p>
        </fieldset>

        <EventsSetting game={game} />

        <RecruitmentSetting game={game} />

        {!game.state.settings.rotas && <RotasSetting game={game} />}

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

/** The hospital's name (saved with the game). Renames as you type; a blank name isn't kept. */
function NameSetting({ game }: { game: Game }) {
  const [name, setName] = useState(game.state.name);
  const rename = (value: string) => {
    setName(value);
    game.setHospitalName(value);
  };
  return (
    <fieldset class="setting">
      <legend>Hospital name</legend>
      <div class="hospital-name-field">
        <input
          aria-label="Hospital name"
          type="text"
          value={name}
          maxLength={HOSPITAL_NAME_MAX}
          spellcheck={false}
          onInput={(e) => rename(e.currentTarget.value)}
          onBlur={() => setName(game.state.name)}
        />
        <button title="Make up another name" onClick={() => rename(randomHospitalName())}>
          Another
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Hospitals saved before rotas had everyone working around the clock. This
 * starts shifts for them; there's no going back, since real staff don't work
 * around the clock.
 */
function RotasSetting({ game }: { game: Game }) {
  const [on, setOn] = useState(false);
  if (on) return null;
  return (
    <fieldset class="setting">
      <legend>Shifts and rotas</legend>
      <p class="dim">
        This hospital was saved before rotas, so everyone works around the clock. With shifts, each
        person works three 12½-hour shifts a week, so you'll need about five people for every post
        you want filled day and night (set cover levels in the Staff screen's Rota tab). There's no
        switching back.
      </p>
      <button
        onClick={() => {
          game.setRotas(true);
          setOn(true);
        }}
      >
        Start shifts and rotas
      </button>
    </fieldset>
  );
}

const EVENT_OPTIONS: { id: EventFrequency; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "No pressure events" },
  { id: "rare", label: "Rare", hint: "About half the real-world rate" },
  {
    id: "realistic",
    label: "Realistic",
    hint: "Flu seasons in winter, heatwaves in summer, at about real-world rates",
  },
  { id: "frequent", label: "Frequent", hint: "About twice the real-world rate" },
];

/** How often pressure events come (saved with the game). */
function EventsSetting({ game }: { game: Game }) {
  const [frequency, setFrequency] = useState(game.state.settings.eventFrequency);
  return (
    <fieldset class="setting">
      <legend>Events</legend>
      <p class="dim">
        Winter pressures, heatwaves and other events that test the hospital. Each is forecast a few
        days ahead; Hospital → Events says what you can do. Saved with this game.
      </p>
      {EVENT_OPTIONS.map((o) => (
        <label class="setting-choice" key={o.id}>
          <input
            type="radio"
            name="events"
            checked={frequency === o.id}
            onChange={() => {
              game.setEventFrequency(o.id);
              setFrequency(o.id);
            }}
          />
          <span>{o.label}</span>
          <span class="dim">{o.hint}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Hiring from applicants, or instantly (saved with the game). */
function RecruitmentSetting({ game }: { game: Game }) {
  const [on, setOn] = useState(game.state.settings.recruitment);
  const choose = (value: boolean) => {
    game.setRecruitment(value);
    setOn(value);
  };
  return (
    <fieldset class="setting">
      <legend>Recruitment</legend>
      <p class="dim">
        Hiring from applicants, who come in over time: more of them, and more skilled, with a good
        reputation and CQC rating. Hard-to-fill posts such as consultants come slowly. Saved with
        this game.
      </p>
      <label class="setting-choice">
        <input type="radio" name="recruitment" checked={on} onChange={() => choose(true)} />
        <span>From applicants</span>
        <span class="dim">As for real vacancies</span>
      </label>
      <label class="setting-choice">
        <input type="radio" name="recruitment" checked={!on} onChange={() => choose(false)} />
        <span>Hire instantly</span>
        <span class="dim">Anyone, any time</span>
      </label>
    </fieldset>
  );
}
