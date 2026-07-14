// =============================================================================
//  PowerSystem — grids, supply/demand, and proportional throttling.
//
//  Power poles with overlapping coverage radii form a connected *grid*. Each
//  grid sums generator supply and machine demand for the tick. If demand
//  exceeds supply the whole grid is throttled by the deficit ratio:
//
//      throttle = clamp(supply / demand, 0, 1)
//
//  Every machine on that grid then runs at `throttle` speed (0 = full stop).
//  This is the standard Factorio "brownout" model and is applied identically in
//  the live tick and the offline fast-forward so catch-up math matches play.
// =============================================================================

export interface GridPower {
  supplyKW: number;
  demandKW: number;
  /** 0..1 speed multiplier for every machine on the grid this tick. */
  throttle: number;
}

export class PowerSystem {
  /** Accumulated per-grid demand/supply for the current tick. */
  private grids = new Map<number, GridPower>();

  /** Reset all grid accumulators at the start of a tick. */
  beginTick(): void {
    for (const g of this.grids.values()) {
      g.supplyKW = 0;
      g.demandKW = 0;
      g.throttle = 1;
    }
  }

  private grid(id: number): GridPower {
    let g = this.grids.get(id);
    if (!g) {
      g = { supplyKW: 0, demandKW: 0, throttle: 1 };
      this.grids.set(id, g);
    }
    return g;
  }

  /** A generator contributes supply to its grid. */
  addSupply(gridId: number, kw: number): void {
    this.grid(gridId).supplyKW += kw;
  }

  /** A working machine contributes demand to its grid. */
  addDemand(gridId: number, kw: number): void {
    this.grid(gridId).demandKW += kw;
  }

  /**
   * After all supply/demand is registered, compute each grid's throttle.
   * Call once per tick before machines apply their speed factor.
   */
  resolve(): void {
    for (const g of this.grids.values()) {
      g.throttle = g.demandKW <= 0 ? 1 : Math.max(0, Math.min(1, g.supplyKW / g.demandKW));
    }
  }

  /**
   * Speed multiplier (0..1) for a machine on the given grid. Grid 0 is the
   * sentinel "ungridded" grid: burner-type machines and anything not wired to a
   * power pole run unthrottled, so they are never starved by the electric model.
   */
  throttleFor(gridId: number): number {
    if (gridId === 0) return 1;
    return this.grids.get(gridId)?.throttle ?? 1;
  }
}
