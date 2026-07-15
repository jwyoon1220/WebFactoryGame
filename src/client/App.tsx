// =============================================================================
//  App — React HUD around the Pixi canvas: top bar, build toolbar, inspector,
//  guide, offline report. React owns DOM chrome; Pixi owns the game world. The
//  two communicate only through the shared mutable BuildState, WorldState calls,
//  and the loop's onInspect/saver's onStatusChange callbacks.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { boot, type BootResult } from "./boot";
import { EntityType, type Direction } from "@shared/types";
import type { Tool } from "./BuildState";
import type { InspectInfo } from "./render/GameLoop";
import type { SaveStatus } from "./SaveScheduler";
import { entityDesc, entityIcon, entityLabel, itemLabel } from "./labels";

const EXPLICIT_WORLD = new URLSearchParams(location.search).get("world");
const GUIDE_SEEN_KEY = "wf_guide_seen_v1";

interface ToolDef {
  key: string;
  label: string;
  tool: Tool;
  desc: string;
}
const TOOLS: ToolDef[] = [
  { key: "1", label: "✋ 이동", tool: { kind: "move" }, desc: "드래그로 화면을 이동하고, 클릭해서 타일 정보를 확인합니다." },
  { key: "2", label: "⛏ 채굴기", tool: { kind: "build", type: EntityType.Miner }, desc: entityDesc(EntityType.Miner) },
  { key: "3", label: "➡️ 벨트", tool: { kind: "build", type: EntityType.Belt }, desc: entityDesc(EntityType.Belt) },
  { key: "4", label: "🔥 제련소", tool: { kind: "build", type: EntityType.Smelter }, desc: entityDesc(EntityType.Smelter) },
  { key: "5", label: "⚙ 조립기", tool: { kind: "build", type: EntityType.Assembler }, desc: entityDesc(EntityType.Assembler) },
  { key: "6", label: "📦 상자", tool: { kind: "build", type: EntityType.Chest }, desc: entityDesc(EntityType.Chest) },
  { key: "7", label: "🗑 삭제", tool: { kind: "delete" }, desc: "설치된 건물/벨트를 제거합니다. (우클릭으로도 가능)" },
];
const DIR_LABEL = ["↑ 북", "→ 동", "↓ 남", "← 서"];
const SAVE_LABEL: Record<SaveStatus, string> = {
  idle: "🟢 저장됨",
  dirty: "🟡 변경됨",
  saving: "🔵 저장 중…",
  error: "🔴 저장 실패 (재시도 중)",
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<BootResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [dir, setDir] = useState<Direction>(1);
  const [inspect, setInspect] = useState<InspectInfo | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [tick, setTick] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  // Only one full-screen modal at a time: the offline report takes priority
  // (it's about *this* session), and the first-visit guide follows once it's
  // dismissed — they must never render stacked, or the top one blocks clicks
  // on the one underneath.
  const [showOffline, setShowOffline] = useState(false);
  const pendingGuide = useRef(false);

  // Boot sequence: load -> offline catch-up -> live engine + renderer.
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
        r.saver.onStatusChange = (s) => setSaveStatus(s);
        setResult(r);

        const firstVisit = !localStorage.getItem(GUIDE_SEEN_KEY);
        localStorage.setItem(GUIDE_SEEN_KEY, "1");
        if (r.offline.simulatedSeconds > 0) {
          setShowOffline(true);
          pendingGuide.current = firstVisit;
        } else if (firstVisit) {
          setGuideOpen(true);
        }
      })
      .catch((e) => setError(String(e)));

    return () => {
      disposed = true;
      booted?.loop.stop();
      booted?.saver.stop();
      void booted?.saver.flush();
    };
  }, []);

  // Poll the tick counter for the HUD (cheap; a few times a second is plenty).
  useEffect(() => {
    if (!result) return;
    const id = setInterval(() => setTick(result.engine.currentTick), 500);
    return () => clearInterval(id);
  }, [result]);

  // Keyboard: 1-7 select tools, R rotates, ? toggles the guide.
  useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key.toLowerCase() === "r") {
        rotate();
        return;
      }
      if (e.key === "?") {
        openGuide();
        return;
      }
      const idx = TOOLS.findIndex((t) => t.key === e.key);
      if (idx >= 0) selectTool(idx);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, dir]);

  function selectTool(idx: number) {
    setSelected(idx);
    if (result) result.build.tool = TOOLS[idx].tool;
  }
  function rotate() {
    const nd = ((dir + 1) & 3) as Direction;
    setDir(nd);
    if (result) result.build.dir = nd;
  }
  function changeRecipe(recipeIndex: number) {
    if (!result || !inspect) return;
    result.world.setRecipe(inspect.tx, inspect.ty, recipeIndex);
  }
  /** Explicit user request always wins over the offline-report modal. */
  function openGuide() {
    setShowOffline(false);
    setGuideOpen(true);
  }
  function closeOffline() {
    setShowOffline(false);
    if (pendingGuide.current) {
      pendingGuide.current = false;
      setGuideOpen(true);
    }
  }

  // IMPORTANT: the canvas must always be in the DOM, even before boot()
  // resolves — boot() needs canvasRef.current to attach Pixi to. Loading and
  // error states are overlays on top of it, never a replacement of the tree.
  return (
    <div className="wf-root">
      <style>{CSS}</style>
      <canvas ref={canvasRef} className="wf-canvas" />

      {!result && !error && <LoadingOverlay />}
      {error && <ErrorOverlay message={error} />}

      {result && (
        <>
          <TopBar tick={tick} saveStatus={saveStatus} onGuide={openGuide} />
          <Toolbar selected={selected} dir={dir} onSelect={selectTool} onRotate={rotate} />
          {inspect && <Inspector info={inspect} onRecipeChange={changeRecipe} />}
          {/* Never render both at once — see showOffline/pendingGuide above. */}
          {showOffline ? (
            <OfflineModal report={result} onClose={closeOffline} />
          ) : (
            guideOpen && <Guide onClose={() => setGuideOpen(false)} />
          )}
        </>
      )}
    </div>
  );
}

