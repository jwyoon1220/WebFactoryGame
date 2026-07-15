// =============================================================================
//  App — React HUD around the Pixi canvas: build toolbar, inspector, offline
//  report. React owns DOM chrome; Pixi owns the game world. The two communicate
//  only through the shared mutable BuildState and the loop's onInspect callback.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { boot, type BootResult } from "./boot";
import { EntityType, ItemId, type Direction } from "@shared/types";
import type { Tool } from "./BuildState";
import type { InspectInfo } from "./render/GameLoop";

const EXPLICIT_WORLD = new URLSearchParams(location.search).get("world");

interface ToolDef {
  key: string;
  label: string;
  tool: Tool;
  color: string;
}
const TOOLS: ToolDef[] = [
  { key: "1", label: "✋ Move", tool: { kind: "move" }, color: "#3a4257" },
  { key: "2", label: "⛏ Miner", tool: { kind: "build", type: EntityType.Miner }, color: "#d9a441" },
  { key: "3", label: "▮ Belt", tool: { kind: "build", type: EntityType.Belt }, color: "#8fa0b8" },
  { key: "4", label: "🔥 Smelter", tool: { kind: "build", type: EntityType.Smelter }, color: "#c0563b" },
  { key: "5", label: "⚙ Assembler", tool: { kind: "build", type: EntityType.Assembler }, color: "#3f8fbf" },
  { key: "6", label: "📦 Chest", tool: { kind: "build", type: EntityType.Chest }, color: "#8a6d3b" },
  { key: "7", label: "🗑 Delete", tool: { kind: "delete" }, color: "#c0503f" },
];
const DIR_LABEL = ["↑ N", "→ E", "↓ S", "← W"];

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<BootResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [dir, setDir] = useState<Direction>(1);
  const [inspect, setInspect] = useState<InspectInfo | null>(null);

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
        r.loop.onInspect = (info) => setInspect(info);
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

  // Keyboard: 1-7 select tools, R rotates.
  useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "r") {
        const nd = ((dir + 1) & 3) as Direction;
        setDir(nd);
        result.build.dir = nd;
        return;
      }
      const idx = TOOLS.findIndex((t) => t.key === e.key);
      if (idx >= 0) selectTool(idx);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result, dir]);

  function selectTool(idx: number) {
    setSelected(idx);
    if (result) result.build.tool = TOOLS[idx].tool;
  }

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#0e121a" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />

      {error && <div style={panel(16, 16)}>⚠️ {error}</div>}

      {result && (
        <>
          {/* Toolbar */}
          <div style={{ ...panel(undefined, undefined), left: "50%", bottom: 16, top: "auto", transform: "translateX(-50%)", display: "flex", gap: 6, padding: 8 }}>
            {TOOLS.map((t, i) => (
              <button
                key={t.key}
                onClick={() => selectTool(i)}
                style={toolBtn(i === selected)}
                title={`[${t.key}]`}
              >
                {t.label}
              </button>
            ))}
            <button onClick={() => { const nd = ((dir + 1) & 3) as Direction; setDir(nd); if (result) result.build.dir = nd; }} style={toolBtn(false)} title="[R] rotate">
              {DIR_LABEL[dir]}
            </button>
          </div>

          {/* Inspector */}
          {inspect && (
            <div style={panel(16, undefined, 16)}>
              <strong>{inspect.title}</strong>
              {inspect.lines.map((l, i) => (
                <div key={i} style={{ opacity: 0.85, fontSize: 12 }}>{l}</div>
              ))}
            </div>
          )}

          {/* Help */}
          <div style={{ ...panel(undefined, 16), fontSize: 12, opacity: 0.85, maxWidth: 260 }}>
            드래그(이동툴)=화면 이동 · 휠=줌 · 클릭/드래그=설치 · 우클릭=삭제 · R=회전
            <br />⛏ 채굴기는 광석 위에만. 벨트로 🔥제련소에 광석을 넣어보세요.
          </div>

          <OfflineModal report={result} />
        </>
      )}
    </div>
  );
}

function OfflineModal({ report }: { report: BootResult }) {
  const [open, setOpen] = useState(true);
  const r = report.offline;
  if (!open || r.simulatedSeconds <= 0) return null;
  const mins = Math.round(r.simulatedSeconds / 60);
  return (
    <div style={{ ...panel(undefined, undefined), left: "50%", top: "40%", transform: "translate(-50%,-50%)", minWidth: 240 }}>
      <h3 style={{ margin: "0 0 8px" }}>자리를 비운 동안 ({mins}분)</h3>
      <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
        {Object.entries(r.produced).map(([id, n]) => (
          <li key={id}>{ItemId[Number(id) as ItemId] ?? id}: +{n}</li>
        ))}
        {r.researchUnits > 0 && <li>research: +{r.researchUnits}</li>}
        {Object.keys(r.produced).length === 0 && r.researchUnits === 0 && <li>생산 없음</li>}
      </ul>
      <button onClick={() => setOpen(false)} style={toolBtn(true)}>계속</button>
    </div>
  );
}

// --- inline styles -----------------------------------------------------------

function panel(left?: number, right?: number, bottom?: number): React.CSSProperties {
  return {
    position: "absolute",
    top: bottom === undefined ? 16 : "auto",
    bottom,
    left,
    right,
    padding: 12,
    color: "#e6edf3",
    background: "rgba(18,24,36,0.92)",
    border: "1px solid #2b3550",
    borderRadius: 10,
    font: "13px/1.45 system-ui, sans-serif",
    boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
  };
}
function toolBtn(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    color: active ? "#0e121a" : "#cdd6e2",
    background: active ? "#7fd1ff" : "#1c2436",
    border: "1px solid #33405c",
    borderRadius: 8,
    cursor: "pointer",
    font: "13px system-ui, sans-serif",
  };
}
