import type { Game } from "@game/game";
import { BuildBar, Palette } from "./BuildMenu";
import { DebugOverlay } from "./DebugOverlay";
import { MapHelp, PaletteHelp } from "./HelpCard";
import { Inspector } from "./Inspector";
import { CursorInfo, Toasts } from "./Overlays";
import { PlanBar } from "./PlanBar";
import { SaveDialog } from "./SaveDialog";
import { planning } from "./store";
import { TopBar } from "./TopBar";

export function App({ game }: { game: Game }) {
  return (
    <>
      <TopBar game={game} />
      <Palette />
      <Inspector onClose={() => game.select(null)} onMove={(id) => game.startMove(id)} />
      <PlanBar game={game} />
      <BuildBar onTogglePlan={() => game.setPlanning(!planning.value)} />
      <Toasts />
      <DebugOverlay />
      <CursorInfo />
      <MapHelp />
      <PaletteHelp />
      <SaveDialog game={game} />
    </>
  );
}