// --- Screens -------------------------------------------------------------

function LoadingOverlay() {
  return (
    <div className="wf-overlay wf-center" style={{ background: "var(--bg)" }}>
      <div className="wf-spinner" />
      <div style={{ marginTop: 14, color: "var(--text-dim)" }}>공장을 불러오는 중…</div>
    </div>
  );
}

function ErrorOverlay({ message }: { message: string }) {
  return (
    <div className="wf-overlay wf-center">
      <div className="wf-panel" style={{ maxWidth: 420, textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
        <strong>공장을 불러오지 못했습니다</strong>
        <div style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 12, wordBreak: "break-all" }}>{message}</div>
        <button className="wf-btn wf-btn-accent" style={{ marginTop: 14 }} onClick={() => location.reload()}>
          다시 시도
        </button>
      </div>
    </div>
  );
}

// --- HUD pieces ------------------------------------------------------------

function TopBar({ tick, saveStatus, onGuide }: { tick: number; saveStatus: SaveStatus; onGuide: () => void }) {
  const seconds = Math.floor(tick / 60);
  return (
    <div className="wf-topbar">
      <div className="wf-topbar-title">🏭 Web Factory</div>
      <div className="wf-topbar-mid">
        <span title="시뮬레이션 진행 시간 (60틱 = 1초)">⏱ {formatDuration(seconds)}</span>
        <span className={`wf-save wf-save-${saveStatus}`} title="자동 저장 상태 (45초마다 또는 창을 닫을 때 저장)">
          {SAVE_LABEL[saveStatus]}
        </span>
      </div>
      <button className="wf-btn" onClick={onGuide} title="[?] 게임 설명 보기">
        ❓ 가이드
      </button>
    </div>
  );
}

