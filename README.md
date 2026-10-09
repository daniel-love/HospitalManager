# Hospital Simulator

A UK-set, top-down hospital **design and management** sim inspired by _Prison Architect_ and real emergency department design. You're the hospital director: you build the layout, buy the equipment, staff the departments and set the policies, and then you keep the hospital running under pressure.

**Stack:** TypeScript · Vite · PixiJS v8 · Preact · Zod · IndexedDB saves · Vitest · Tauri (desktop, later)

## Documents

- [Game Design Document](docs/GAME_DESIGN.md): what the game is and how it plays
- [Technical Architecture](docs/ARCHITECTURE.md): how it's built
- [Roadmap](docs/ROADMAP.md): milestones M0–M7

## Status

**M0 (foundations)**, **M1 (build mode & saving)** and **M2 (first patient flow)** are done. You can build and equip an A&E, hire staff (receptionists, nurses, junior doctors, cleaners) and watch walk-in patients queue, book in, wait, get triaged, be treated in Minors and go home, or give up and leave. Tariff income, salaries and upkeep move the money, with a daily report, a notifications feed that explains bottlenecks, and an inspector for every patient and member of staff. The next step is **M3: Majors, Resus, wards & monitoring**.

## Controls

| Action                 | Input                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Pan                    | WASD / arrow keys, or drag (right/middle button, left with no tool, or Ctrl/⌘ + left drag any time)                |
| Zoom                   | Mouse wheel / trackpad pinch                                                                                       |
| Build                  | Pick a tool from the bottom bar, then drag (or click to place)                                                     |
| Plan mode              | P (or the Plan button): lay out changes and see the cost, then Build plan. Ctrl/⌘+Z undoes the last planned change |
| Coverage overlay       | O (or the Coverage button): which Majors and Resus beds a staffed nurse station can see                            |
| Rotate equipment       | R                                                                                                                  |
| Move equipment         | Equipment → Move equipment, or select an item and press Move; click to put down                                    |
| Cancel tool / deselect | Right-click or Esc                                                                                                 |
| Inspect a room         | Click it with no tool selected                                                                                     |
| Inspect a person       | Click a patient or member of staff                                                                                 |
| Hire / reports         | Hire and Reports in the bottom bar: hire staff, see today's P&L and A&E performance                                |
| People                 | Staff and Patients in the bottom bar (or click the patient count): what everyone is doing, sorted and filterable   |
| Quick help             | Rest the mouse on a room, item or door, or on any build palette entry                                              |
| Pause / speeds         | Space, 1–5                                                                                                         |
| Debug overlay          | F3 or `                                                                                                            |

## Development

```bash
npm run dev      # start the game at http://localhost:5173
npm test         # unit + headless sim tests
npm run build    # typecheck and production build
```
