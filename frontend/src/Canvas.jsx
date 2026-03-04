/**
 * Canvas.jsx — high-performance map renderer
 *
 * Layers (bottom → top):
 *  1. Minimap background (1024 × 1024 PNG/JPG)
 *  2. Heatmap overlay (computed client-side from visibleEvents → timeline-aware)
 *  3. Player trails (polylines per player)
 *  4. Event markers (Kill, Killed, Loot …)
 *  5. Start-position dots (per selected player)
 *
 * Zoom / pan is applied via CSS transform on a wrapper div,
 * using refs so it never triggers a React re-render.
 */

import React, {
  useRef, useEffect, useCallback, useMemo, useState,
} from 'react';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SZ = 1024; // canvas resolution

const TRAIL_EVENTS = new Set(['Position', 'BotPosition']);

const EVENT_STYLES = {
  Kill:          { color: '#ef4444', shape: 'circle',  r: 7 },
  BotKill:       { color: '#dc2626', shape: 'circle',  r: 7 },
  Killed:        { color: '#7c3aed', shape: 'cross',   r: 7 },
  BotKilled:     { color: '#f97316', shape: 'cross',   r: 7 },
  Loot:          { color: '#eab308', shape: 'diamond', r: 6 },
  KilledByStorm: { color: '#a855f7', shape: 'star',    r: 8 },
};

const MINIMAP_FILES = {
  AmbroseValley: 'AmbroseValley_Minimap.png',
  GrandRift:     'GrandRift_Minimap.png',
  Lockdown:      'Lockdown_Minimap.jpg',
};

// Heatmap colour gradient stops  [value, [r,g,b,a]]
const HEAT_STOPS = [
  [0.00, [0,   30,  255, 0  ]],
  [0.25, [0,   180, 255, 110]],
  [0.50, [60,  255, 60,  170]],
  [0.75, [255, 200, 0,   200]],
  [1.00, [255, 20,  0,   235]],
];

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function lerpHeat(v) {
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [t1, c1] = HEAT_STOPS[i];
    const [t0, c0] = HEAT_STOPS[i - 1];
    if (v <= t1) {
      const f = (v - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
        Math.round(c0[3] + f * (c1[3] - c0[3])),
      ];
    }
  }
  return HEAT_STOPS.at(-1)[1];
}

