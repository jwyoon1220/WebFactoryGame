// =============================================================================
//  App — thin React shell around the Pixi canvas + boot sequence.
//
//  React owns the DOM/HUD (menus, research panel, offline-report modal); Pixi
//  owns the canvas game world. They never fight over the same nodes.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { boot, type BootResult } from "./boot";
import { ItemId } from "@shared/types";

// null -> the server assigns a per-IP world; `?world=<id>` shares a specific one.
const EXPLICIT_WORLD = new URLSearchParams(location.search).get("world");

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<BootResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let booted: BootResult | null = null;
    if (!canvasRef.current) return;

    boot(EXPLICIT_WORLD, canvasRef.current)
      .then((r) => {
        if (disposed) {
          r.loop.stop();
          r.saver.stop();
          return;
        }
        booted = r;
        setResult(r);
      })
      .catch((e) => setError(String(e)));

    return () => {
      disposed = true;
      booted?.loop.stop();
      booted?.saver.stop();
      void booted?.saver.flush();
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#10141c" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      {error && <div style={panelStyle}>⚠️ {error}</div>}
      {result && <OfflineModal report={result} />}
    </div>
  );
}

function OfflineModal({ report }: { report: BootResult }) {
  const [open, setOpen] = useState(true);
  const r = report.offline;
  if (!open || r.simulatedSeconds <= 0) return null;
  const mins = Math.round(r.simulatedSeconds / 60);
  return (
    <div style={panelStyle}>
      <h2 style={{ margin: "0 0 8px" }}>While you were away ({mins} min)</h2>
      <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
        {Object.entries(r.produced).map(([id, n]) => (
          <li key={id}>
            {ItemId[Number(id) as ItemId] ?? `item ${id}`}: +{n}
          </li>
        ))}
        {r.researchUnits > 0 && <li>research: +{r.researchUnits}</li>}
      </ul>
      <button onClick={() => setOpen(false)}>Continue</button>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  padding: 16,
  minWidth: 240,
  color: "#e6edf3",
  background: "rgba(20,26,38,0.92)",
  border: "1px solid #2b3550",
  borderRadius: 10,
  font: "14px/1.4 system-ui, sans-serif",
};
