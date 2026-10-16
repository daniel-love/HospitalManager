# Hospital Simulator

A UK-set, top-down hospital **design and management** sim inspired by classic top-down construction games and real emergency department design. You're the hospital director: you build the layout, buy the equipment, staff the departments and set the policies, and then you keep the hospital running under pressure.

**Stack:** TypeScript · Vite · PixiJS v8 · Preact · Zod · IndexedDB saves · Vitest · Tauri (desktop, later)

## Documents

- [Game Design Document](docs/GAME_DESIGN.md): what the game is and how it plays
- [Technical Architecture](docs/ARCHITECTURE.md): how it's built
- [Roadmap](docs/ROADMAP.md): milestones M0–M7

## Status

**M0–M6 are done**: foundations, build mode and saving, patient flow, Majors/Resus/wards and monitoring, outpatients and theatres, money and staffing, and events and scenarios. The next milestone is **M7: scale & polish** (see the [Roadmap](docs/ROADMAP.md)).

What you can do today:

- **Build a whole hospital**: A&E (Minors, Majors, Resus, ambulance bays), imaging and pathology, wards and side rooms, outpatient clinics, theatres with Recovery and day surgery, a mortuary, staff areas and plant rooms, on a site with a road, bus stop and footpaths. Plan mode lets you lay out changes and see the cost before building.
- **Run patients through real UK pathways**: Manchester Triage, the 4-hour standard, specialty referrals and admissions, transfers out for care you can't give, GP referrals and the 18-week RTT waiting list, elective and emergency surgery, deaths with the Medical Examiner process.
- **Staff it**: consultants and registrars by specialty (resident, on call or with practising privileges), nurses by band, and support and diagnostic roles. Staff work long days and nights on a rota, with fatigue, morale, sickness, resignations, recruitment from applicants, and bank and agency cover.
- **Plan the rota from demand**: the Staff screen's Rota tab shows how many patients to expect by shift, suggests day and night cover for each staff group, works out how many people that takes (shifts a week ÷ 3), and compares the cost of hiring, the bank and an agency.
- **Pay your way**: PHS block contract and tariffs, private or hybrid funding, loans and grants, monthly statements and service-line reports.
- **Survive pressure**: winter surges, heatwaves, outbreaks, strikes, major incidents, power cuts, equipment breakdowns, delayed discharges and CSI inspections. There are scenarios with objectives, a tutorial, and a sandbox.

## Controls

| Action                 | Input                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Pan                    | WASD / arrow keys, or drag (right/middle button, left with no tool, or Ctrl/⌘ + left drag any time)                 |
| Zoom                   | Mouse wheel / trackpad pinch                                                                                        |
| Build                  | Pick a tool from the bottom bar (Construction, Rooms, Equipment), then drag (or click to place)                     |
| Plan mode              | P (or the Plan button): lay out changes and see the cost, then Build plan. Ctrl/⌘+Z undoes the last planned change  |
| Coverage overlay       | O (or the Coverage button): which Majors and Resus beds a staffed nurse station can see                             |
| Rotate equipment       | R                                                                                                                   |
| Move equipment         | Equipment → Move equipment, or select an item and press Move; click to put down                                     |
| Cancel tool / deselect | Right-click or Esc                                                                                                  |
| Inspect a room         | Click it with no tool selected                                                                                      |
| Inspect a person       | Click a patient or member of staff                                                                                  |
| Staff                  | Staff in the bottom bar: Team, Hire, and Rota (cover, demand and the hiring plan)                                   |
| Patients               | Patients in the bottom bar (or click the census): what everyone is doing, sorted and filterable                     |
| Hospital / Finance     | Hospital (departments, policies, events, inspections, performance) and Finance (statements, loans, grants)          |
| Reports                | Reports in the bottom bar: today's P&L and performance                                                              |
| Help                   | H (or Help): a setup checklist, a capacity guide for your catchment, and a reference to rooms, staff and conditions |
| Quick help             | Rest the mouse on a room, item or door, or on any build palette entry                                               |
| Pause / speeds         | Space, 1–5 (. steps once while paused)                                                                              |
| Debug overlay          | F3 or `                                                                                                             |

## Development

```bash
npm run dev      # start the game at http://localhost:5173
npm test         # unit + headless sim tests
npm run balance  # headless week-long economy runs
npm run lint     # eslint
npm run build    # typecheck and production build
```
