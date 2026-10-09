# Hospital Simulator — Technical Architecture

> Status: draft v0.1 (2026-10-07). Companion to [GAME_DESIGN.md](GAME_DESIGN.md).

## 1. Stack & rationale

| Concern                   | Choice                    | Why                                                                                                                                                     |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                  | **TypeScript** (strict)   | Type safety across a large simulation; great tooling                                                                                                    |
| Build/dev server          | **Vite**                  | Instant reload, simple config                                                                                                                           |
| Rendering                 | **PixiJS v8**             | Fast 2D WebGL/WebGPU renderer, ideal for large tile maps and hundreds of sprites. It's a renderer, not an engine, which keeps the sim independent of it |
| UI panels                 | **Preact** + CSS          | Menus, inspectors and admin screens are much easier in DOM than in canvas. Preact is tiny                                                               |
| Data validation           | **Zod**                   | Validates content definitions and save files at load time                                                                                               |
| Persistence               | **IndexedDB** (via `idb`) | Large save files, multiple slots; plus file export/import                                                                                               |
| Tests                     | **Vitest**                | Fast unit and simulation tests in the same toolchain                                                                                                    |
| Desktop packaging (later) | **Tauri**                 | Small native app for macOS/Windows; saves can go to disk                                                                                                |

**Why not a full engine?** The game is mostly simulation (pathfinding, queues, jobs, economics) with simple 2D visuals. Keeping the sim as plain TypeScript makes it testable, deterministic and easy to save. Prison Architect itself is a custom engine for the same reasons.

## 2. Core principle: separate simulation from presentation

```
          ┌───────────────────────────── Game loop ─────────────────────────────┐
 input ─► │  Commands ─► Simulation (fixed tick, pure data) ─► SimState         │
          │                                                     │               │
          │                         Renderer (PixiJS) ◄─────────┤ read-only     │
          │                         UI (Preact)       ◄─────────┘ + events      │
          └─────────────────────────────────────────────────────────────────────┘
```

- **SimState** is plain, serialisable data (no class instances, no Pixi objects, no functions). Saving = `JSON.stringify(state)` plus versioning.
- **Commands:** all player actions (place wall, hire nurse, close A&E) are command objects applied by the sim. That makes undo, replay and testing straightforward, and it's a natural seam for future multiplayer or mod tools.
- **Fixed timestep:** the sim advances in fixed ticks: 10 ticks per in-game minute, 10 ticks per real second at 1× (one game minute per real second, so a day lasts 24 real minutes at 1× and 90 s at 16×). See `sim/time.ts` and `game/loop.ts`. Rendering interpolates between ticks. Speed controls simply run more ticks per frame.
- **Determinism:** a seeded PRNG (e.g. `mulberry32`/`sfc32`) lives in the state. Same seed + same commands = same outcome, so bug reports can be reproduced from a save.
- **Events out:** the sim emits domain events (`PatientArrived`, `TargetBreached`, `IncidentRaised`) for the UI notification feed and audio. Events never feed back into sim logic.

## 3. Module layout

