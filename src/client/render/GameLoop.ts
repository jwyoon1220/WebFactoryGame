// =============================================================================
//  GameLoop — Pixi.js renderer + camera + build input, decoupled from the sim.
//
//  Requirement #1 still holds: the ticker only (a) advances the fixed-step
//  engine via pump() and (b) draws a snapshot of world state. All game state
//  lives in SimulationEngine / WorldState; the renderer never mutates it except
//  through explicit place()/remove() calls triggered by user input.
// =============================================================================

import { Application, Container, Graphics } from "pixi.js";
import { EntityType, ItemId, MachineState, type AnyEntity } from "@shared/types";
import { RECIPES } from "@shared/recipes";
import type { SimulationEngine } from "@sim/SimulationEngine";
import type { WorldState } from "../WorldState";
import type { BuildState } from "../BuildState";
import { entityIcon, entityLabel, itemIcon, itemLabel, recipeLabel, recipesForMachine } from "../labels";

const TILE = 34; // px per tile at zoom 1

export interface Camera {
  x: number; // world-pixel coordinate at screen centre
  y: number;
  zoom: number;
}

const DIR_VEC: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const STATE_LABEL: Record<MachineState, string> = {
  [MachineState.Idle]: "대기 중 (재료 부족)",
  [MachineState.Working]: "작동 중",
  [MachineState.NoPower]: "전력 부족",
  [MachineState.OutputFull]: "출력 가득 참",
};

export class GameLoop {
  readonly app: Application;
  private engine: SimulationEngine;
  private world: WorldState;
  private build: BuildState;

  private layer = new Container();
  private gfx = new Graphics(); // terrain + entities, redrawn each frame
  private itemsGfx = new Graphics(); // moving belt items
  private uiGfx = new Graphics(); // hover ghost + selection highlight

  camera: Camera = { x: 0, y: 0, zoom: 1 };
  private hover = { tx: 0, ty: 0, inside: false };
  /** Tile "locked in" by a click with the move tool; the inspector tracks it
   *  live until the player clicks it again or picks another tile. */
  private selected: { tx: number; ty: number } | null = null;
  private pointerDown = false;
  private dragged = false;
  private lastPointer = { x: 0, y: 0 };
  private painted = new Set<string>(); // tiles painted during one drag
  private inspectTimer: ReturnType<typeof setInterval> | null = null;

  /** Fired whenever the inspected tile's content changes (hover or selection). */
  onInspect: (info: InspectInfo | null) => void = () => {};

  constructor(app: Application, engine: SimulationEngine, world: WorldState, build: BuildState) {
    this.app = app;
    this.engine = engine;
    this.world = world;
    this.build = build;
    this.layer.addChild(this.gfx, this.itemsGfx, this.uiGfx);
    this.app.stage.addChild(this.layer);
    this.bindInput();
  }

  start(): void {
    this.engine.start();
    this.app.ticker.add(this.frame);
    // Poll the inspected tile a few times a second so progress bars / buffer
    // counts stay live without re-emitting on every 60Hz frame.
    this.inspectTimer = setInterval(() => this.refreshInspect(), 200);
  }
  stop(): void {
    this.app.ticker.remove(this.frame);
    this.engine.stop();
    this.unbindInput();
    if (this.inspectTimer) clearInterval(this.inspectTimer);
  }

  /** Center the camera on the origin — used once after boot. */
  centerOn(tx: number, ty: number): void {
    this.camera.x = tx * TILE;
    this.camera.y = ty * TILE;
  }

  // --- Main loop ------------------------------------------------------------

  private lastMs = performance.now();
  private frame = (): void => {
    const now = performance.now();
    const dt = now - this.lastMs;
    this.lastMs = now;
    this.engine.pump(dt);
    this.draw();
  };

