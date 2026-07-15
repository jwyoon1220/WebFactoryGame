// Shared, mutable build state. React writes it (toolbar); the Pixi input loop
// reads it every frame. Kept as a plain object so neither side re-renders the
// other — the canvas is not a React tree.

import type { Direction, EntityType } from "@shared/types";

export type Tool =
  | { kind: "move" } // pan / inspect only
  | { kind: "delete" } // left-click removes
  | { kind: "build"; type: EntityType };

export interface BuildState {
  tool: Tool;
  dir: Direction;
}

export function createBuildState(): BuildState {
  return { tool: { kind: "move" }, dir: 1 };
}
