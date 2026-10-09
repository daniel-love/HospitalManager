# Hospital Simulator — Game Design Document

> Working title: **Hospital Simulator**. Status: draft v0.1 (2026-10-07).
> Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md).

---

## 1. Vision

A top-down hospital **design and management** simulator set in the UK. You are the hospital director. You don't diagnose anyone. You design the building, buy the equipment, hire the staff and set the policies, and then you watch a living hospital run itself according to the conditions you've set, often under pressure.

Inspiration: _Prison Architect_ (construction, zoning, autonomous agents, readable top-down art), plus real-world emergency department design. A good layout is a clinical advantage, and a bad one shows up as queues, breaches and patients deteriorating out of sight.

### 1.1 Design pillars

| Pillar                                  | What it means in play                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **You're the director, not the doctor** | No diagnosis minigames. Your decisions are about space, equipment, people, money and policy.                                                                                                                                                                                                                                                   |
| **Layout is strategy**                  | Distances, adjacency, line of sight and corridor flow have mechanical effects (e.g. walking time, monitoring coverage, cross-infection).                                                                                                                                                                                                       |
| **Pressure comes from flow**            | Demand fluctuates. Queues build, targets breach, patients deteriorate. The tension comes from capacity vs demand, not from random punishment.                                                                                                                                                                                                  |
| **Autonomy within your rules**          | Staff and patients act on their own via jobs, needs and pathways. You shape the system rather than micromanaging individuals.                                                                                                                                                                                                                  |
| **Realism over fun**                    | When realism and convenience conflict, realism wins. Waits, queues, staffing gaps and outcomes behave like a real UK hospital, including the 10pm A&E wait. The challenge and satisfaction come from running that system well, not from softening it. Abstraction is used only where the player doesn't make decisions (e.g. clinical detail). |
| **Readable consequences**               | When something goes wrong, the player can see why: overlays, incident reports and patient timelines.                                                                                                                                                                                                                                           |

### 1.2 Out of scope (deliberately)

- Clinical diagnosis or treatment minigames.
- Accurate medical detail beyond what's needed to drive flow (conditions are abstracted into acuity, capabilities, specialty and pathway).
- Graphic gore. Death is shown in-world but tastefully (see §5.6).

---

## 2. Setting & game modes

### 2.1 UK setting

Terminology, roles and targets follow UK practice: A&E, Majors/Minors/Resus, consultants/registrars, nurse bands, HCAs, porters, GP referrals, the 4-hour target, 18-week referral-to-treatment (RTT), CQC-style inspections, and winter pressures.

### 2.2 Funding model (chosen at game start)

|           | **NHS Trust**                                                                                               | **Private Hospital**                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Income    | Per-episode **tariff** (Payment by Results) plus a monthly **block contract** for A&E and baseline services | Per-procedure fees from self-pay patients and **insurer contracts**                                      |
| Demand    | High and relentless. A&E must stay open, and referrals arrive from GPs                                      | Driven by reputation and pricing, with fewer emergencies (urgent care only, unless you build a full A&E) |
| Targets   | 4-hour A&E, 18-week RTT, cancer 62-day (late game), ambulance handover times                                | Patient satisfaction, readmission rates, insurer contract KPIs                                           |
| Penalties | Target breaches lead to fines, ratings downgrades and special measures                                      | Lost contracts and reputation-driven demand loss                                                         |
| Grants    | Capital grants (e.g. Stroke Unit, Urgent Treatment Centre, Diagnostics Hub)                                 | Investor capital, with fewer grants                                                                      |
| Feel      | Survival under pressure                                                                                     | Business growth and premium experience                                                                   |