  private screenCenter(): { x: number; y: number } {
    return { x: this.app.renderer.width / 2, y: this.app.renderer.height / 2 };
  }
  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const c = this.screenCenter();
    return { x: c.x + (wx - this.camera.x) * this.camera.zoom, y: c.y + (wy - this.camera.y) * this.camera.zoom };
  }
  private screenToTile(sx: number, sy: number): { tx: number; ty: number } {
    const c = this.screenCenter();
    const wx = (sx - c.x) / this.camera.zoom + this.camera.x;
    const wy = (sy - c.y) / this.camera.zoom + this.camera.y;
    return { tx: Math.floor(wx / TILE), ty: Math.floor(wy / TILE) };
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();
    this.itemsGfx.clear();
    this.uiGfx.clear();

    const c = this.screenCenter();
    const z = this.camera.zoom;
    // Visible tile bounds (+1 margin).
    const halfW = c.x / z;
    const halfH = c.y / z;
    const minTx = Math.floor((this.camera.x - halfW) / TILE) - 1;
    const maxTx = Math.floor((this.camera.x + halfW) / TILE) + 1;
    const minTy = Math.floor((this.camera.y - halfH) / TILE) - 1;
    const maxTy = Math.floor((this.camera.y + halfH) / TILE) + 1;

    const p = (wx: number, wy: number) => this.worldToScreen(wx, wy);
    const s = z; // scale for sizes

    // 1. Ore + grid.
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const a = p(tx * TILE, ty * TILE);
        const size = TILE * s;
        const ore = this.world.oreAtTile(tx, ty);
        // Origin marker: a faint highlight at (0,0) so a fresh player can spot
        // their spawn point at a glance.
        if (tx === 0 && ty === 0) {
          g.rect(a.x, a.y, size, size).fill({ color: 0x2c3a4e, alpha: 0.9 });
        } else if (ore !== ItemId.None) {
          g.rect(a.x, a.y, size, size).fill({ color: ORE_COLOR[ore] ?? 0x333333, alpha: 0.55 });
        }
        g.rect(a.x, a.y, size, size).stroke({ color: 0x232a36, width: 1, alpha: 0.55 });
      }
    }

    // 2. Entities.
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const e = this.world.entityAtTile(tx, ty);
        if (!e) continue;
        this.drawEntity(g, e, tx, ty, s, p);
      }
    }

    // 3. Moving belt items.
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const segId = this.world.beltSegmentIdAt(tx, ty);
        if (segId === undefined) continue;
        const seg = this.world.beltSystem.getSegment(segId);
        const belt = this.world.entityAtTile(tx, ty);
        if (!seg || !belt) continue;
        const [dx, dy] = DIR_VEC[belt.dir];
        seg.forEachItem((item, distFromExit) => {
          const f = distFromExit / seg.length; // 0 at exit(front) .. 1 at entry
          const off = (0.5 - f) * TILE;
          const wx = tx * TILE + TILE / 2 + dx * off;
          const wy = ty * TILE + TILE / 2 + dy * off;
          const a = p(wx, wy);
          this.itemsGfx
            .circle(a.x, a.y, Math.max(2, TILE * 0.16 * s))
            .fill(ITEM_COLOR[item] ?? 0xffffff)
            .stroke({ color: 0x10141c, width: 1, alpha: 0.6 });
        });
      }
    }

    // 4. Selection (locked) + hover ghost.
    if (this.selected) {
      const a = p(this.selected.tx * TILE, this.selected.ty * TILE);
      this.uiGfx.rect(a.x, a.y, TILE * s, TILE * s).stroke({ color: 0x7fd1ff, width: 3, alpha: 0.9 });
    }
    if (this.hover.inside) {
      const a = p(this.hover.tx * TILE, this.hover.ty * TILE);
      const size = TILE * s;
      if (this.build.tool.kind === "build") {
        const ok = this.canPlaceHere(this.build.tool.type, this.hover.tx, this.hover.ty);
        this.uiGfx.rect(a.x, a.y, size, size).fill({ color: ok ? 0x4ec06a : 0xc0503f, alpha: 0.35 });
        this.drawDirNotch(this.uiGfx, this.hover.tx, this.hover.ty, this.build.dir, s, p, 0xffffff);
      } else if (!this.selected || this.selected.tx !== this.hover.tx || this.selected.ty !== this.hover.ty) {
        this.uiGfx.rect(a.x, a.y, size, size).stroke({ color: 0xffffff, width: 1.5, alpha: 0.4 });
      }
    }
  }

  private drawEntity(
    g: Graphics,
    e: AnyEntity,
    tx: number,
    ty: number,
    s: number,
    p: (wx: number, wy: number) => { x: number; y: number }
  ): void {
    const a = p(tx * TILE + TILE * 0.12, ty * TILE + TILE * 0.12);
    const size = TILE * 0.76 * s;
    if (e.type === EntityType.Belt) {
      // Belt: dark tile with a direction arrow.
      const full = p(tx * TILE, ty * TILE);
      g.rect(full.x, full.y, TILE * s, TILE * s).fill({ color: 0x39414f, alpha: 0.9 });
      this.drawArrow(g, tx, ty, e.dir, s, p, 0x8fa0b8);
      return;
    }
    const color = ENTITY_COLOR[e.type] ?? 0x777777;
    g.roundRect(a.x, a.y, size, size, 4 * s).fill(color).stroke({ color: 0x101418, width: 2 });
    this.drawDirNotch(g, tx, ty, e.dir, s, p, 0x11151b);

    // Progress bar for working machines.
    if ("progress" in e && "recipe" in e) {
      const recipe = e.recipe >= 0 ? RECIPES[e.recipe] : null;
      if (recipe && recipe.ticks > 0) {
        const frac = Math.max(0, Math.min(1, e.progress / recipe.ticks));
        const bar = p(tx * TILE + TILE * 0.12, ty * TILE + TILE * 0.86);
        const barColor =
          e.state === MachineState.NoPower ? 0xc0503f : e.state === MachineState.Working ? 0x6ad06a : 0x8a8f9c;
        g.rect(bar.x, bar.y, TILE * 0.76 * s, TILE * 0.08 * s).fill({ color: 0x11151b, alpha: 0.6 });
        if (frac > 0) g.rect(bar.x, bar.y, TILE * 0.76 * s * frac, TILE * 0.08 * s).fill(barColor);
      }
    }
  }

  private drawArrow(g: Graphics, tx: number, ty: number, dir: number, s: number, p: Fn, color: number): void {
    const [dx, dy] = DIR_VEC[dir];
    const cx = tx * TILE + TILE / 2;
    const cy = ty * TILE + TILE / 2;
    const tip = p(cx + dx * TILE * 0.3, cy + dy * TILE * 0.3);
    const bl = p(cx - dx * TILE * 0.2 - dy * TILE * 0.18, cy - dy * TILE * 0.2 - dx * TILE * 0.18);
    const br = p(cx - dx * TILE * 0.2 + dy * TILE * 0.18, cy - dy * TILE * 0.2 + dx * TILE * 0.18);
    g.poly([tip.x, tip.y, bl.x, bl.y, br.x, br.y]).fill(color);
    void s;
  }

  private drawDirNotch(g: Graphics, tx: number, ty: number, dir: number, s: number, p: Fn, color: number): void {
    const [dx, dy] = DIR_VEC[dir];
    const cx = tx * TILE + TILE / 2 + dx * TILE * 0.34;
    const cy = ty * TILE + TILE / 2 + dy * TILE * 0.34;
    const a = p(cx, cy);
    g.circle(a.x, a.y, Math.max(2, TILE * 0.08 * s)).fill(color);
  }

  private canPlaceHere(type: EntityType, tx: number, ty: number): boolean {
    if (this.world.entityAtTile(tx, ty)) return false;
    if (type === EntityType.Miner && this.world.oreAtTile(tx, ty) === ItemId.None) return false;
    return true;
  }

  // --- Input ----------------------------------------------------------------

  private bindInput(): void {
    const v = this.app.canvas as HTMLCanvasElement;
    v.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    v.addEventListener("wheel", this.onWheel, { passive: false });
    v.addEventListener("contextmenu", this.onContext);
  }
  private unbindInput(): void {
    const v = this.app.canvas as HTMLCanvasElement;
    v.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    v.removeEventListener("wheel", this.onWheel);
    v.removeEventListener("contextmenu", this.onContext);
  }

  private onContext = (e: Event): void => e.preventDefault();

  private onDown = (e: PointerEvent): void => {
    this.pointerDown = true;
    this.dragged = false;
    this.painted.clear();
    this.lastPointer = { x: e.clientX, y: e.clientY };
    // Right button always deletes at the tile.
    if (e.button === 2) {
      const { tx, ty } = this.screenToTile(e.clientX, e.clientY);
      this.world.remove(tx, ty);
      this.clearSelectionIfMatches(tx, ty);
      return;
    }
    // Left with a build tool: begin painting.
    if (e.button === 0 && this.build.tool.kind === "build") {
      this.paintAt(e.clientX, e.clientY);
    }
  };

  private onMove = (e: PointerEvent): void => {
    const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { tx, ty } = this.screenToTile(sx, sy);
    const inside = sx >= 0 && sy >= 0 && sx <= rect.width && sy <= rect.height;
    const hoverChanged = tx !== this.hover.tx || ty !== this.hover.ty || inside !== this.hover.inside;
    this.hover = { tx, ty, inside };
    if (hoverChanged && !this.selected) this.refreshInspect();

    if (!this.pointerDown) return;
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.dragged = true;

    const panning =
      !!(e.buttons & 4) || // middle
      this.build.tool.kind === "move"; // move tool pans with left drag
    if (panning) {
      this.camera.x -= dx / this.camera.zoom;
      this.camera.y -= dy / this.camera.zoom;
    } else if (this.build.tool.kind === "build" && e.buttons & 1) {
      this.paintAt(sx, sy); // drag-paint belts/machines
    } else if (this.build.tool.kind === "delete" && e.buttons & 1) {
      this.world.remove(tx, ty);
      this.clearSelectionIfMatches(tx, ty);
    }
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent): void => {
    if (this.pointerDown && !this.dragged && e.button === 0) {
      const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { tx, ty } = this.screenToTile(sx, sy);
      if (this.build.tool.kind === "delete") {
        this.world.remove(tx, ty);
        this.clearSelectionIfMatches(tx, ty);
      } else if (this.build.tool.kind === "build") {
        this.paintAt(sx, sy);
      } else {
        // Move tool: click toggles a "locked" selection so the inspector
        // keeps showing this tile's live stats even after the mouse leaves.
        this.selected =
          this.selected && this.selected.tx === tx && this.selected.ty === ty ? null : { tx, ty };
        this.refreshInspect();
      }
    }
    this.pointerDown = false;
  };

  private clearSelectionIfMatches(tx: number, ty: number): void {
    if (this.selected && this.selected.tx === tx && this.selected.ty === ty) {
      this.selected = null;
      this.refreshInspect();
    }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = this.screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.camera.zoom = Math.max(0.3, Math.min(3, this.camera.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    // Keep the point under the cursor fixed while zooming.
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
  };

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const c = this.screenCenter();
    return { x: (sx - c.x) / this.camera.zoom + this.camera.x, y: (sy - c.y) / this.camera.zoom + this.camera.y };
  }

  private paintAt(sx: number, sy: number): void {
    if (this.build.tool.kind !== "build") return;
    const { tx, ty } = this.screenToTile(sx, sy);
    const key = `${tx},${ty}`;
    if (this.painted.has(key)) return;
    this.painted.add(key);
    this.world.place(tx, ty, this.build.tool.type, this.build.dir);
  }

  // --- Inspector --------------------------------------------------------------

  private refreshInspect(): void {
    const tile = this.selected ?? (this.hover.inside ? { tx: this.hover.tx, ty: this.hover.ty } : null);
    // Bare ground (no ore, nothing built) has nothing worth showing — don't
    // pop an empty panel on every hover, and drop a stale selection on it.
    if (tile && !this.world.entityAtTile(tile.tx, tile.ty) && this.world.oreAtTile(tile.tx, tile.ty) === ItemId.None) {
      if (this.selected && this.selected.tx === tile.tx && this.selected.ty === tile.ty) this.selected = null;
      this.onInspect(null);
      return;
    }
    if (!tile) {
      this.onInspect(null);
      return;
    }
    this.onInspect(this.buildInspectInfo(tile.tx, tile.ty, !!this.selected));
  }

  private buildInspectInfo(tx: number, ty: number, locked: boolean): InspectInfo {
    const e = this.world.entityAtTile(tx, ty);
    if (!e) {
      const ore = this.world.oreAtTile(tx, ty);
      return {
        tx,
        ty,
        locked,
        icon: itemIcon(ore),
        title: `${itemLabel(ore)} 매장지`,
        lines: ["⛏ 채굴기를 설치하면 자동으로 캐냅니다."],
      };
    }

    if (e.type === EntityType.Belt) {
      const seg = this.world.beltSystem.getSegment(this.world.beltSegmentIdAt(tx, ty) ?? -1);
      return {
        tx,
        ty,
        locked,
        icon: entityIcon(EntityType.Belt),
        title: entityLabel(EntityType.Belt),
        lines: [`실려 있는 아이템: ${seg?.itemCount ?? 0}개`],
      };
    }

    if (e.type === EntityType.Chest) {
      const lines = invLines(e.inventory);
      return {
        tx,
        ty,
        locked,
        icon: entityIcon(EntityType.Chest),
        title: entityLabel(EntityType.Chest),
        lines: lines.length ? lines : ["비어 있음"],
      };
    }

    // Machines (miner/smelter/assembler/lab/generator).
    const lines: string[] = [];
    if ("input" in e) lines.push(...invLines(e.input, "투입"));
    if ("output" in e) lines.push(...invLines(e.output, "산출"));
    const info: InspectInfo = {
      tx,
      ty,
      locked,
      icon: entityIcon(e.type),
      title: entityLabel(e.type),
      lines,
      state: "state" in e ? e.state : undefined,
      stateLabel: "state" in e ? STATE_LABEL[e.state] : undefined,
    };
    if ("recipe" in e && "progress" in e) {
      const recipe = e.recipe >= 0 ? RECIPES[e.recipe] : null;
      info.progressFrac = recipe && recipe.ticks > 0 ? Math.max(0, Math.min(1, e.progress / recipe.ticks)) : 0;
      info.currentRecipe = e.recipe;
      info.currentRecipeLabel = e.recipe >= 0 ? recipeLabel(e.recipe) : undefined;
    }
    if (e.type === EntityType.Smelter || e.type === EntityType.Assembler) {
      info.recipeOptions = recipesForMachine(e.type);
    }
    return info;
  }
}

