import { describe, expect, it } from "vitest";
import { nameTakenByOtherGame, type SaveSlot } from "@save/saveManager";

function slot(name: string, seed: number, autosave = false): SaveSlot {
  return {
    id: autosave ? `autosave:${seed}` : `save:${name.toLowerCase()}`,
    meta: { name, savedAt: "2026-10-15T00:00:00.000Z", gameTime: "Day 1 08:00", money: 0 },
    autosave,
    seed,
  };
}

describe("nameTakenByOtherGame", () => {
  const slots = [slot("St Mary's", 1), slot("Riverside", 2, true)];

  it("lets a game reuse its own save name", () => {
    expect(nameTakenByOtherGame(slots, "St Mary's", 1)).toBe(false);
  });

  it("refuses another game's name, ignoring case and spaces", () => {
    expect(nameTakenByOtherGame(slots, "  st mary's ", 2)).toBe(true);
  });

  it("counts autosaves as using their name", () => {
    expect(nameTakenByOtherGame(slots, "Riverside", 1)).toBe(true);
  });

  it("allows unused names", () => {
    expect(nameTakenByOtherGame(slots, "General", 3)).toBe(false);
  });
});
