import type { Game } from "@game/game";
import { BuildBar, Palette } from "./BuildMenu";
import { DebugOverlay } from "./DebugOverlay";
import { MapHelp, PaletteHelp } from "./HelpCard";
import { Inspector } from "./Inspector";
import { CursorInfo, Toasts } from "./Overlays";
import { SaveDialog } from "./SaveDialog";
import { TopBar } from "./TopBar";

export function App({ game }: { game: Game }) {
  return (
    <>
      <TopBar game={game} />
      <Palette />
      <Inspector onClose={() => game.select(null)} onMove={(id) => game.startMove(id)} />
      <BuildBar />
      <Toasts />
      <DebugOverlay />
      <CursorInfo />
      <MapHelp />
      <PaletteHelp />
      <SaveDialog game={game} />
    </>
  );
}
