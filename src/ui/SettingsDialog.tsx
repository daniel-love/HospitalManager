/**
 * Settings: the hospital's catchment and private-care policies (saved with
 * the game), shifts for
 * hospitals saved before rotas, and how often to
 * autosave and whether to smooth edges (kept in this browser for every
 * game). A fuller menu comes later.
 */
import { useEffect, useState } from "preact/hooks";
import { content } from "@data/catalogue";
import { PRIVATE } from "@data/economy";
import { AMBULANCES_PER_100K, CATCHMENTS, WALK_INS_PER_100K } from "@data/patients";
import type { SpecialtyId } from "@data/schema";
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
            {game.state.funding === "private"
              ? "A private hospital has no A&E: the catchment sets how many people might come for private care, and NHS patients who choose you."
              : `With what you've built, about ${walkIns} walk-ins and ${ambulances} ambulances a day come here.`}
          </p>
        </fieldset>

        {game.state.funding !== "nhs" && <PrivateCareSetting game={game} />}

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

/**
 * Private care (a Private Hospital or Hybrid trust's policies, saved with
 * the game): the self-pay price level, and in a Private Hospital which
 * specialties take NHS referrals.
 */
function PrivateCareSetting({ game }: { game: Game }) {
  const state = game.state;
  const [price, setPrice] = useState(state.policies.priceLevel);
  const [nhs, setNhs] = useState({ ...state.policies.nhsReferrals });
  const [lo, hi] = PRIVATE.priceLevels;
  const demand = Math.round(100 * price ** -PRIVATE.priceElasticity);
  const choose = (level: number) => {
    game.setPriceLevel(level);
    setPrice(level);
  };
  const toggle = (sp: SpecialtyId, on: boolean) => {
    game.setNhsReferrals(sp, on);
    setNhs({ ...state.policies.nhsReferrals });
  };
  return (
    <fieldset class="setting">
      <legend>Private care</legend>
      <p class="dim">
        Self-pay patients pay your package prices; insurers pay their own negotiated rates. Higher
        prices earn more from each self-pay patient but bring fewer of them.
      </p>
      <label class="price-level">
        <span>
          Self-pay prices:{" "}
          {price === 1
            ? "standard"
            : `${price > 1 ? "+" : "−"}${Math.round(Math.abs(price - 1) * 100)}%`}
        </span>
        <input
          type="range"
          min={lo}
          max={hi}
          step={0.05}
          value={price}
          onInput={(e) => choose(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="dim">Self-pay demand at {demand}% of standard</span>
      </label>
      {state.funding === "private" && (
        <>
          <p class="dim">
            NHS patients can choose an independent hospital for planned care, paid at NHS tariff
            (lower than private fees) and counted against the 18-week standard. Take them for:
          </p>
          <div class="nhs-referrals">
            {content.specialties
              .filter((sp) => sp.outpatients)
              .map((sp) => (
                <label key={sp.id} class="setting-choice">
                  <input
                    type="checkbox"
                    checked={!!nhs[sp.id]}
                    onChange={(e) => toggle(sp.id, (e.currentTarget as HTMLInputElement).checked)}
                  />
                  <span>{sp.name}</span>
                </label>
              ))}
          </div>
        </>
      )}
    </fieldset>
  );
}
