import type { Game } from "@game/game";
import { BuildBar, Palette } from "./BuildMenu";
import { DebugOverlay } from "./DebugOverlay";
import { MapHelp, PaletteHelp } from "./HelpCard";
import { Inspector } from "./Inspector";
import { Notifications } from "./Notifications";
import { PeopleDialog } from "./PeopleDialog";
import { CoverageLegend, CursorInfo, PausedHint, Toasts } from "./Overlays";
import { PlanBar } from "./PlanBar";
import { ReportsPanel } from "./ReportsPanel";
import { SaveDialog } from "./SaveDialog";
import { SettingsDialog } from "./SettingsDialog";
import { StaffPanel } from "./StaffPanel";
import { planning } from "./store";
import { TopBar } from "./TopBar";

export function App({ game }: { game: Game }) {
  return (
    <>
      <TopBar game={game} />
      <Palette />
      <StaffPanel game={game} />
      <ReportsPanel onShow={(at) => game.focus(at)} />
      <Inspector onClose={() => game.select(null)} onMove={(id) => game.startMove(id)} />
      <PlanBar game={game} />
      <BuildBar
        onTogglePlan={() => game.setPlanning(!planning.value)}
        onToggleCoverage={() => game.toggleCoverage()}
        onPanel={() => game.refreshPanels()}
      />
      <Notifications game={game} />
      <PeopleDialog game={game} />
      <CoverageLegend />
      <PausedHint />
      <Toasts />
      <DebugOverlay />
      <CursorInfo />
      <MapHelp />
      <PaletteHelp />
      <SaveDialog game={game} />
      <SettingsDialog />
    </>
  );
}