function Toolbar({
  selected,
  dir,
  onSelect,
  onRotate,
}: {
  selected: number;
  dir: Direction;
  onSelect: (i: number) => void;
  onRotate: () => void;
}) {
  const showRotate = TOOLS[selected].tool.kind === "build";
  return (
    <div className="wf-toolbar">
      {TOOLS.map((t, i) => (
        <button
          key={t.key}
          onClick={() => onSelect(i)}
          className={"wf-btn wf-tool" + (i === selected ? " wf-tool-active" : "")}
          title={`[${t.key}] ${t.desc}`}
        >
          {t.label}
        </button>
      ))}
      {showRotate && (
        <button className="wf-btn wf-tool" onClick={onRotate} title="[R] 방향 회전">
          🔄 {DIR_LABEL[dir]}
        </button>
      )}
    </div>
  );
}

function Inspector({ info, onRecipeChange }: { info: InspectInfo; onRecipeChange: (i: number) => void }) {
  return (
    <div className={"wf-panel wf-inspector" + (info.locked ? " wf-inspector-locked" : "")}>
      <div className="wf-inspector-head">
        <span style={{ fontSize: 20 }}>{info.icon}</span>
        <strong>{info.title}</strong>
        {info.locked && <span className="wf-pin" title="클릭으로 고정됨 — 다시 클릭하면 해제">📌</span>}
      </div>

      {info.stateLabel && (
        <div className={"wf-state wf-state-" + (info.state ?? 0)}>{info.stateLabel}</div>
      )}

      {info.progressFrac !== undefined && (
        <div className="wf-progress">
          <div className="wf-progress-fill" style={{ width: `${Math.round(info.progressFrac * 100)}%` }} />
        </div>
      )}

      {info.recipeOptions && info.recipeOptions.length > 0 && (
        <label className="wf-field">
          레시피
          <select
            value={info.currentRecipe ?? -1}
            onChange={(e) => onRecipeChange(Number(e.target.value))}
            className="wf-select"
          >
            {info.currentRecipe === -1 && <option value={-1}>선택 안 함</option>}
            {info.recipeOptions.map((r) => (
              <option key={r.index} value={r.index}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {info.lines.map((l, i) => (
        <div key={i} className="wf-inspector-line">
          {l}
        </div>
      ))}
      {info.lines.length === 0 && !info.recipeOptions && <div className="wf-inspector-line wf-dim">—</div>}
    </div>
  );
}

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-panel wf-guide" onClick={(e) => e.stopPropagation()}>
        <div className="wf-guide-head">
          <strong style={{ fontSize: 16 }}>📖 Web Factory 가이드</strong>
          <button className="wf-btn" onClick={onClose}>
            ✕ 닫기
          </button>
        </div>

        <section>
          <h4>🔁 자동화 루프</h4>
          <p>
            <b>⛏ 채굴기</b> → <b>➡️ 벨트</b> → <b>🔥 제련소</b> 순서로 이어 놓으면 자동으로 자원이 흐릅니다.
            채굴기가 광석을 캐서 벨트에 올리고, 벨트가 제련소까지 실어 나르면, 제련소가 재료를 소모해
            판(plate)을 만듭니다. ⚙ 조립기는 판·부품을 조합해 더 복잡한 제품(톱니바퀴, 회로기판, 과학팩)을
            만듭니다.
          </p>
        </section>

        <section>
          <h4>🕹 조작법</h4>
          <ul>
            <li>하단 툴바에서 도구 선택, 또는 <kbd>1</kbd>~<kbd>7</kbd> 숫자키</li>
            <li>건설 도구 선택 후 <b>클릭 또는 드래그</b>로 설치 (드래그하면 벨트가 길게 깔림)</li>
            <li><kbd>R</kbd> 키 또는 회전 버튼으로 설치 방향 전환</li>
            <li><b>우클릭</b>으로 즉시 삭제, 또는 삭제 도구로 클릭/드래그</li>
            <li><b>이동 도구</b>에서 드래그 = 화면 이동, <b>클릭</b> = 타일 정보 패널 고정(다시 클릭 시 해제)</li>
            <li>마우스 휠 = 확대/축소</li>
            <li><kbd>?</kbd> 키로 이 가이드를 언제든 다시 열 수 있습니다</li>
          </ul>
        </section>

        <section>
          <h4>🏗 건물 설명</h4>
          <ul className="wf-entity-list">
            {[EntityType.Miner, EntityType.Belt, EntityType.Smelter, EntityType.Assembler, EntityType.Chest].map(
              (t) => (
                <li key={t}>
                  <span>{entityIcon(t)}</span>
                  <div>
                    <b>{entityLabel(t)}</b>
                    <div className="wf-dim">{entityDesc(t)}</div>
                  </div>
                </li>
              )
            )}
          </ul>
        </section>

        <section>
          <h4>💾 저장 / 오프라인 진행</h4>
          <p>
            건설 내역은 45초마다, 그리고 창을 닫을 때 자동으로 저장됩니다. 상단의 저장 상태 표시로 확인할
            수 있습니다. 다시 접속하면 자리를 비운 시간만큼 공장이 알아서 돌아간 결과(생산량)를 계산해서
            보여줍니다.
          </p>
        </section>

        <section>
          <h4>🔧 제련소·조립기 레시피 변경</h4>
          <p>
            제련소나 조립기를 클릭해서 고정하면 오른쪽 패널에 <b>레시피 선택</b>이 나타납니다. 여기서
            어떤 제품을 만들지 바꿀 수 있습니다.
          </p>
        </section>
      </div>
    </div>
  );
}

function OfflineModal({ report, onClose }: { report: BootResult; onClose: () => void }) {
  const r = report.offline;
  const mins = Math.round(r.simulatedSeconds / 60);
  const entries = Object.entries(r.produced);
  return (
    <div className="wf-overlay">
      <div className="wf-panel wf-offline">
        <h3 style={{ margin: "0 0 4px" }}>👋 돌아오신 걸 환영합니다</h3>
        <div className="wf-dim" style={{ marginBottom: 12 }}>
          {formatDuration(Math.round(r.simulatedSeconds))} 동안 자리를 비우셨네요 (약 {mins}분)
        </div>
        {entries.length === 0 && r.researchUnits === 0 ? (
          <div className="wf-dim">그동안 생산된 것이 없습니다.</div>
        ) : (
          <ul className="wf-offline-list">
            {entries.map(([id, n]) => (
              <li key={id}>
                <span>{itemLabel(Number(id))}</span>
                <b>+{n}</b>
              </li>
            ))}
            {r.researchUnits > 0 && (
              <li>
                <span>연구 진행도</span>
                <b>+{r.researchUnits}</b>
              </li>
            )}
          </ul>
        )}
        {r.cappedSeconds > 0 && (
          <div className="wf-dim" style={{ marginTop: 8, fontSize: 11 }}>
            (최대 계산 시간을 초과해 일부 시간은 반영되지 않았습니다)
          </div>
        )}
        <button className="wf-btn wf-btn-accent" style={{ marginTop: 14, width: "100%" }} onClick={onClose}>
          계속하기
        </button>
      </div>
    </div>
  );
}

// --- helpers -----------------------------------------------------------------

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

// --- styles ------------------------------------------------------------------

const CSS = `
:root {
  --bg: #0b0e14;
  --panel: rgba(19,25,37,0.94);
  --panel-strong: rgba(24,31,46,0.98);
  --border: #2b3550;
  --text: #e6edf3;
  --text-dim: #93a1b8;
  --accent: #7fd1ff;
  --accent-strong: #3fa9e0;
  --danger: #e2685a;
  --good: #4ec06a;
  --warn: #e0b23f;
}
.wf-root { position: fixed; inset: 0; overflow: hidden; background: var(--bg);
  font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; color: var(--text); }
.wf-canvas { width: 100%; height: 100%; display: block; touch-action: none; }
.wf-center { display: flex; flex-direction: column; align-items: center; justify-content: center; }

.wf-panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 14px; box-shadow: 0 8px 28px rgba(0,0,0,0.45); font-size: 13px; line-height: 1.5; }

.wf-btn { padding: 7px 11px; color: var(--text); background: #1c2436; border: 1px solid var(--border);
  border-radius: 8px; cursor: pointer; font: 13px system-ui, sans-serif; transition: background .12s, transform .06s; }
.wf-btn:hover { background: #263049; }
.wf-btn:active { transform: scale(0.97); }
.wf-btn-accent { background: var(--accent); color: #0b0e14; border-color: var(--accent); font-weight: 600; }
.wf-btn-accent:hover { background: var(--accent-strong); }

.wf-topbar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center;
  gap: 16px; padding: 10px 16px; background: linear-gradient(to bottom, rgba(11,14,20,0.9), rgba(11,14,20,0)); }
.wf-topbar-title { font-weight: 700; letter-spacing: 0.2px; }
.wf-topbar-mid { flex: 1; display: flex; gap: 14px; color: var(--text-dim); font-size: 13px; }
.wf-save { border-radius: 6px; padding: 2px 8px; background: rgba(255,255,255,0.06); }

.wf-toolbar { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  display: flex; gap: 6px; padding: 8px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,0.45); }
.wf-tool { white-space: nowrap; }
.wf-tool-active { background: var(--accent); color: #0b0e14; border-color: var(--accent); font-weight: 600; }

.wf-inspector { position: absolute; top: 64px; right: 16px; width: 260px; }
.wf-inspector-locked { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 8px 28px rgba(0,0,0,0.45); }
.wf-inspector-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.wf-pin { margin-left: auto; opacity: 0.8; font-size: 12px; }
.wf-inspector-line { color: var(--text-dim); font-size: 12px; margin-top: 3px; }
.wf-dim { color: var(--text-dim); }

.wf-state { font-size: 12px; padding: 3px 8px; border-radius: 6px; display: inline-block; margin-bottom: 8px;
  background: rgba(255,255,255,0.06); }
.wf-state-1 { color: var(--good); }
.wf-state-2 { color: var(--danger); }
.wf-state-3 { color: var(--warn); }

.wf-progress { height: 6px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; margin-bottom: 10px; }
.wf-progress-fill { height: 100%; background: var(--good); transition: width .15s linear; }

.wf-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim);
  margin-bottom: 10px; }
.wf-select { padding: 6px 8px; border-radius: 6px; background: #10141c; color: var(--text);
  border: 1px solid var(--border); font-size: 13px; }

.wf-overlay { position: absolute; inset: 0; background: rgba(5,7,12,0.55); display: flex;
  align-items: center; justify-content: center; z-index: 10; backdrop-filter: blur(2px); }

.wf-guide { width: min(560px, 92vw); max-height: 82vh; overflow-y: auto; }
.wf-guide-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
  position: sticky; top: -14px; background: var(--panel); padding-top: 2px; }
.wf-guide section { margin: 14px 0; }
.wf-guide h4 { margin: 0 0 6px; font-size: 14px; }
.wf-guide p, .wf-guide li { color: var(--text-dim); font-size: 13px; }
.wf-guide ul { margin: 0; padding-left: 18px; }
.wf-guide kbd { background: #1c2436; border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px;
  font-size: 11px; color: var(--text); }
.wf-entity-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.wf-entity-list li { display: flex; gap: 10px; align-items: flex-start; }
.wf-entity-list li > span { font-size: 18px; }

.wf-offline { width: min(360px, 90vw); }
.wf-offline-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wf-offline-list li { display: flex; justify-content: space-between; font-size: 13px; }

.wf-spinner { width: 40px; height: 40px; border-radius: 50%; border: 3px solid rgba(255,255,255,0.15);
  border-top-color: var(--accent); animation: wf-spin 0.8s linear infinite; }
@keyframes wf-spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) {
  .wf-inspector { left: 16px; right: 16px; width: auto; top: auto; bottom: 84px; }
  .wf-toolbar { max-width: calc(100vw - 20px); overflow-x: auto; }
  .wf-topbar-mid { display: none; }
}
`;