```
src/
  main.ts                 # bootstrap: load data, create sim, renderer, UI
  game/
    loop.ts               # fixed-timestep accumulator, speeds, frame budget
    game.ts               # wires sim + loop + renderer + UI; hotkeys
  sim/
    state.ts              # SimState types (the save schema)
    agents.ts             # Patient, Staff, Job, ledger and event types
    places.ts             # seats, couches, toilets, desks, reservations, site entrance
    events.ts             # notifications out (never read back by the sim)
    sim.ts                # tick(): runs systems in order
    commands.ts           # build command types + apply()
    plan.ts               # plan mode (blueprints)
    rng.ts
    world/
      grid.ts             # multi-floor tile grid
      rooms.ts            # room detection (flood fill) + validation
      objects.ts          # footprints, access sides, placement rules
      pathfinding.ts      # A* + nearest map-edge search (floor portals later)
      los.ts              # line-of-sight raycasts
    systems/
      arrivals.ts         # walk-in and ambulance arrivals by time of day (specialty gating in M4)
      ambulances.ts       # parking spaces, queueing outside, handover
      admissions.ts       # decision to admit, porter transfers (bed-width routes), wards
      deaths.ts           # verification, family, last offices, mortuary, Medical Examiner, morale
      staffing.ts         # hire/dismiss; receptionists staff desks (shifts in M5)
      patients.ts         # A&E lifecycle, needs (seat, toilet), mood, LWBS
      jobBoard.ts         # post/remove jobs
      jobs.ts             # job board: assign, run, complete
      movement.ts         # route following, re-planning after layout changes
      finance.ts          # tariff, salaries, upkeep, daily reports
      alerts.ts           # bottleneck warnings; tidies after layout changes
      monitoring.ts       # nurse stations, coverage (cached per layout), obs rounds
      deterioration.ts    # NEWS2, noticing and escalation, cardiac arrest, incidents
      events.ts           # scenario/event scheduler (M6)
      reputation.ts       # (M6)
  data/                   # content definitions (balance by editing these)
    rooms.ts
    equipment.ts
    conditions.ts
    staff.ts              # staff roles and pay
    patients.ts           # demand profile, step durations, mood/LWBS balance
    names.ts
    events.ts
    funding.ts
    schema.ts             # Zod schemas for all of the above
  render/
    renderer.ts           # Pixi app, layers
    camera.ts             # pure camera maths (pan/zoom/screen↔world)
    cameraControls.ts     # mouse/keyboard camera input
    tilemapLayer.ts       # chunked static map rendering
    agentLayer.ts         # patients/staff sprites
    overlays/             # coverage, heatmap, validity…
  ui/
    App.tsx
    toolbar/ panels/ inspector/ notifications/
  save/
    saveManager.ts        # IndexedDB slots, autosave, export/import
    migrations.ts
tests/
  sim/                    # headless simulation tests
```

## 4. Simulation model

### 4.1 Entities

A lightweight ECS-style structure: entities are numeric IDs, and components are stored in typed maps or records in `SimState`. No external ECS library at first.

Key entity kinds and components:

- **Patient:** `Position`, `Path`, `Condition { defId, acuity, stepIndex, severity }`, `Needs`, `Mood`, `Monitoring`, `Timeline` (timestamps), `Companions[]`.
- **Companion:** `Position`, `Needs`, `Mood`, `attachedTo`.
- **Staff:** `Position`, `Role`, `Specialty?`, `Skill`, `Fatigue`, `Morale`, `Shift`, `CurrentJob?`, `HomeDept`.
- **Equipment/Object:** `TilePosition`, `defId`, `Rotation`, `Condition (wear)`, `Occupant?`, `Dirty`.
- **Room:** `tiles[]`, `type`, `departmentId`, `capabilities` (derived), `valid`, `issues[]`.
- **Department:** `rooms[]`, `status (open/closed/divert)`, `staffing rules`.

### 4.2 System order per tick

`events → arrivals → staffing (shift change) → needs → deterioration → monitoring → pathways (post jobs) → jobs (assign) → movement → job completion → finance (on day/month boundaries) → kpis/reputation`

As built in M3: `arrivals (walk-ins and ambulances) → ambulances (park, turn round, leave) → staffing (desks and nurse stations) → patients (needs, mood, lifecycle; posts jobs) → deterioration (each minute) → wards (discharge reviews, end-of-life deaths) → deaths (the process after a death, mortuary release, morale recovery) → monitoring (posts obs each minute) → jobs (assign; crash calls may pull staff off other work) → movement → jobs (progress and complete) → finance (hourly; daily report at midnight) → alerts (every 30 min)`.

**Agents** (M2) store float positions in tiles (whole numbers are tile centres) plus their position at the start of the tick, so the renderer can interpolate. Systems decide where an agent should be each tick and call `headTo()`, which plans a route once and re-plans when `layoutVersion` changes. Agents never block each other. They refer to places by **object id** (a seat, a couch, a desk), never by room id, because rooms are renumbered on every rebuild; `SimState.reserved` maps `"objectId:slot"` to the agent holding it.

**Walking speed vs the clock:** the clock runs 60× real time at 1×, so true walking speed (~7 tiles per tick) would look like teleporting. Agents walk at about 5 (patients) and 7 (staff) tiles per in-game minute instead, a ~10× slow-down that also stands in for the overheads of each move (being called, gathering belongings). Tunable in `data/patients.ts`.

### 4.3 Job board (autonomy)

- Systems **post jobs** (M2 jobs: triage, treatment steps, cubicle and toilet cleaning): `{ id, type, priority, requiredRole, requiredSkill?, specialty?, location, patientId?, duration, capabilityNeeded? }`.
- Idle staff evaluate available jobs with a scoring function (`priority × urgency − travel cost`, with policy modifiers) and claim the best one.
- Jobs have states: `open → claimed → in_progress → done | failed | cancelled`.
- Assignment is evaluated on a stagger (not every agent every tick) for performance.

