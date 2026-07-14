// =============================================================================
//  GameLoop — Pixi.js render loop, strictly decoupled from the simulation.
//
//  Requirement #1: rendering is vsync-bound (~60 FPS but variable); the sim is a
//  fixed 60 Hz step. The render ticker only:
//    1. hands real elapsed time to engine.pump(), which runs 0..N fixed ticks;
//    2. receives the interpolation `alpha` and draws entities/items between
//       their previous and current tick positions for smooth motion.
//
//  The renderer NEVER mutates simulation state. It reads a snapshot each frame.
// =============================================================================

import { Application, Container } from "pixi.js";
import type { SimulationEngine } from "@sim/SimulationEngine";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export class GameLoop {
  readonly app: Application;
  readonly world = new Container();
  private engine: SimulationEngine;
  private lastMs = performance.now();
  camera: Camera = { x: 0, y: 0, zoom: 1 };

  constructor(app: Application, engine: SimulationEngine) {
    this.app = app;
    this.engine = engine;
    this.app.stage.addChild(this.world);
  }

  start(): void {
    this.engine.start();
    this.lastMs = performance.now();
    this.app.ticker.add(this.frame);
  }

  stop(): void {
    this.app.ticker.remove(this.frame);
    this.engine.stop();
  }

  /** One render frame. Drives fixed-step sim, then draws with interpolation. */
  private frame = (): void => {
    const now = performance.now();
    const elapsed = now - this.lastMs;
    this.lastMs = now;

    // Advance the simulation by however many whole ticks fit in `elapsed`.
    const alpha = this.engine.pump(elapsed);

    // Draw using `alpha` to interpolate between the last two sim states so item
    // motion looks smooth at any frame rate. (Sprite sync omitted here; hooks
    // into a sprite pool keyed by entity id / belt-segment item index.)
    this.render(alpha);
  };

  private render(_alpha: number): void {
    // Camera transform.
    this.world.scale.set(this.camera.zoom);
    this.world.position.set(
      this.app.renderer.width / 2 - this.camera.x * this.camera.zoom,
      this.app.renderer.height / 2 - this.camera.y * this.camera.zoom
    );
    // A production renderer culls to the visible chunk window and updates a
    // pooled sprite per visible entity + per belt item using `_alpha`.
  }
}
