// =============================================================================
//  SaveScheduler — batches dirty chunks and flushes them to /api/save.
//
//  Requirement #2: never write to D1 on every tile edit. We mark chunks dirty in
//  memory and flush on a 30-60s cadence, plus a guaranteed final flush on tab
//  close via navigator.sendBeacon (which survives page unload where fetch won't).
// =============================================================================

import type { ChunkTileData, ResearchState, SavePayload } from "@shared/types";

/** A chunk-provider the scheduler calls to serialize current live state. */
export interface ChunkSource {
  /** Serialize the given chunk coordinate to its persistable blob. */
  serializeChunk(cx: number, cy: number): ChunkTileData;
  /** Current global research state. */
  getResearch(): ResearchState;
  /** Client's authoritative sim tick. */
  getSimTick(): number;
}

export type SaveStatus = "idle" | "dirty" | "saving" | "error";

export class SaveScheduler {
  private dirty = new Set<string>(); // "cx,cy"
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Surfaced to the HUD so the player can see autosave is actually working. */
  onStatusChange: (status: SaveStatus, savedAt?: number) => void = () => {};

  constructor(
    private readonly worldId: string,
    private readonly source: ChunkSource,
    /** Flush cadence in ms; spec calls for 30-60s. */
    private readonly intervalMs = 45_000
  ) {}

  /** Mark a chunk as needing persistence (called on any edit within it). */
  markDirty(cx: number, cy: number): void {
    const wasEmpty = this.dirty.size === 0;
    this.dirty.add(`${cx},${cy}`);
    if (wasEmpty) this.onStatusChange("dirty");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    // Guaranteed final flush on disconnect / tab close.
    window.addEventListener("pagehide", this.flushBeacon);
    document.addEventListener("visibilitychange", this.onHidden);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("pagehide", this.flushBeacon);
    document.removeEventListener("visibilitychange", this.onHidden);
  }

  private onHidden = (): void => {
    if (document.visibilityState === "hidden") this.flushBeacon();
  };

  private buildPayload(): SavePayload | null {
    if (this.dirty.size === 0) return null;
    const chunks: ChunkTileData[] = [];
    for (const key of this.dirty) {
      const [cx, cy] = key.split(",").map(Number);
      chunks.push(this.source.serializeChunk(cx, cy));
    }
    return {
      worldId: this.worldId,
      simTick: this.source.getSimTick(),
      research: this.source.getResearch(),
      chunks,
    };
  }

  /** Normal periodic flush via fetch. Clears dirty set on success. */
  async flush(): Promise<void> {
    const payload = this.buildPayload();
    if (!payload) return;
    const snapshot = new Set(this.dirty);
    this.onStatusChange("saving");
    try {
      const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // Same-origin: cookies flow, no CORS. keepalive helps late flushes.
        keepalive: true,
      });
      if (res.ok) {
        for (const k of snapshot) this.dirty.delete(k);
        this.onStatusChange(this.dirty.size > 0 ? "dirty" : "idle", Date.now());
      } else {
        this.onStatusChange("error");
      }
    } catch {
      // Keep chunks dirty; next interval retries.
      this.onStatusChange("error");
    }
  }

  /** Unload-safe flush. sendBeacon is fire-and-forget but survives page death. */
  private flushBeacon = (): void => {
    const payload = this.buildPayload();
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    if (navigator.sendBeacon("/api/save", blob)) this.dirty.clear();
  };
}