### 4.4 Patient pathways

A condition's pathway is an array of steps. For each step the pathways system:

1. Finds a room in an open department with the required capability and a free spot.
2. Reserves it, and posts the move job (porter if bed-bound) and then the treatment job (role/specialty).
3. If no capable room exists in the hospital, it falls back to the A&E transfer-out flow.
4. Logs timestamps to the patient timeline for KPIs and the inspector.

### 4.5 Specialty gating

`arrivals.ts` computes the set of **available specialties** each in-game hour, from open departments plus staff (including on-call) with the specialty. Referral and elective spawn tables are filtered by this set. A&E walk-ins and ambulances are never filtered.

## 5. World

### 5.1 Grid

- One grid per floor. Each floor has a `width × height` array of tiles stored as **typed arrays** (struct-of-arrays) for memory and speed: `floorType: Uint8Array`, `wall: Uint8Array`, `door: Uint8Array`, `zone: Uint8Array`, `roomId: Uint16Array`, `objectId: Int32Array` (floor items and doors) and `mountId: Int32Array` (wall/ceiling fixtures, which share tiles with floor items).
- Multi-tile objects store their anchor plus footprint, and every covered tile references the object.
- **Land parcels:** a `parcelId: Uint16Array` per tile, plus a parcel table `{ id, price, owned, conditions }`. Build commands are rejected on unowned tiles, and buying a parcel is a command.
- **Patient volume** (the realism slider) is a single multiplier in the sim settings, applied in `arrivals.ts`, so balance data stays at real-world rates.

### 5.2 Rooms

The player paints zones (a room type per tile, `FloorGrid.zone`). After every build command, rooms are re-detected by flood fill: a room is a 4-connected area of one zone type, and walls and doors (never zoned) bound it. M1 re-detects the whole map rather than just the affected region; at 200×200 this takes a few milliseconds, so the optimisation isn't needed yet. Each room is validated against `data/rooms.ts` (minimum size, enclosure and a door where required, required equipment, seating), which produces the `checks[]` checklist shown in the inspector. Equipment counts towards a room only when its whole footprint is inside. Capabilities are the union of the contained equipment's capabilities, plus any `capabilityCombos` (e.g. defibrillator + resus trolley → `resuscitation`).

**Doors** are placed objects (so a double door is one object spanning two tiles), and they also write their kind into `FloorGrid.door` for fast lookups by room detection and, later, pathfinding.

### 5.3 Pathfinding

- **A\*** on the 8-connected grid with costs: door (slower), lift (queue), crowding (soft cost).
- **Multi-floor:** a small graph of portals (stairs/lifts). Find a portal route first, then A* per floor.
- **Movement modes:** walking, wheelchair, bed/trolley. Bed mode requires double doors, 2-wide corridors and lifts (no stairs). As built (M3): `findPath(…, bed = true)` only steps on tiles that are part of a clear 2×2 square and aren't single doors; admissions check reachability against bed-passable regions labelled once per layout.
- **Caching:** cache paths keyed by `(from-region, to-room, mode)` and invalidate per chunk on edit. If profiling demands it, move to a **Web Worker** or add flow fields for common destinations (e.g. the A&E entrance).

### 5.4 Line of sight & coverage

- A Bresenham raycast between the nurse-station tile and the bed tile. Opaque walls and closed doors block. Glass walls don't.
- `monitoring.ts` caches which stations can see which beds per `layoutVersion`, and checks live whether a nurse is at each station. A bed counts as seen if any tile of it is in sight, within 12 tiles of where the nurse stands.
- Remote-monitoring response distance uses the **path length** from the station to the bed (cached).

## 6. Data-driven content

All game content lives in `src/data/` as typed TS objects, validated by Zod at startup. Example:

```ts
// data/equipment.ts
export const equipment = [
  {
    id: "ecg_basic",
    name: "ECG (3-lead)",
    category: "diagnostic",
    tier: 1,
    cost: 1500,
    upkeep: 20,
    footprint: [1, 1],
    reliability: 0.995,
    power: true,
    grants: ["ecg_basic"],
  },
  {
    id: "ecg_12lead",
    name: "ECG (12-lead)",
    category: "diagnostic",
    tier: 2,
    cost: 6000,
    upkeep: 60,
    footprint: [1, 1],
    reliability: 0.997,
    power: true,
    grants: ["ecg_basic", "ecg_12lead"],
  },
];

// data/conditions.ts
export const conditions = [
  {
    id: "chest_pain_acs",
    name: "Chest pain (suspected ACS)",
    acuity: 2,
    specialty: "cardiology",
    monitoring: "continuous",
    tariff: 1800,
    channels: { walk_in: 3, ambulance: 6 },
    deterioration: { perHourUntreated: 0.08, crashAt: 0.9 },
    pathway: [
      { step: "triage", role: "nurse", capability: "obs", mins: 10 },
      { step: "ecg", role: "nurse", capability: "ecg_12lead", mins: 10 },
      { step: "bloods", role: "nurse", capability: "lab", mins: 60 },
      { step: "review", role: "doctor", mins: 20 },
      { step: "senior", role: "consultant", specialty: "cardiology", mins: 20, onCallOk: true },
      { step: "outcome", outcomes: { admit: { ward: "cardiac", p: 0.6 }, discharge: { p: 0.4 } } },
    ],
  },
];
```

Benefits: balancing without code changes, easy to add conditions, and a path to modding later.

## 7. Rendering

- **Layers:** ground/floor → walls → objects → agents → overlays → selection/ghost previews.
- **Chunked tilemap:** the static map is built as vector geometry per 32×32-tile chunk, rebuilt only when a chunk changes, with off-screen chunks culled. (Baking chunks to render textures was the original plan, but at 32 px/tile a 200×200 map would need ~200 MB of textures and blur when zoomed in. Revisit if profiling shows the geometry is too heavy.)
- **Agents:** a sprite pool with position interpolation between sim ticks, and culling outside the viewport.
- **Camera:** pan (WASD, edge, drag), zoom (wheel, clamped), floor switching (PgUp/PgDn).
- **Art pipeline:** start with programmer art (coloured rectangles and simple icons). Sprites are loaded via a texture atlas, so art can be swapped later without code changes.

## 8. Saving & loading

- **Format:** `{ version: number, meta: { name, createdAt, gameDate, thumbnail }, state: SimState }`, serialised as JSON. Typed arrays are encoded as base64 (and optionally compressed with `CompressionStream('gzip')`).
- **Storage:** IndexedDB object store `saves`, with autosave rotation (last 3) plus named slots.
- **Export/import:** download and upload `.hospital.json` (gzipped variant `.hospital`). Under Tauri, write to the user's documents folder.
- **Versioning:** `migrations.ts` holds an ordered list of `(fromVersion) => state` transforms. Loading an old save runs it forward, and Zod validates the result.
- **Derived data is not saved:** rooms (and the `roomId` grid), the `objectId` grid (rebuilt from the object list), path caches and coverage maps are rebuilt after load. This keeps saves small and means derived data can never disagree with the layout. See `save/codec.ts`.

## 9. Testing strategy

- **Unit tests:** room validation, A*, LOS, finance calculations, job scoring.
- **Headless sim tests:** load a fixture hospital layout, seed the RNG, run N in-game hours, then assert KPIs and invariants (no patient stuck forever, no negative bed counts, money balances). These are the main protection against regressions as systems grow.
- **Save round-trip tests:** save → load → tick → compare with an uninterrupted run (determinism).
- **Manual/visual:** a dev overlay with an FPS counter, tick time, agent count and the job board inspector.

## 10. Performance targets & budgets

| Metric          | Target                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| Map             | 200×200 tiles × 3 floors                                                                   |
| Agents          | ~500 (patients + companions + staff) at 60 fps on a mid-range laptop                       |
| Sim tick budget | < 4 ms at 1× speed; speed-ups run multiple ticks per frame, with frame skip if over budget |
| Save size       | < 5 MB uncompressed for a large hospital                                                   |

Levers if needed: staggered AI updates, path caching and flow fields, moving the sim into a Web Worker (the state is already plain data), and spatial hashing for proximity queries.

## 11. Tooling & conventions

- ESLint + Prettier, `strict` TS, path aliases (`@sim`, `@data`, `@render`, `@ui`).
- Git from day one, with small commits per feature.
- `npm run dev` / `npm test` / `npm run build`.
- A dev-only **debug console** to spawn patients, trigger events, add money and jump time.
