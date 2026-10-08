# Hospital Simulator — Roadmap

> Milestones build on each other. Each milestone ends with something playable or testable. Content is added through `src/data/` rather than new code wherever possible.
> See [GAME_DESIGN.md](GAME_DESIGN.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## M0: Foundations

**Delivers:** Vite + TS + PixiJS + Preact project, git repo, lint/test setup, empty tile map with camera pan/zoom, fixed-timestep loop with pause and speed controls, seeded RNG, dev debug overlay.
**Done when:** `npm run dev` shows a pannable/zoomable grid, the speed controls change the tick rate, and `npm test` runs.

## M1: Build mode & saving

**Delivers:** place and remove walls, doors and floor. Zone rooms by painting, with flood-fill room detection and a validation checklist. Equipment catalogue (initial ~25 items) with ghost preview, rotation, cost deduction. Room capability derivation. Save/load to IndexedDB plus export/import.
**Done when:** you can build a small A&E (reception, waiting, triage, 2 minors cubicles, toilet), see valid/invalid room status, save, reload the browser and continue.
**Tests:** room detection, validation rules, save round-trip.

## M2: First patient flow (vertical slice)

**Delivers:** walk-in arrivals, reception booking, waiting, triage, minors treatment, discharge. Staff hiring (receptionist, nurse, junior doctor, cleaner), job board, A* movement, basic needs (seat, toilet), mood and LWBS. Tariff income, salaries, daily P&L. Notifications feed and inspector panel. 5 starter conditions.
**Done when:** a small A&E runs autonomously for an in-game day, patients flow end-to-end, money changes, and an understaffed or under-seated A&E visibly struggles.
**Tests:** headless 24-hour sim on a fixture layout, with invariants checked.

## M3: Majors, Resus, wards & monitoring

**Delivers:** Majors/Resus rooms, ambulance bays and ambulance arrivals with handover delays. Admissions to wards via porters and bed movement mode. Nurse stations, **line of sight**, central monitoring with response distance, coverage overlay. Deterioration, crash events and incident reports. Realistic death process (§5.6): expected vs unexpected deaths, verification, last offices, relatives' room, porter to mortuary, medical examiner and coroner, incident records, staff morale impact. 4-hour target tracking.
**Done when:** the coverage overlay correctly flags blind spots, and an unmonitored deteriorating patient produces an incident with a readable cause.

## M4: Outpatients, theatres & specialty gating

**Delivers:** specialties, consultants (resident and on-call with callout delay), outpatient clinics with GP referrals and scheduled appointments, waiting list and RTT, theatres + recovery + elective surgery scheduling and cancellations, imaging (X-ray/CT) and lab. **Specialty gating** of referrals, plus A&E transfer-out when the hospital can't treat.
**Done when:** adding a cardiology clinic and consultant causes cardiology referrals to start, and removing them stops them.

## M5: Administration depth

**Delivers:** NHS, Private and **Hybrid** funding models (start-of-game choice). Hybrid adds Private Patient Unit designation for rooms and wards, consultant time split between NHS and private lists, and a regulator cap on private income. Also: block contracts, insurer contracts, loans (terms, interest, rating), grants with conditions, staffing rotas and shifts, fatigue and morale, bank and agency staff, department status (open/closed/divert/restricted), hospital policies, finance and KPI report screens.
**Done when:** a full in-game month runs with a monthly financial statement, and closing or diverting a department has visible financial and reputation effects.

## M6: Pressure, scenarios & progression

**Delivers:** event system (winter surge, major incident, outbreak, strike, equipment failure, power cut, inspection, bed blocking), reputation, CQC-style rating, unlocks, scenario framework with objectives, sandbox settings, 3–5 campaign scenarios, tutorial.
**Done when:** a scenario can be won or lost, and each event has working player levers.

## M7: Scale & polish

**Delivers:** multiple floors with lifts and stairs, **land purchase** (buying adjacent parcels), **builder agents** as an optional construction mode, exterior (car parks, drop-off, helipad), cosmetics and ambience scoring, companions in full (parking, café, aggression and security), art pass (sprite atlas), audio, performance work (Web Worker sim if needed), accessibility and settings, Tauri desktop build.
**Done when:** a 3-floor hospital with ~500 agents runs at 60 fps and ships as a desktop app.

## Later / stretch

Mod support (external data packs); more specialties (cath lab, stroke unit, maternity, paediatrics, mental health); a regional map of neighbouring hospitals that receive diverts; Steam Workshop-style sharing of layouts.