type Fn = (wx: number, wy: number) => { x: number; y: number };

export interface InspectInfo {
  tx: number;
  ty: number;
  /** True when the player clicked to "lock" this tile (vs. just hovering). */
  locked: boolean;
  icon: string;
  title: string;
  lines: string[];
  state?: MachineState;
  stateLabel?: string;
  progressFrac?: number;
  currentRecipe?: number;
  currentRecipeLabel?: string;
  recipeOptions?: Array<{ index: number; label: string }>;
}

function invLines(inv: Partial<Record<ItemId, number>>, prefix?: string): string[] {
  const entries = Object.entries(inv).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return [];
  const body = entries.map(([k, n]) => `${itemIcon(Number(k) as ItemId)} ${itemLabel(Number(k) as ItemId)} ×${n}`);
  return prefix ? [`${prefix}: ${body.join(", ")}`] : body;
}

const ORE_COLOR: Partial<Record<ItemId, number>> = {
  [ItemId.IronOre]: 0x7d8ea3,
  [ItemId.CopperOre]: 0xc0713f,
  [ItemId.Coal]: 0x2b2f38,
  [ItemId.Stone]: 0x9a8b6f,
};
const ITEM_COLOR: Partial<Record<ItemId, number>> = {
  [ItemId.IronOre]: 0x9fb0c4,
  [ItemId.CopperOre]: 0xd98a56,
  [ItemId.Coal]: 0x3a3f49,
  [ItemId.Stone]: 0xbfb192,
  [ItemId.IronPlate]: 0xd7dde6,
  [ItemId.CopperPlate]: 0xe0a070,
  [ItemId.IronGear]: 0xaeb7c2,
  [ItemId.CopperCable]: 0xe8b060,
  [ItemId.Circuit]: 0x63c76a,
  [ItemId.SciencePackRed]: 0xd85c5c,
  [ItemId.SciencePackGreen]: 0x5cc47a,
};
const ENTITY_COLOR: Partial<Record<EntityType, number>> = {
  [EntityType.Miner]: 0xd9a441,
  [EntityType.Smelter]: 0xc0563b,
  [EntityType.Assembler]: 0x3f8fbf,
  [EntityType.Lab]: 0x8b5cc4,
  [EntityType.Chest]: 0x8a6d3b,
  [EntityType.Generator]: 0xcf5030,
  [EntityType.PowerPole]: 0x6b7280,
};