function drawCircle(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawCross(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
  ctx.stroke();
  ctx.restore();
}

function drawDiamond(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawStar(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  const n = 5, inner = r * 0.42;
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI / n) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : inner;
    const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawMarker(ctx, ev, style) {
  const { pixelX: x, pixelY: y } = ev;
  switch (style.shape) {
    case 'circle':  drawCircle(ctx, x, y, style.r, style.color); break;
    case 'cross':   drawCross(ctx, x, y, style.r, style.color); break;
    case 'diamond': drawDiamond(ctx, x, y, style.r, style.color); break;
    case 'star':    drawStar(ctx, x, y, style.r, style.color); break;
  }
}

// ---------------------------------------------------------------------------
// Client-side heatmap computation (timeline-aware)
// ---------------------------------------------------------------------------

const HEAT_EVENT_SETS = {
  kills:   new Set(['Kill', 'BotKill']),
  deaths:  new Set(['Killed', 'BotKilled', 'KilledByStorm']),
  traffic: new Set(['Position', 'BotPosition']),
};

function computeHeatmap(events, type, gridSize = 32) {
  const grid = new Float32Array(gridSize * gridSize);
  const targets = HEAT_EVENT_SETS[type] ?? HEAT_EVENT_SETS.traffic;

  for (const ev of events) {
    if (!targets.has(ev.event)) continue;
    const cx = Math.min(gridSize - 1, Math.floor((ev.pixelX / SZ) * gridSize));
    const cy = Math.min(gridSize - 1, Math.floor((ev.pixelY / SZ) * gridSize));
    grid[cy * gridSize + cx]++;
  }

  let max = 0;
  for (const v of grid) if (v > max) max = v;
  if (max > 0) {
    const logMax = Math.log1p(max);
    for (let i = 0; i < grid.length; i++)
      grid[i] = grid[i] > 0 ? Math.log1p(grid[i]) / logMax : 0;
  }
  return grid;
}

function buildHeatImageData(grid, gridSize) {
  const cellSize = SZ / gridSize;
  const img = new ImageData(SZ, SZ);
  const d = img.data;

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const v = grid[gy * gridSize + gx];
      if (v <= 0) continue;
      const [r, g, b, a] = lerpHeat(v);
      const x0 = Math.round(gx * cellSize), x1 = Math.round((gx + 1) * cellSize);
      const y0 = Math.round(gy * cellSize), y1 = Math.round((gy + 1) * cellSize);
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * SZ + px) * 4;
          d[i] = r; d[i+1] = g; d[i+2] = b; d[i+3] = a;
        }
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapCanvas({
  mapId,
  events,           // visible events (already time-filtered)
  startPositions,   // [{ userId, pixelX, pixelY, color }]
  selectedPlayers,
  colorMap,
  showTrails,
  showEvents,
  showHeatmap,
  heatmapType,
  noMatchSelected,
  resetViewKey,     // increment to trigger zoom/pan reset
}) {
  const [tooltip, setTooltip] = useState(null); // { text, x, y } in screen coords

  const canvasRef      = useRef(null);
  const imgRef         = useRef(null);   // loaded minimap HTMLImageElement
  const loadedMapRef   = useRef(null);   // which map the img is for
  const containerRef   = useRef(null);   // outer overflow-hidden div
  const wrapperRef     = useRef(null);   // transformed div around the canvas

  // Zoom/pan state stored in refs (no re-render needed for smooth interaction)
  const zoom    = useRef(1);
  const pan     = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragAnchor = useRef({ x: 0, y: 0, px: 0, py: 0 });

  // Zoom level for the "display" badge
  const [zoomDisplay, setZoomDisplay] = useState(1);

  // ── Apply CSS transform imperatively ──────────────────────────────────────
  const applyTransform = useCallback(() => {
    if (wrapperRef.current) {
      wrapperRef.current.style.transform =
        `translate(${pan.current.x}px,${pan.current.y}px) scale(${zoom.current})`;
    }
    setZoomDisplay(+(zoom.current.toFixed(1)));
  }, []);

  const resetView = useCallback(() => {
    zoom.current = 1;
    pan.current = { x: 0, y: 0 };
    applyTransform();
  }, [applyTransform]);

  // External reset trigger (from toolbar Reset button)
  useEffect(() => {
    if (resetViewKey > 0) resetView();
  }, [resetViewKey, resetView]);

  const zoomBy = useCallback((factor, cx = 0, cy = 0) => {
    const newZ = Math.max(0.3, Math.min(10, zoom.current * factor));
    const scale = newZ / zoom.current;
    pan.current = { x: cx + (pan.current.x - cx) * scale, y: cy + (pan.current.y - cy) * scale };
    zoom.current = newZ;
    applyTransform();
  }, [applyTransform]);

  // ── Wheel zoom ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = e => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top  - rect.height / 2;
      zoomBy(e.deltaY > 0 ? 0.85 : 1.18, cx, cy);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [zoomBy]);

  // ── Drag pan ──────────────────────────────────────────────────────────────
  const onMouseDown = useCallback(e => {
    if (e.button !== 0) return;
    dragging.current = true;
    dragAnchor.current = { x: e.clientX, y: e.clientY, px: pan.current.x, py: pan.current.y };
    e.currentTarget.style.cursor = 'grabbing';
  }, []);

  const onMouseMove = useCallback(e => {
    if (dragging.current) {
      pan.current = {
        x: dragAnchor.current.px + (e.clientX - dragAnchor.current.x),
        y: dragAnchor.current.py + (e.clientY - dragAnchor.current.y),
      };
      applyTransform();
      setTooltip(null);
      return;
    }

    // Tooltip: convert screen coords → canvas pixel coords (inverse of CSS transform)
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const W = rect.width;
    const H = rect.height;
    const canvasX = ((mx - W / 2 - pan.current.x) / zoom.current + W / 2) / W * SZ;
    const canvasY = ((my - H / 2 - pan.current.y) / zoom.current + H / 2) / H * SZ;

    const THRESHOLD = 14; // canvas pixels
    let closest = null, minDist = THRESHOLD;
    for (const pos of Object.values(playerLastPositionsRef.current)) {
      const d = Math.hypot(pos.pixelX - canvasX, pos.pixelY - canvasY);
      if (d < minDist) { minDist = d; closest = pos; }
    }
    if (closest) {
      const label = closest.isBot ? `Bot #${closest.userId}` : closest.userId;
      setTooltip({ text: label, x: e.clientX, y: e.clientY });
    } else {
      setTooltip(null);
    }
  }, [applyTransform]);

  const onMouseUp = useCallback(e => {
    dragging.current = false;
    if (e.currentTarget) e.currentTarget.style.cursor = 'grab';
  }, []);

  const onMouseLeaveContainer = useCallback(e => {
    onMouseUp(e);
    setTooltip(null);
  }, [onMouseUp]);

  // Increment to force a re-render (and thus a draw()) after image loads
  const [, setImgSeq] = useState(0);

  // ── Load minimap image ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapId) return;
    // Always reload when mapId changes — don't skip if same map was previously loaded
    imgRef.current = null;
    loadedMapRef.current = null;
    const filename = MINIMAP_FILES[mapId] ?? `${mapId}_Minimap.png`;
    const img = new Image();
    img.src = `${API_BASE}/minimaps/${filename}`;
    img.onload  = () => { imgRef.current = img; loadedMapRef.current = mapId; setImgSeq(n => n + 1); };
    img.onerror = () => { imgRef.current = null; loadedMapRef.current = mapId; setImgSeq(n => n + 1); };
  }, [mapId]);

  // ── Heatmap computation (timeline-aware, memoised by events + type) ───────
  const heatGrid = useMemo(() => {
    if (!showHeatmap || events.length === 0) return null;
    return computeHeatmap(events, heatmapType);
  }, [events, showHeatmap, heatmapType]);

  // ── Build heatmap ImageData (expensive, only when grid changes) ───────────
  const heatImgData = useMemo(() => {
    if (!heatGrid) return null;
    return buildHeatImageData(heatGrid, 32);
  }, [heatGrid]);

  // ── Per-player trails, segmented by matchId ───────────────────────────────
  // Structure: uid → Map<matchId, [events]>
  // Each (uid, matchId) pair gets its own polyline so a player's trail in
  // match A never connects to their trail in match B.
  const trails = useMemo(() => {
    const byPlayer = {}; // uid -> { matchId -> [ev] }
    for (const ev of events) {
      if (!TRAIL_EVENTS.has(ev.event)) continue;
      const mid = ev.matchId ?? 'default';
      if (!byPlayer[ev.userId]) byPlayer[ev.userId] = {};
      if (!byPlayer[ev.userId][mid]) byPlayer[ev.userId][mid] = [];
      byPlayer[ev.userId][mid].push(ev);
    }
    return byPlayer;
  }, [events]);

  // ── Player last positions (for hover tooltip) ─────────────────────────────
  // One entry per (userId, matchId) pair so tooltip works across all trail segments.
  const playerLastPositions = useMemo(() => {
    const positions = {};
    for (const [uid, matchSegs] of Object.entries(trails)) {
      for (const [matchId, pts] of Object.entries(matchSegs)) {
        if (pts.length > 0) {
          positions[`${uid}:${matchId}`] = pts.at(-1);
        }
      }
    }
    // Fall back to start positions for any (userId, matchId) not covered by trails
    for (const sp of (startPositions ?? [])) {
      const key = `${sp.userId}:${sp.matchId ?? 'default'}`;
      if (!positions[key]) positions[key] = sp;
    }
    return positions;
  }, [trails, startPositions]);

  // Store in a ref so the onMouseMove callback never goes stale
  const playerLastPositionsRef = useRef(playerLastPositions);
  useEffect(() => { playerLastPositionsRef.current = playerLastPositions; }, [playerLastPositions]);

  // ── Marker events (non-trail) ─────────────────────────────────────────────
  const markers = useMemo(
    () => events.filter(ev => EVENT_STYLES[ev.event]),
    [events],
  );

  // ── Draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, SZ, SZ);

    // 1. Minimap background
    if (imgRef.current) {
      ctx.drawImage(imgRef.current, 0, 0, SZ, SZ);
    } else {
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, SZ, SZ);
      ctx.fillStyle = '#374151';
      ctx.font = 'bold 22px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(mapId ?? 'Loading map…', SZ / 2, SZ / 2);
    }

    // "Select a match" overlay
    if (noMatchSelected) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, SZ, SZ);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = 'bold 28px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Select a match to begin', SZ / 2, SZ / 2);
      ctx.restore();
    }

    // 2. Heatmap overlay
    if (showHeatmap && heatImgData) {
      ctx.save();
      ctx.globalAlpha = 0.70;
      const tmp = new OffscreenCanvas(SZ, SZ);
      tmp.getContext('2d').putImageData(heatImgData, 0, 0);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }

    // 3. Player trails (segmented per match — no cross-match connections)
    if (showTrails) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap  = 'round';

      for (const [uid, matchSegments] of Object.entries(trails)) {
        if (!selectedPlayers.has(uid)) continue;
        const color = colorMap[uid] ?? '#888';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.72;

        // Draw all trail segments, then a position dot at the end of each
        const endPts = [];
        for (const pts of Object.values(matchSegments)) {
          if (pts.length < 2) continue;
          ctx.globalAlpha = 0.72;
          ctx.beginPath();
          ctx.moveTo(pts[0].pixelX, pts[0].pixelY);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].pixelX, pts[i].pixelY);
          ctx.stroke();
          endPts.push(pts.at(-1));
        }

        // Draw a position dot at the end of every match segment
        for (const pt of endPts) {
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(pt.pixelX, pt.pixelY, 4, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 4. Event markers
    if (showEvents) {
      ctx.save();
      for (const ev of markers) {
        const style = EVENT_STYLES[ev.event];
        if (style) drawMarker(ctx, ev, style);
      }
      ctx.restore();
    }

    // 5. Start positions
    if (startPositions?.length) {
      ctx.save();
      for (const sp of startPositions) {
        const { pixelX: x, pixelY: y, color } = sp;
        // Pulsing outer ring effect (static, drawn as two concentric circles)
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 1;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    mapId, noMatchSelected, showHeatmap, heatImgData,
    showTrails, trails, selectedPlayers, colorMap,
    showEvents, markers, startPositions,
  ]);

  // Trigger redraw whenever any input changes
  useEffect(() => {
    draw();
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
  <>
    <div
      ref={containerRef}
      className="relative overflow-hidden cursor-grab select-none"
      style={{ width: 'min(calc(100vh - 110px), calc(100vw - 18rem))', aspectRatio: '1/1' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeaveContainer}
    >
      {/* Transformed canvas wrapper */}
      <div
        ref={wrapperRef}
        style={{ transformOrigin: 'center center', width: '100%', height: '100%' }}
      >
        <canvas
          ref={canvasRef}
          width={SZ}
          height={SZ}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
      </div>

      {/* Zoom controls (top-right) */}
      <div className="absolute top-2 right-2 flex flex-col gap-1 z-10">
        <button
          className="w-7 h-7 rounded bg-black/60 border border-white/10 text-white text-sm font-bold hover:bg-black/80 transition flex items-center justify-center"
          onClick={() => zoomBy(1.4)}
          title="Zoom in"
        >+</button>
        <button
          className="w-7 h-7 rounded bg-black/60 border border-white/10 text-white text-xs hover:bg-black/80 transition flex items-center justify-center"
          onClick={resetView}
          title="Reset view"
        >⌂</button>
        <button
          className="w-7 h-7 rounded bg-black/60 border border-white/10 text-white text-sm font-bold hover:bg-black/80 transition flex items-center justify-center"
          onClick={() => zoomBy(0.7)}
          title="Zoom out"
        >−</button>
      </div>

      {/* Zoom badge (bottom-right) */}
      <div className="absolute bottom-2 right-2 text-[11px] font-mono bg-black/50 text-white/60 px-1.5 py-0.5 rounded pointer-events-none">
        {zoomDisplay}×
      </div>

      {/* Scroll hint (bottom-left, shown only at default zoom) */}
      {zoomDisplay === 1 && (
        <div className="absolute bottom-2 left-2 text-[11px] text-white/30 pointer-events-none">
          Scroll to zoom · Drag to pan
        </div>
      )}
    </div>

    {/* Player tooltip (fixed — renders over everything) */}
    {tooltip && (
      <div
        className="fixed z-50 bg-black/85 text-white text-xs px-2.5 py-1 rounded pointer-events-none font-mono shadow-lg border border-white/10 max-w-xs truncate"
        style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}
      >
        {tooltip.text}
      </div>
    )}
  </>
  );
}
