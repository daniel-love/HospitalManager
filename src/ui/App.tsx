import type { Game } from "@game/game";
import { BuildBar, Palette } from "./BuildMenu";
import { DebugOverlay } from "./DebugOverlay";
import { MapHelp, PaletteHelp } from "./HelpCard";
import { HelpPanel } from "./HelpPanel";
import { Inspector } from "./Inspector";
import { Notifications } from "./Notifications";
import { CoverageLegend, CursorInfo, PausedHint, Toasts } from "./Overlays";
import { PlanBar } from "./PlanBar";
import { ReportsPanel } from "./ReportsPanel";
import { SaveDialog } from "./SaveDialog";
import { SettingsDialog } from "./SettingsDialog";
import { PatientsDialog } from "./PatientsDialog";
import { StaffScreen } from "./StaffScreen";
import { planning } from "./store";
import { TopBar } from "./TopBar";

export function App({ game }: { game: Game }) {
  return (
    <>
      <TopBar game={game} />
      <Palette />
      <ReportsPanel onShow={(at) => game.focus(at)} />
      <HelpPanel />
      <Inspector
        onClose={() => game.select(null)}
        onMove={(id) => game.startMove(id)}
        onRoomSpecialty={(sp) => game.setRoomSpecialty(sp)}
        onMeDuty={(id, on) => game.applyStaff({ type: "set_me_duty", id, on })}
        onClinicSessions={(id, sessions) =>
          game.applyStaff({ type: "set_clinic_sessions", id, sessions })
        }
        onTheatreSessions={(id, sessions) =>
          game.applyStaff({ type: "set_theatre_sessions", id, sessions })
        }
        onEmergencyTheatre={(on) => game.setEmergencyTheatre(on)}
      />
      {/* Strips under the top bar stack rather than overlap. */}
      <div class="under-topbar">
        <PlanBar game={game} />
        <PausedHint />
      </div>
      <BuildBar
        onTogglePlan={() => game.setPlanning(!planning.value)}
        onToggleCoverage={() => game.toggleCoverage()}
        onPanel={() => game.refreshPanels()}
        onStaff={() => game.openStaff("team")}
        onPatients={() => game.togglePatients()}
      />
      <Notifications game={game} />
      <PatientsDialog game={game} />
      <StaffScreen game={game} />
      <CoverageLegend />
      <Toasts />
      <DebugOverlay />
      <CursorInfo />
      <MapHelp />
      <PaletteHelp />
      <SaveDialog game={game} />
      <SettingsDialog game={game} />
    </>
  );
}