**Hybrid NHS Trust + Private Patient Unit (in v1):** an NHS trust that can designate departments, wards or individual rooms as a **Private Patient Unit (PPU)**. PPU beds earn private fees and insurer income that cross-subsidise the NHS side. The tension comes from shared resources: consultants split their time between NHS and private lists, theatres are shared, and if PPU work grows while NHS targets breach, the regulator responds (scrutiny, fines, and a cap on how much private income you're allowed). Private patients expect higher ambience (en-suite rooms, better décor). NHS income, targets and penalties work exactly as in NHS mode.

So there are three modes at game start: **NHS Trust**, **Private Hospital** and **Hybrid**.

### 2.3 Game modes

- **Sandbox:** you pick the funding model, budget, map size, difficulty and event frequency.
- **Campaign:** a sequence of scenarios with objectives, such as "Turn around a failing trust", "Open a new A&E before winter" or "Survive a major incident".
- **Challenge scenarios:** one-off, focused tests (e.g. "Build an ED that hits 95% 4-hour on £X").

### 2.4 Difficulty knobs

**Catchment** (Settings, saved with the game): the population the hospital serves, at real UK rates per person (about 60 type 1 walk-ins and 22 ambulance conveyances a day per 100,000 people). Presets: rural 40k, small town 80k (the default, around 48 walk-ins and 18 ambulances a day), town 150k and city 300k; a typical district general hospital serves 250k+. Patients with a condition the hospital can't treat (no working room, or the room lacks the equipment the first step needs) go to a neighbouring hospital instead, so a small department gets a share of the demand, and the Settings dialog shows how many come. Ambulance control sends new ambulances elsewhere once 3 crews are queueing outside with nowhere to park (counted in Reports). A **patient volume** multiplier sits on top for difficulty. Other knobs: arrival rate multiplier, budget, staff availability (recruitment pool), event frequency, deterioration speed and target strictness.

---

## 3. Core loop

```
 ┌─► Plan & Build ─► Equip ─► Staff ─► Open departments ─┐
 │                                                       ▼
 │   Expand / adapt  ◄── Money & reputation ◄── Patients flow through
 │                                                       │
 └─────────── Pressure events & scenarios ◄──────────────┘
```

**Short loop (minutes):** watch flow, spot bottlenecks (overlays), react (open overflow beds, call in an on-call consultant, divert ambulances).
**Medium loop (in-game weeks):** expand departments, renovate layouts, adjust staffing rotas and policies.
**Long loop (in-game years):** grow from a small cottage hospital into a major trauma centre, pass inspections, unlock specialties.

### 3.1 Time

- Controls: pause, 1×, 2×, 4×, 8× and 16× (for skipping quiet overnight periods).
- At 1×, one in-game minute passes per real second, so a day takes 24 real minutes (90 seconds at 16×). An early 5-minute day proved too fast to follow. Day and night matter: demand peaks in the evening and on Monday mornings, and night shifts have fewer staff. The week matters too: the game starts on a Monday, and office-hours work (Medical Examiner sessions, later clinics and elective lists) happens Monday to Friday.
- Building can be done while paused. **Construction is instant** (placement costs money and takes effect immediately) through M6. In M7, **builder agents** become a setting: builders physically construct over in-game time, as in Prison Architect, and instant build stays available as an option.

---

## 4. Build mode

Build mode has three sub-modes: **Construction**, **Cosmetics** and **Equipment**.

**Plan mode** (blueprints) works across all of them: while it's on, every build action goes into a plan instead of being built. The map shows the hospital as it would be, with planned changes tinted, and room checklists, costs and validity all reflect the plan. Nothing is built or paid for until the player builds the plan, which happens all at once and only if it's affordable. Plans are saved with the game. When builder agents arrive (M7), the plan becomes their work queue.

### 4.1 Construction

**Grid:** square tiles of about 1 m, viewed top-down. The hospital site has an exterior (grass, roads, paths) and an interior you construct.

**Site access (M3.5):** a council road with a pavement each side runs across the map, with a bus stop on the hospital side. The council owns it, so it's free and can't be built on. Walk-ins arrive from either end of the road or off the bus; ambulances drive in along it. You link the hospital to it with **footpaths** (cheap) and an **access road** (dearer). People can cut across grass, but at half speed, so paths are worth laying without being required. Ambulances need tarmac: an Ambulance Bay only works when an access road at least 3 tiles wide links it to the public road (crossing the pavement as a dropped kerb), and a bay can be zoned on access road as well as foundations. Ambulances drive on the left, and queue on the road when the bay is full.

**Land:** you start on a modest **owned plot**, surrounded by **purchasable parcels** (shown greyed out with a price). Buying a parcel extends the buildable area. Prices vary by parcel: road frontage, existing structures to demolish and planning conditions all affect the price. This makes expansion a financial decision you weigh against equipment and staff. Scenarios can fix the starting plot and which parcels are available.

**Structural elements**

- **Foundations / floor:** turns exterior tiles into buildable interior.
- **Walls:** standard, glazed (they block movement but **not line of sight**), lead-lined (radiation shielding: X-ray and CT rooms must be enclosed by them; drawing over an existing wall upgrades it) and fire walls. A **curtain divider** is a cheap ceiling-track curtain between neighbouring bays, as in most open-plan Majors areas: it separates rooms and blocks movement and sight, but takes no doors or wall fixtures, and doesn't count as a wall for rooms that must be enclosed.
- **Doors:** single, double (bed-width, required for bed transfers), automatic (faster flow, more costly), secure (staff only) and fire doors.
- **Corridors:** not a special object, just floor plus zoning. Corridor width matters: 1 tile is fine for walking, and 2+ tiles are needed for trolleys and beds.
- **Floors (levels):** multiple storeys, connected by **stairs** (walking only) and **lifts** (beds and wheelchairs; a capacity-limited queue). Ground floor first, with extra floors unlocked by money and planning permission.

**Exterior elements**

- **Car parks:** staff and visitor spaces. Visitor parking capacity limits how many companions and outpatients arrive by car, and it can generate income (pay & display).
- **Ambulance bays:** required for ambulance arrivals, zoned on access road or foundations and linked to the public road by an access road. Each bay holds one ambulance, so too few bays means **handover delays** (a penalised KPI).
- **Footpaths and access roads** (M3.5): link the hospital to the public road (see Site access above).
- **Drop-off / main entrance**, **bus stop** (on the public road, M3.5), **helipad** (late game, for major trauma).
- **Generator & plant room** (needed for power-cut resilience).

### 4.2 Room zoning

You paint a rectangular or freeform area and assign it a **room type**. A room is valid when its **requirements** are met, and only valid rooms function. Invalid rooms show a checklist of what's missing.

| Room type                     | Department    | Key requirements (examples)                                                                                                                                                        |
| ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main Reception                | General       | Reception desk, seating; connected to the main entrance                                                                                                                            |
| Waiting Area                  | Any           | Seating ≥ N; toilets within X tiles recommended                                                                                                                                    |
| A&E Reception / Streaming     | A&E           | Desk with queue space; no seating of its own (patients book in, then wait in a Waiting Area); near the walk-in entrance, opening onto the waiting area                             |
| Triage Room                   | A&E           | Exam couch, obs machine, sink; min 3×3                                                                                                                                             |
| Minors Cubicle                | A&E           | Exam couch, curtain, obs machine                                                                                                                                                   |
| Majors Bay                    | A&E           | Trolley/bed, monitor, oxygen point; double door access                                                                                                                             |
| Resus Bay                     | A&E           | Resus trolley, defibrillator, ventilator, monitor; min 5×5 (room to work all round the patient); both sides of the trolley clear; **adjacent to ambulance entrance (recommended)** |
| Paediatric A&E                | A&E           | Separate waiting area, child-friendly décor                                                                                                                                        |
| Ward                          | Inpatient     | Beds, nurse station, sinks, toilets/shower; max ~28 beds per ward                                                                                                                  |
| ICU / HDU                     | Critical care | Bed + ventilator + advanced monitor per bed; 1:1 / 1:2 nurse ratio                                                                                                                 |
| Theatre                       | Surgery       | Operating table, anaesthetic machine, surgical lights, scrub sink; min 6×6; requires recovery nearby                                                                               |
| Anaesthetic Room / Recovery   | Surgery       | Monitors, beds                                                                                                                                                                     |
| Outpatient Clinic Room        | Outpatients   | Desk, exam couch, chairs                                                                                                                                                           |
| Imaging: X-ray / CT / MRI     | Diagnostics   | Machine; shielding walls (CT/X-ray); MRI needs a large, isolated footprint                                                                                                         |
| Lab                           | Diagnostics   | Lab benches, analysers (reduces test turnaround)                                                                                                                                   |
| Pharmacy                      | Support       | Shelving, counter                                                                                                                                                                  |
| Staff Room                    | Staff         | Seating, kitchen; restores staff fatigue. Staff with no base of their own wait here between jobs                                                                                   |
| A&E Staff Base                | A&E           | Desk; open plan. Doctors and nurse practitioners wait here between patients (nurses too, when every nurse station is taken)                                                        |
| Porters' Lodge                | Support       | Desk; porters wait here between jobs. Central placement keeps their walks short                                                                                                    |
| Domestic Services Room        | Support       | Sink; the cleaners' base, where trolleys and supplies are kept                                                                                                                     |
| Admin Office                  | Admin         | Desks, computers; required for some management functions                                                                                                                           |
| Toilets                       | Facilities    | Toilet, sink; accessible toilet requirement                                                                                                                                        |
| Café / Shop                   | Facilities    | Counter, seating; generates income; satisfies hunger                                                                                                                               |
| Stores                        | Support       | Shelving; enables restocking                                                                                                                                                       |
| Mortuary                      | Support       | Fridge units. Required once the hospital exceeds a size or acuity threshold; deceased patients need somewhere to go (§5.6)                                                         |
| Bereavement / Relatives' Room | Facilities    | Sofa, tissues, soft décor; where families are given bad news (§5.6)                                                                                                                |
| Chapel / Quiet Room           | Facilities    | Reduces companion stress                                                                                                                                                           |
| Isolation Room                | Any           | Negative pressure, en-suite; needed during outbreaks                                                                                                                               |

**Adjacency & distance rules** (soft rules: a bonus or penalty rather than hard invalidation):

- Resus near the ambulance entrance.
- Imaging (CT) near A&E (the "door-to-CT" time matters for stroke and trauma).
- Theatres near ICU and recovery.
- Wards reachable by lift from A&E for admissions.
- Mortuary away from public areas.
- Pharmacy and stores central to clinical areas.

**Departments** are groups of rooms (e.g. the A&E department = reception + triage + minors + majors + resus). Departments are what you open, close, staff and report on.

### 4.3 Cosmetics

- **Flooring:** vinyl (cheap, easy to clean), safety flooring, carpet (comfortable but harder to clean and raises infection risk in clinical areas), wood-effect.
- **Wall finish:** paint colours and murals (paediatrics bonus).
- **Décor items:** plants, artwork, aquarium, TV, water cooler, vending machine, windows (natural light).
- **Ambience score** per room = flooring + walls + décor + light + noise + cleanliness. Ambience affects:
  - Patient and companion **mood decay rate** while waiting.
  - Staff **morale** recovery in staff areas.
  - Reputation (inspectors and reviews notice).

### 4.4 Equipment & furnishings

A catalogue organised by category, with tiers:

| Category         | Examples                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Furnishing**   | Benches, chairs, sofas, desks, tables, bins, curtains, lockers, coat stands                |
| **Bedding**      | Trolley, basic bed, electric profiling bed, bariatric bed, cot, ICU bed                    |
| **Monitoring**   | Obs machine (BP/SpO₂/temp), bedside monitor, telemetry, central monitoring station         |
| **Diagnostic**   | ECG (basic 3-lead → 12-lead), ultrasound, blood gas analyser, X-ray, CT, MRI, lab analyser |
| **Treatment**    | Infusion pump, oxygen point, suction, nebuliser, plaster room kit                          |
| **Life support** | Defibrillator, resus trolley, ventilator, anaesthetic machine                              |
| **Surgical**     | Operating table, surgical lights, theatre instrument sets, diathermy                       |
| **Facilities**   | Sinks, hand-gel stations, toilets, showers, vending, café counter                          |
| **Décor**        | Plants, art, aquarium, TV                                                                  |

**Item attributes:** purchase cost, upkeep/month, footprint (tiles), required room types (optional), **capabilities granted**, capacity (e.g. a bed serves one patient), quality tier, **reliability** (breakdown chance; repaired by a maintenance staff job), power requirement and **cleaning load**.

**Mounting and access.** Items are floor-standing (beds, trolleys, obs machines), **wall-mounted** (oxygen and suction outlets, monitors, hand gel; they need a wall behind them) or **ceiling-mounted** (curtain tracks). Mounted fixtures take no floor space, so an oxygen outlet beside a bed head doesn't stop staff standing there. Floor items declare which sides must stay clear and for whom: patients at the front of a chair or desk, staff behind a reception desk, staff along one long side of a bed (both sides in Majors and Resus).

**Capabilities are the core link between equipment and treatment.** Examples:

- 12-lead ECG grants `ecg_12lead`
- Defibrillator + resus trolley grant `resuscitation`
- CT scanner grants `ct_imaging`
- Ventilator grants `ventilation`
- Operating table + anaesthetic machine + lights grant `general_surgery_theatre`

A room's **capability set** is the union of its equipment's capabilities. Conditions declare which capabilities each pathway step needs. Equipment tiers can also speed up a step or improve its outcome (e.g. a high-end CT scans faster).

---

## 5. Patients

### 5.1 Arrival channels

| Channel                                    | Requires                                   | Notes                                                                                                                              |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Walk-in A&E**                            | An open A&E                                | Most variable stream, with evening peaks                                                                                           |
| **Ambulance**                              | A&E + ambulance bay linked to the road     | Higher acuity. Without a free bay, ambulances queue on the road (handover delay KPI). They can be **diverted** if A&E is on divert |
| **GP referral → outpatient clinic**        | The relevant clinic + specialty consultant | Scheduled appointments. Missing slots grows the waiting list                                                                       |
| **Elective (planned) surgery**             | Theatre + ward bed + specialty             | Drawn from the waiting list and scheduled ahead. Cancellations happen if no bed is available                                       |
| **Inter-hospital transfer in** (late game) | Specialist unit (e.g. Stroke, Cardiac)     | Income boost and reputation                                                                                                        |
| **Major incident / mass casualty**         | Event-driven                               | Bursts of high-acuity ambulances                                                                                                   |

**Specialty gating (user requirement):** a referral or elective condition spawns only if the hospital has the required **department + specialty staff**. For example, no cardiology clinic and no cardiology consultant means no cardiology referrals. **A&E is the exception:** anyone can turn up. If A&E can't treat a patient, staff must **stabilise and transfer** them, which costs money (ambulance transfer) and reputation, and may count against targets. As built (M4): ambulance control only brings patients the hospital can treat, but a quarter of walk-ins it can't treat turn up anyway. A patient whose next step has nowhere in the hospital to happen (no Majors Bay, say), or who needs admitting with no ward or no team for their specialty, is transferred: a doctor assesses them and arranges it with the receiving hospital (15–30 minutes), then they wait where they are for an inter-hospital ambulance (30–90 minutes for triage categories 1–2, otherwise 1–4 hours), still able to deteriorate. The 4-hour clock runs until they leave, and each transfer ambulance costs £400. (Reputation arrives in M6.)

### 5.2 Conditions (data-driven)

Each condition definition has:

- **Name & category** (e.g. "Chest pain: suspected MI", cardiac)
- **Acuity:** Manchester Triage category 1–5 (Immediate → Non-urgent), which sets priority and the target time to be seen
- **Specialty** required for definitive care (e.g. Cardiology)
- **Pathway:** an ordered list of steps, each with a required capability, staff role, duration and room type. For example:
  `Triage → ECG (ecg_12lead, Nurse) → Bloods (lab) → Doctor review (Junior Dr) → Cardiology review (Cardiologist / on-call) → Admit to Cardiac Ward | Discharge`
- **Deterioration curve:** how fast the patient worsens while waiting or unmonitored, and what happens at thresholds (they escalate acuity, become a "crash" emergency, or die)
- **Monitoring need:** none / periodic obs / continuous (see §7)
- **Outcome rules:** discharge, admit (to a ward type), theatre, transfer or deceased
- **Tariff/fee value** for income
- **Spawn weights** by time of day, season (winter flu and respiratory illness) and channel

Starter set (vertical slice): minor injury, sprain/fracture, chest pain, shortness of breath, abdominal pain, head injury, elderly fall, sepsis, stroke, cardiac arrest.

### 5.3 Companions (family & friends)

- 0–3 companions per patient (more for children and the very ill, fewer at night).
- Companions **occupy seats**, use toilets and the café, need parking, and can block corridors.
- Companion mood falls with waiting, poor ambience and bad news. Angry companions can cause **incidents** (verbal abuse, needing security) and file complaints.
- Some areas can be set to **no visitors** (Resus, theatre) or have visiting hours (wards). That's a policy lever.

### 5.4 Needs & mood

Patient needs: **comfort** (seat/bed), **toilet**, **hunger/thirst**, **privacy**, **information** (fall over time if unseen), **pain** (rises over time; reduced by treatment).
**Mood** falls according to unmet needs, wait time and ambience. At zero mood, a walk-in patient may **leave without being seen** (LWBS). This hurts reputation and is risky if they were actually unwell.

### 5.5 Patient lifecycle (A&E example)

```
Arrive → Book in (reception) → Wait → Triage → Stream (Minors | Majors | Resus | UTC)
 → Wait for cubicle → Assessment → Investigations → Decision
 → Discharge │ Admit (referral → specialty review → wait for bed → porter transfer → ward) │ Theatre │ Transfer out
```

**Investigations (M4):** a pathway step can take a blood sample, be an X-ray or CT scan, or wait until every result is back, and some steps are only for some patients (an ankle X-ray under the Ottawa rules, about a third; a CT head under NICE rules). A porter takes each sample to the Pathology Lab, a biomedical scientist processes it, and results follow once the analyser has run (about an hour from sample to result in all). Walking patients go to X-ray from their cubicle and back to the waiting area; a patient on a Majors or Resus trolley keeps it while they're scanned. X-rays are read at once; a radiologist reports CT 20–45 minutes later. Reports shows arrival-to-CT time, the share of CT scans within an hour of being asked for, and blood turnaround. Without a lab, patients who need bloods are transferred out.

Every timestamp is logged. The 4-hour clock runs from arrival to departure from A&E, so the wait for a specialty review counts towards it, as it does in a real A&E. A patient who needs admitting is referred to their condition's specialty; its registrar or consultant reviews them on their A&E trolley and decides to admit. Wards can be given to a specialty: patients go to their own specialty's ward first, then one open to any specialty, and only then to another specialty's ward (an "outlier", counted in Reports).

### 5.6 Patient death (realistic process, never graphic)

Deaths follow the real UK hospital process, because that process is where the operational cost lies. Each step ties up a specific staff role, room or bed for a realistic length of time. The presentation stays respectful and is never graphic; the realism is in the process.

**Expected vs unexpected.** Not every death is a failure.

- **Expected deaths:** patients on an end-of-life care pathway (ward or palliative care, often with a DNACPR decision in place). There's no crash call. These deaths need a side room for privacy, open visiting for family, and nursing time. If a dying patient is left in an open bay because no side room is free, that's a quality and complaints penalty, not a safety incident.
- **Unexpected deaths:** a patient deteriorates, and there's a crash call and resuscitation attempt. These count against mortality-vs-expected.

**Sequence (unexpected death in A&E):**

1. **Cardiac arrest call:** the resus team (doctor, nurses, ODP or anaesthetist where available) is pulled off other work for the length of the attempt, often 20–40 minutes. Other patients wait longer as a result.
2. **Verification of death:** done by a doctor or a nurse trained to verify. The time is recorded.
3. **Family:** a senior clinician breaks the news in the **Bereavement/Relatives' Room**, typically 30–60 minutes of their time. Family may stay with the patient for a viewing. Without a relatives' room, this happens in a corridor or cubicle, which brings complaints, a reputation penalty and distress in the nearby waiting area.
4. **Last offices:** nurses prepare the body, a task of about one hour for two staff. The bay stays **closed** throughout.
5. **Porter transfer:** a porter takes the patient to the **Mortuary** on a covered concealment trolley, routed away from public corridors where possible. If the route passes through busy public areas, a satisfaction penalty applies, so layout matters. A full mortuary or a missing mortuary blocks the bay and raises an incident.
6. **Bay turnaround:** a deep clean before the bay can be reused.
7. **Paperwork and governance:**
   - **Medical Examiner** review of every death: a part-time duty for a resident consultant, done in sessions Monday to Friday 09:00–17:00 (so weekend deaths wait until Monday), and never by a consultant who treated the patient.
   - A **coroner referral** where the death is unexpected, unexplained or possibly linked to care. This delays release of the body and increases mortuary occupancy.
   - A **patient safety incident** record, logged with its contributing factors (e.g. "Bed 7 not visible from the nurse station; observations overdue by 45 minutes; nurse ratio 1:9").
   - Serious cases trigger a **patient safety investigation** (PSIRF-style). That takes admin and senior staff time over the following weeks, and its findings show up at inspections.
   - A **bereavement office** (admin staff) handles family paperwork. Without one, complaints rise.
8. **Staff impact:** a hot debrief after a resuscitation attempt (a short pause for the team). Then a morale hit for the staff involved, larger after an unexpected or avoidable death, plus a burnout risk if deaths cluster.

**Reporting to the player:** a sober notification and the incident record, with no "game over" sting. Avoidable deaths feed the mortality figures, the inspection rating, the risk of complaints and litigation (NHS Resolution-style claims, a real financial cost) and media scrutiny.

---

## 6. Staff

### 6.1 Roles

| Role                                      | Typical jobs                                       | Notes                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Consultant** (by specialty)             | Senior review, theatre lead, clinic                | Resident, or **on-call** from home: a retainer plus pay for time on site, and 20–40 min to arrive. Required for specialty gating |     |
| **Registrar**                             | Specialist assessment, surgery assist              | Specialty-tagged                                                                                                                 |
| **Junior Doctor** (FY/SHO)                | Clerking, prescribing, routine review              | Generalist, needs senior supervision for some steps                                                                              |
| **Nurse** (Band 5/6/7)                    | Triage, obs, meds, monitoring                      | Band 7 = nurse in charge (improves department flow)                                                                              |
| **Emergency Nurse Practitioner** (Band 7) | See and treat minor injuries start to finish       | Built in M2. Takes injury assessments before doctors, nursing steps after staff nurses; doesn't triage or see illnesses          |
| **Healthcare Assistant**                  | Obs, comfort, escort                               | Cheaper, limited scope                                                                                                           |
| **Paramedic handover**                    | Ambulance arrivals                                 | External agents, not hired                                                                                                       |
| **Porter**                                | Moving beds and patients, samples                  | Critical for admissions flow                                                                                                     |
| **Cleaner**                               | Cleaning, bed turnaround                           | Dirty bays can't be used; cleanliness affects infection                                                                          |
| **Receptionist**                          | Booking in                                         | Without one, a queue builds at the entrance                                                                                      |
| **Radiographer**                          | Imaging                                            | Required for X-ray/CT/MRI                                                                                                        |
| **Pharmacist**                            | Discharge meds                                     | A discharge bottleneck if missing                                                                                                |
| **Lab Technician**                        | Blood tests                                        | Test turnaround                                                                                                                  |
| **Maintenance / Estates**                 | Repairs, equipment breakdowns                      |                                                                                                                                  |
| **Security**                              | Incidents, aggression                              |                                                                                                                                  |
| **Medical Examiner**                      | Independent review of every death                  | A part-time duty for a resident consultant, in weekday sessions, never for their own patients. Without one, the mortuary fills   |
| **Bereavement Officer**                   | Family paperwork after a death                     | Admin role. Without one, complaints rise                                                                                         |
| **Admin / Managers**                      | Unlock admin functions, reduce bureaucracy penalty |                                                                                                                                  |

### 6.2 Staff attributes

Skill (affects step duration and outcome), specialty (doctors), **fatigue** (rises on shift; rest in the staff room), **morale** (pay, workload, ambience, incidents), salary, contract type (permanent / bank / **agency locum** at about 2× cost, available instantly).

### 6.3 Staffing rules

- Each department has **minimum staffing** per shift (e.g. A&E: 1 consultant or on-call, 2 doctors, 4 nurses, 1 HCA, 1 receptionist). Below the minimum, the department runs **unsafe**: slower, with incident risk and inspection penalties.
- **Nurse-to-patient ratios** (e.g. ward 1:8, HDU 1:2, ICU 1:1).
- **Shifts & rotas:** day, night and long-day patterns. Rota gaps can be filled with bank or agency staff.
- **Hospital-wide** roles (e.g. a single on-call consultant cardiologist) serve all departments, but can only be in one place at a time. That's a source of pressure.
- **Attrition:** low morale leads to resignations. High workload leads to sickness. Strikes are an event.

### 6.4 Autonomy (job board)

Staff are never directly ordered. Departments and patients post **jobs** (e.g. "Triage patient #42", "Move patient #17 to Ward 3", "Clean Majors Bay 4"). Staff pick up jobs by role, skill, priority and distance. Players influence this through **policies** (e.g. "Nurses prioritise Resus over obs rounds") and through staffing and layout.

---

## 7. Monitoring & line of sight

This is a headline mechanic and one of the user's explicit requirements.

- Each patient has a **monitoring need**: `none`, `periodic` (obs every N minutes), or `continuous`.
- **Periodic:** generates "obs round" jobs. Missed obs increase deterioration risk.
- **Continuous** can be satisfied by:
  1. **Direct observation:** a staffed **nurse station** with **line of sight** to the bed within range. Walls and curtain dividers block sight; glass walls and open curtains don't. This is mandatory in A&E Majors and Resus: the station must have eyes on every bay. A bay's **privacy curtain** is drawn while a clinician examines or treats the patient, and for 10 minutes afterwards as they dress and settle. While it's drawn the station can't see the bed (the overlay shows it purple). With someone inside that doesn't matter, but once they leave it's a blind spot until the curtain opens.
  2. **Remote monitoring:** a bedside monitor linked to a **central monitoring station**. The station must be **staffed** and within a **response distance** (walking path length, not straight line) of the bed, so a nurse can reach the patient in time when an alarm sounds.
- **Coverage overlay:** shows each bed as green (covered), amber (remote only / far) or red (uncovered).
- **Consequence:** an uncovered deteriorating patient isn't noticed until a periodic check or a companion raises the alarm. Their chance of a cardiac arrest or death rises sharply, and an **incident report** is generated naming the cause ("Bed 7 not visible from the nurse station").
- Response time is computed from the real path, so a long corridor or a lift between the station and the bed makes things worse.

---

## 8. Administration

The admin interface is a set of full-screen panels opened from the toolbar.

### 8.1 Finance

- **Starting budget** (set by mode and difficulty).
- **Income:** tariffs/fees, block contract, parking, café and shop, grants, investor injections (private).
- **Costs:** salaries, agency premiums, equipment upkeep, utilities (scale with floor area and powered equipment), consumables (per treatment), fines, transfer costs, loan interest.
- **Loans:** choose amount and term. Interest rate depends on your financial rating. Missed repayments lead to a rating downgrade, then administration (game over in campaign).
- **Grants:** offered or available for specific builds, with conditions (e.g. "£500k Stroke Unit grant: build a stroke unit with CT within 30 tiles of Resus and a stroke consultant within 6 months; repay if not met").
- **Reports:** P&L by month, cost per department, income per department, cash-flow forecast.

### 8.2 Staffing

Hire from a candidate pool (size depends on reputation and region), set pay bands, view rotas, assign home departments, manage on-call rotas, review morale and fatigue, and dismiss staff.

### 8.3 Departments

For each department:

- **Status:** Open / Closed / **Divert** (A&E only: ambulances go elsewhere) / **Restricted** (e.g. emergencies only).
- **Opening hours** (clinics, minor injuries unit).
- **Capacity settings:** escalation beds (corridor care) on/off. This increases capacity but hurts safety and satisfaction.
- **Visitor policy.**
- Closing or diverting is a crisis lever. It relieves pressure immediately but costs reputation, target performance and income, and in NHS mode it triggers regulator scrutiny if overused.

### 8.4 Policies (hospital-wide toggles)

Examples: triage priority rules, discharge-before-noon push, infection control level, visiting hours, agency staff cap, elective cancellation rules during surges.

### 8.5 Reports & KPIs

- A&E: 4-hour %, time to triage, time to first clinician, ambulance handover time, LWBS rate.
- Inpatients: bed occupancy %, length of stay, delayed discharges.
- Electives: waiting list size, 18-week RTT %, cancellations.
- Quality: mortality vs expected, incidents, infections, complaints, patient satisfaction.
- Staff: vacancies, sickness, agency spend, morale.
- Finance: surplus/deficit, cash, debt.

---

## 9. Pressure events & scenarios

Each event has a **trigger** (scheduled, seasonal, random, or conditional), an **effect**, a **duration**, and the **levers** the player can use.

| Event                         | Effect                                                                | Player levers                                                                                 |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Winter surge**              | +40–80% arrivals, more respiratory and elderly falls, more admissions | Escalation beds, agency staff, cancel electives, open discharge lounge                        |
| **Major incident**            | Wave of category 1–2 ambulances within a short window                 | Declare major incident (call in off-duty staff, cancel electives, clear Resus), divert minors |
| **Outbreak** (e.g. norovirus) | Ward closures, staff sickness, isolation needs                        | Close the ward to admissions, isolation rooms, infection control policy                       |
| **Industrial action**         | A staff group is unavailable for N days                               | Locums, reduce electives                                                                      |
| **Equipment failure**         | A key item breaks (CT down)                                           | Maintenance priority, backup equipment, transfers                                             |
| **Power cut**                 | Powered equipment stops unless a generator exists                     | Generator capacity, prioritise critical areas                                                 |
| **CQC-style inspection**      | Inspectors tour and score safety, ambience, staffing and incidents    | Prepare (cleanliness, staffing), fix flagged issues                                           |
| **Bed blocking**              | Medically fit patients can't be discharged (social care delays)       | Discharge lounge, social care liaison staff, step-down beds                                   |
| **Heatwave**                  | Elderly and dehydration presentations, staff fatigue                  | Cooling, ambience                                                                             |
| **VIP / media visit**         | Reputation multiplier on the day                                      | Make sure the visited department is presentable                                               |

**Scenario framework:** a scenario = starting map (blank or pre-built), funding model, budget, an event script and objectives (e.g. "Achieve 90% 4-hour for 4 consecutive weeks" or "Reach a Good rating within 2 years").

---

## 10. Scoring, reputation & progression

- **Reputation** (0–100) drives private demand, recruitment pool size and grant eligibility.
- **Inspection rating:** Outstanding / Good / Requires Improvement / Inadequate. _Inadequate_ puts the hospital into **special measures** (NHS): more inspections and restrictions.
- **Unlocks:** new room types and equipment tiers unlock via reputation, rating or research (e.g. MRI, cath lab, helipad, major trauma centre status).
- **Fail states (campaign):** bankruptcy (unable to service debt), sustained Inadequate rating, too many serious incidents. Sandbox has no fail state, or it's optional.

---

## 11. UI / UX

**Visual style:** clean top-down 2D, flat colours and simple readable sprites (Prison Architect visual language): agents as small figures with role-colour uniforms (NHS-style: navy for senior nurses, blue for nurses, green for theatre, etc.).

**Screen layout**

- **Top bar:** date/time, speed controls, cash, reputation, alerts.
- **Bottom toolbar:** Build (Construction / Cosmetics / Equipment), Staff, Departments, Finance, Reports, Policies.
- **Left panel:** context (selected tool, catalogue).
- **Right panel:** inspector (selected room, patient, staff, or equipment) with a timeline, needs and status.
- **Notifications feed:** breaches, incidents and events. Clicking one jumps the camera to it.

**Overlays (toggle):** monitoring coverage, room validity, footfall heatmap, queue lengths, ambience, cleanliness, infection risk, power, staff coverage.

**Input:** mouse drag to build, right-click to cancel, WASD/edge pan, wheel zoom, number keys for speed, space to pause, keyboard shortcuts for overlays.

**Onboarding:** a short guided tutorial scenario: build a reception, triage room, minors cubicle and toilet; hire staff; treat your first patients.

---

## 12. Saving

- Autosave at a configurable interval (default every in-game day) and on quitting.
- Multiple named save slots, with a thumbnail and date.
- Export and import save files (`.hospital.json`) for backups and sharing.
- Saves are versioned, so older saves keep working after updates. See ARCHITECTURE §8.

---

## 13. Requirements traceability

Each requirement from the original brief, and where it's covered:

| User requirement                                                                 | Covered in                             |
| -------------------------------------------------------------------------------- | -------------------------------------- |
| Build mode to create own floor plan                                              | §4.1, §4.2                             |
| Room additions, floor additions                                                  | §4.1 (floors/levels), §4.2             |
| Parking spaces, ambulance bays                                                   | §4.1 exterior elements                 |
| Emergency room layout, ward, theatre, clinic, admin sections                     | §4.2 room types & departments          |
| Cosmetic changes (flooring, décor) affecting patient mood                        | §4.3 ambience                          |
| Equipment & furnishings by category, varying complexity                          | §4.4 categories & tiers                |
| Treatment availability depends on equipment + staff                              | §4.4 capabilities, §5.2 pathways, §6.3 |
| Finances: starter budget, loans, grants                                          | §8.1                                   |
| NHS vs private income, UK setting                                                | §2.1, §2.2                             |
| Departments need minimum staff, specialists, hospital-wide / on-call consultants | §6.1, §6.3                             |
| Shut down / close departments in a crisis, refer elsewhere                       | §8.3, §9                               |
| Management/design sim, not medical/diagnostic                                    | §1.1, §1.2                             |
| Player is hospital manager/director                                              | §1                                     |
| Autonomous functions around player-set conditions                                | §1.1, §6.4                             |
| Range of conditions and emergencies                                              | §5.2, §9                               |
| Accompanied by family/friends                                                    | §5.3                                   |
| Emergency vs scheduled/referral arrivals                                         | §5.1                                   |
| No specialist/department means the patient doesn't present (except A&E)          | §5.1 specialty gating                  |
| Monitoring: remote central stations within reach; A&E within eye view            | §7                                     |
| Save and return to game                                                          | §12, ARCHITECTURE §8                   |
| Prison Architect-style interactivity                                             | §1, §4, §11                            |
| Pressure aspects                                                                 | §1.1, §9, §10                          |

---

## 14. Design decisions (resolved 2026-10-07)

| Question                | Decision                                                                                                                      | Where |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- |
| Construction time       | Instant placement through M6. Builder agents arrive as an option in M7                                                        | §3.1  |
| Death handling and tone | Realistic UK process (verification, last offices, mortuary, medical examiner, coroner, incident investigation), never graphic | §5.6  |
| Guiding principle       | **Realism over fun** where they conflict                                                                                      | §1.1  |
| Map                     | Start on a modest plot and buy adjacent parcels to expand                                                                     | §4.1  |
| Patient count scale     | About 1/3 of real-world volumes by default, with a "realism" slider                                                           | §2.4  |
| Hybrid NHS/private mode | In v1, as a third funding mode                                                                                                | §2.2  |
