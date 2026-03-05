import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { fetchStatus, fetchMaps, fetchDates, fetchMatches, fetchMatch, fetchPlayerMatches } from './api';
import MapCanvas from './Canvas';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmtMs(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '0:00';
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const PLAYER_COLORS = [
  '#6366f1','#22d3ee','#4ade80','#facc15',
  '#f472b6','#fb923c','#a78bfa','#34d399',
  '#f87171','#38bdf8','#e879f9','#a3e635',
];

const HISTORY_KEY = 'lila-view-history';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; }
}
function saveHistory(items) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); } catch {}
}

// ---------------------------------------------------------------------------
// Small reusable components
// ---------------------------------------------------------------------------

function Select({ label, value, onChange, options, disabled, placeholder }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">{label}</label>
      <select
        className={clsx(
          'bg-surface border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500 transition',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
        value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
    </div>
  );
}

/** Searchable checkbox dropdown */
function CheckboxDropdown({ label, options, selected, onChange, placeholder, disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const fn = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const filtered = useMemo(
    () => options.filter(o => o.label.toLowerCase().includes(q.toLowerCase())),
    [options, q],
  );

  const toggle = val => {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val); else next.add(val);
    onChange(next);
  };

  const displayText = selected.size === 0
    ? placeholder
    : selected.size === 1
      ? (options.find(o => selected.has(o.value))?.label ?? '1 selected')
      : `${selected.size} of ${options.length} selected`;

  return (
    <div className="flex flex-col gap-1 relative" ref={ref}>
      <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">{label}</label>
      <button
        onClick={() => !disabled && setOpen(o => !o)}
        className={clsx(
          'bg-surface border border-border rounded px-2 py-1.5 text-sm text-left flex justify-between items-center focus:outline-none focus:border-indigo-500 transition',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span className={selected.size === 0 ? 'text-slate-500' : 'text-slate-200'}>{displayText}</span>
        <span className="text-slate-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && !disabled && (
        <div className="absolute top-full left-0 right-0 z-30 bg-surface border border-border rounded shadow-xl mt-1 flex flex-col">
          <input
            autoFocus
            value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search…"
            className="m-1.5 px-2 py-1 text-xs bg-panel border border-border rounded focus:outline-none focus:border-indigo-500"
          />
          <div className="max-h-44 overflow-y-auto">
            {filtered.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">No results</div>}
            {filtered.map(o => (
              <label key={o.value} className="flex items-center gap-2 px-3 py-1.5 hover:bg-panel cursor-pointer text-sm">
                <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} className="flex-none" />
                <span className="truncate">{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Btn({ label, active, onClick, small }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded font-semibold transition',
        small ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs',
        active ? 'bg-indigo-600 text-white' : 'bg-surface border border-border text-slate-400 hover:border-indigo-500',
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// History panel (fixed right overlay) with rename + delete per item
// ---------------------------------------------------------------------------

function HistoryPanel({ history, onRestore, onRename, onDelete, onClear, onClose }) {
  const [menuId, setMenuId]   = useState(null); // item id with open ⋮ menu
  const [editId, setEditId]   = useState(null); // item id being renamed
  const [editVal, setEditVal] = useState('');
  const menuRef = useRef(null);

  // Close ⋮ menu on outside click
  useEffect(() => {
    const fn = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuId(null); };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const commitRename = (id) => {
    if (editVal.trim()) onRename(id, editVal.trim());
    setEditId(null);
    setEditVal('');
  };

  return (
    <div className="fixed top-0 right-0 h-full w-72 z-40 flex flex-col bg-panel border-l border-border shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">History</span>
        <div className="flex gap-2 items-center">
          {history.length > 0 && (
            <button onClick={onClear} className="text-[10px] text-slate-500 hover:text-slate-300 transition">
              Clear all
            </button>
          )}
          <button onClick={onClose} className="text-slate-500 hover:text-white transition text-sm">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {history.length === 0 && (
          <div className="text-xs text-slate-600 p-4 text-center">No history yet.<br />Select matches to save views.</div>
        )}
        {history.map(item => (
          <div key={item.id} className="border-b border-border/50 group relative">
            {editId === item.id ? (
              /* Inline rename input */
              <div className="flex items-center gap-1 px-3 py-2">
                <input
                  autoFocus
                  value={editVal}
                  onChange={e => setEditVal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename(item.id);
                    if (e.key === 'Escape') { setEditId(null); setEditVal(''); }
                  }}
                  className="flex-1 text-xs bg-surface border border-indigo-500 rounded px-2 py-1 focus:outline-none text-slate-200"
                />
                <button onClick={() => commitRename(item.id)} className="text-indigo-400 hover:text-indigo-200 text-xs px-1">✓</button>
                <button onClick={() => { setEditId(null); setEditVal(''); }} className="text-slate-500 hover:text-slate-300 text-xs px-1">✕</button>
              </div>
            ) : (
              <button
                onClick={() => onRestore(item)}
                className="w-full text-left px-3 py-2 hover:bg-surface transition pr-8"
              >
                <div className="text-xs text-slate-300 font-medium truncate group-hover:text-white">{item.label}</div>
                <div className="text-[10px] text-slate-600 mt-0.5">
                  {new Date(item.savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {' · '}{item.state.selectedMatchIds.length} match{item.state.selectedMatchIds.length !== 1 ? 'es' : ''}
                  {item.state.currentTime > 0 && <span className="text-indigo-500/70"> · ⏱ {fmtMs(item.state.currentTime)}</span>}
                </div>
              </button>
            )}

            {/* 3-dot menu button */}
            {editId !== item.id && (
              <div ref={menuId === item.id ? menuRef : null} className="absolute right-2 top-2">
                <button
                  onClick={e => { e.stopPropagation(); setMenuId(menuId === item.id ? null : item.id); }}
                  className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-200 transition text-sm w-6 h-6 flex items-center justify-center rounded hover:bg-surface"
                >
                  ⋮
                </button>
                {menuId === item.id && (
                  <div className="absolute right-0 top-7 bg-surface border border-border rounded shadow-xl py-1 z-50 min-w-[130px]">
                    <button
                      className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-panel hover:text-white transition"
                      onClick={e => { e.stopPropagation(); setEditId(item.id); setEditVal(item.label); setMenuId(null); }}
                    >
                      ✏️ Rename
                    </button>
                    <button
                      className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-panel hover:text-red-300 transition"
                      onClick={e => { e.stopPropagation(); onDelete(item.id); setMenuId(null); }}
                    >
                      🗑 Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Player context menu
// ---------------------------------------------------------------------------

function PlayerMenu({ userId, isBot, x, y, onClose, onSelectAllMatches, isAllSelected }) {
  const ref = useRef(null);
  useEffect(() => {
    const fn = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-surface border border-border rounded shadow-xl py-1 min-w-[180px]"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 100) }}
    >
      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-border font-mono">
        {isBot ? `Bot #${userId}` : userId.slice(0, 20) + '…'}
      </div>
      <button
        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-panel hover:text-white transition flex items-center gap-2"
        onClick={onSelectAllMatches}
      >
        <span className={clsx(
          'w-3.5 h-3.5 border rounded-sm inline-flex items-center justify-center flex-none transition',
          isAllSelected ? 'border-indigo-400 bg-indigo-600/20' : 'border-slate-500',
        )}>
          {isAllSelected && <span className="text-indigo-400 text-[9px] leading-none">✓</span>}
        </span>
        All matches for player
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App() {
  // ── Server / meta ─────────────────────────────────────────────────────────
  const [serverReady, setServerReady] = useState(false);
  const [statusMsg, setStatusMsg]     = useState('Connecting to backend…');
  const [maps, setMaps]   = useState([]);
  const [dates, setDates] = useState([]);

  // ── Filters ───────────────────────────────────────────────────────────────
  const [selectedMap,       setSelectedMap]       = useState('');
  const [selectedDates,     setSelectedDates]     = useState(new Set());
  const [matchList,         setMatchList]         = useState([]);
  const [selectedMatchIds,  setSelectedMatchIds]  = useState(new Set());
  const [matchSearch,       setMatchSearch]       = useState('');
  const [matchSort,         setMatchSort]         = useState('date'); // 'date'|'players'|'bots'|'duration'
  const [showSortMenu,      setShowSortMenu]      = useState(false);
  const [playerSearch,      setPlayerSearch]      = useState('');
  const sortMenuRef = useRef(null);

  // Close sort / speed menus on outside click
  useEffect(() => {
    const fn = e => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) setShowSortMenu(false);
      const inSpeedControl =
        speedBtnContainerRef.current?.contains(e.target) ||
        speedPopupRef.current?.contains(e.target);
      if (!inSpeedControl) setShowSpeedMenu(false);
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  // ── Loaded match data ─────────────────────────────────────────────────────
  const [matchDataMap,    setMatchDataMap]   = useState(new Map());
  const [loadingMatches,  setLoadingMatches] = useState(new Set());
  const [resetViewKey,    setResetViewKey]   = useState(0); // increment to reset Canvas zoom/pan

  // ── Display ───────────────────────────────────────────────────────────────
  const [selectedPlayers, setSelectedPlayers] = useState(new Set());
  const [showTrails,  setShowTrails]  = useState(true);
  const [showEvents,  setShowEvents]  = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapType, setHeatmapType] = useState('traffic');
  const [soloEventType, setSoloEventType] = useState(null);
  const [isPlaying,    setIsPlaying]   = useState(false);
  const [playSpeed,    setPlaySpeed]   = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const speedBtnContainerRef = useRef(null); // wrapping div (for outside-click detection)
  const speedBtnRef          = useRef(null); // button element (for getBoundingClientRect)
  const speedPopupRef        = useRef(null); // portal popup (for outside-click detection)
  const pendingPlayerFilter  = useRef(null); // userId to restrict auto-select to after loading
  const [playerMatchCache, setPlayerMatchCache] = useState(new Map()); // userId → matchId[]

  // ── Playback refs (avoid stale closures in RAF) ───────────────────────────
  const currentTimeRef = useRef(0);
  const [displayTime, setDisplayTime] = useState(0); // display copy only
  const durationRef   = useRef(0);
  const playSpeedRef  = useRef(1);
  const rafRef        = useRef(null);
  const lastTsRef     = useRef(null);

  // Sync helper: updates both the ref and the display state
  const setCurrentTime = useCallback((v) => {
    const val = typeof v === 'function' ? v(currentTimeRef.current) : v;
    currentTimeRef.current = val;
    setDisplayTime(val);
  }, []);

  // ── Navigation history ────────────────────────────────────────────────────
  const [viewHistory, setViewHistory]   = useState(loadHistory);
  const [backStack,   setBackStack]     = useState([]);
  const [showHistory, setShowHistory]   = useState(false);
  const suppressHistorySave             = useRef(false); // set true when restoring to preserve renamed label

  // ── Player context menu ───────────────────────────────────────────────────
  const [playerMenu, setPlayerMenu] = useState(null);

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetchStatus();
        if (cancelled) return;
        if (res.ready) {
          setServerReady(true);
          setStatusMsg(`Ready · ${res.matchCount} matches`);
          const [m, d] = await Promise.all([fetchMaps(), fetchDates()]);
          if (!cancelled) { setMaps(m); setDates(d); }
        } else {
          setStatusMsg('Loading parquet data…');
          setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) { setStatusMsg('Backend unreachable — start on :3001'); setTimeout(poll, 4000); }
      }
    }
    poll();
    return () => { cancelled = true; };
  }, []);

  // ── Match list reload ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!serverReady) return;
    const datesToQuery = selectedDates.size > 0 ? [...selectedDates] : [undefined];
    Promise.all(datesToQuery.map(d => fetchMatches(selectedMap || undefined, d)))
      .then(results => {
        const merged = new Map();
        for (const list of results) for (const m of list) merged.set(m.matchId, m);
        setMatchList([...merged.values()]);
      })
      .catch(console.error);
  }, [selectedMap, selectedDates, serverReady]);

  // ── Duration: update ref synchronously inside useMemo ─────────────────────
  const duration = useMemo(() => {
    let max = 0;
    for (const m of matchDataMap.values()) if (m.durationMs > max) max = m.durationMs;
    durationRef.current = max; // sync update — no useEffect lag
    return max;
  }, [matchDataMap]);

  useEffect(() => { playSpeedRef.current = playSpeed; }, [playSpeed]);

  // ── Load / unload match data ───────────────────────────────────────────────
  useEffect(() => {
    const toLoad   = [...selectedMatchIds].filter(id => !matchDataMap.has(id));
    const toRemove = [...matchDataMap.keys()].filter(id => !selectedMatchIds.has(id));
    if (toLoad.length === 0 && toRemove.length === 0) return;

    if (toRemove.length) {
      setMatchDataMap(prev => { const n = new Map(prev); toRemove.forEach(id => n.delete(id)); return n; });
    }
    if (toLoad.length) {
      setLoadingMatches(prev => new Set([...prev, ...toLoad]));
      Promise.all(toLoad.map(id => fetchMatch(id).then(d => [id, d])))
        .then(entries => {
          setMatchDataMap(prev => {
            const n = new Map(prev);
            for (const [id, data] of entries) n.set(id, data);
            return n;
          });
          setLoadingMatches(prev => { const n = new Set(prev); toLoad.forEach(id => n.delete(id)); return n; });
        })
        .catch(console.error);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMatchIds]);

  // ── Auto-select all players when new matches load ─────────────────────────
  useEffect(() => {
    // When "select all matches for player" is pending, skip auto-adding everyone
    if (pendingPlayerFilter.current !== null) return;
    setSelectedPlayers(prev => {
      const n = new Set(prev);
      for (const m of matchDataMap.values()) for (const p of m.players) n.add(p.userId);
      return n;
    });
  }, [matchDataMap]);

  // Apply player restriction once all pending match IDs are loaded
  useEffect(() => {
    if (pendingPlayerFilter.current === null) return;
    const allLoaded = selectedMatchIds.size > 0 &&
      [...selectedMatchIds].every(id => matchDataMap.has(id));
    if (allLoaded) {
      const uid = pendingPlayerFilter.current;
      pendingPlayerFilter.current = null;
      setSelectedPlayers(new Set([uid]));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchDataMap, selectedMatchIds]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const allPlayers = useMemo(() => {
    const seen = new Map();
    for (const m of matchDataMap.values()) for (const p of m.players) if (!seen.has(p.userId)) seen.set(p.userId, p);
    return [...seen.values()];
  }, [matchDataMap]);

  const colorMap = useMemo(() => {
    const map = {}; let idx = 0;
    for (const p of allPlayers) map[p.userId] = p.isBot ? '#f97316' : PLAYER_COLORS[idx++ % PLAYER_COLORS.length];
    return map;
  }, [allPlayers]);

  // Merge events from all selected matches, annotate each with matchId
  const allEvents = useMemo(() => {
    const evs = [];
    for (const [matchId, m] of matchDataMap.entries()) {
      const playerLookup = Object.fromEntries(m.players.map(p => [p.userId, p]));
      for (const ev of m.events) {
        evs.push({ ...ev, matchId, isBot: playerLookup[ev.userId]?.isBot ?? false });
      }
    }
    evs.sort((a, b) => a.ts - b.ts);
    return evs;
  }, [matchDataMap]);

  const visibleEvents = useMemo(
    () => allEvents.filter(ev => selectedPlayers.has(ev.userId) && ev.ts <= currentTimeRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allEvents, selectedPlayers, displayTime], // displayTime triggers re-memo on playback
  );

  const canvasEvents = useMemo(
    () => soloEventType ? visibleEvents.filter(ev => ev.event === soloEventType) : visibleEvents,
    [visibleEvents, soloEventType],
  );

  const startPositions = useMemo(() => {
    const starts = {};
    for (const ev of allEvents) {
      const key = `${ev.userId}:${ev.matchId ?? 'default'}`;
      if (!starts[key] && selectedPlayers.has(ev.userId)) {
        starts[key] = { ...ev, color: colorMap[ev.userId] ?? '#888' };
      }
    }
    return Object.values(starts);
  }, [allEvents, selectedPlayers, colorMap]);

  const activeMapId = useMemo(() => {
    for (const m of matchDataMap.values()) if (m.mapId) return m.mapId;
    return selectedMap || null;
  }, [matchDataMap, selectedMap]);

  const hasMatchData = matchDataMap.size > 0;

  // Stable sequential match numbers: sort all matches by date then matchId (deterministic across restarts)
  const matchNumberMap = useMemo(() => {
    const sorted = [...matchList].sort((a, b) =>
      a.date !== b.date ? a.date.localeCompare(b.date) : a.matchId.localeCompare(b.matchId)
    );
    const map = new Map();
    sorted.forEach((m, i) => map.set(m.matchId, i + 1));
    return map;
  }, [matchList]);

  // Map locked to the first selected match — prevents mixing matches from different maps
  const selectedMapId = useMemo(() => {
    if (selectedMatchIds.size === 0) return null;
    const firstId = [...selectedMatchIds][0];
    return matchList.find(m => m.matchId === firstId)?.mapId ?? null;
  }, [selectedMatchIds, matchList]);

  // ── Filtered + sorted match list (selected always on top) ─────────────────
  const filteredMatches = useMemo(() => {
    let list = matchList;
    // Once a match is selected, only show matches on the same map
    if (selectedMapId) list = list.filter(m => m.mapId === selectedMapId);
    if (matchSearch) {
      const q = matchSearch.toLowerCase();
      list = list.filter(m => {
        const num = matchNumberMap.get(m.matchId);
        return (
          `match ${num}`.includes(q) ||
          String(num).includes(q) ||
          m.matchId.toLowerCase().includes(q) ||
          m.mapId.toLowerCase().includes(q) ||
          m.date.toLowerCase().replace(/_/g, ' ').includes(q)
        );
      },
      );
    }
    return [...list].sort((a, b) => {
      // Selected items always float to top
      const aS = selectedMatchIds.has(a.matchId);
      const bS = selectedMatchIds.has(b.matchId);
      if (aS !== bS) return aS ? -1 : 1;
      // Then sort by chosen criteria
      switch (matchSort) {
        case 'players':  return b.playerCount - a.playerCount;
        case 'bots':     return b.botCount - a.botCount;
        case 'duration': return b.durationMs - a.durationMs;
        default:         return (matchNumberMap.get(a.matchId) ?? 0) - (matchNumberMap.get(b.matchId) ?? 0);
      }
    });
  }, [matchList, matchSearch, matchSort, selectedMatchIds, selectedMapId, matchNumberMap]);

  // ── Filtered player list ───────────────────────────────────────────────────
  const filteredPlayers = useMemo(() => {
    if (!playerSearch) return allPlayers;
    const q = playerSearch.toLowerCase();
    return allPlayers.filter(p => p.userId.toLowerCase().includes(q));
  }, [allPlayers, playerSearch]);

  const humans = useMemo(() => allPlayers.filter(p => !p.isBot), [allPlayers]);
  const bots   = useMemo(() => allPlayers.filter(p =>  p.isBot), [allPlayers]);

  // ── RAF-based playback (stable tick — all values via refs, no stale closures)
  const tick = useCallback((ts) => {
    if (lastTsRef.current != null) {
      const delta = (ts - lastTsRef.current) * playSpeedRef.current;
      const dur = durationRef.current;
      // Only cap to duration if we actually have one (avoid capping at 0)
      const next = dur > 0
        ? Math.min(currentTimeRef.current + delta, dur)
        : currentTimeRef.current + delta;
      currentTimeRef.current = next;
      setDisplayTime(next);
      if (dur > 0 && next >= dur) {
        setIsPlaying(false);
        return;
      }
    }
    lastTsRef.current = ts;
    rafRef.current = requestAnimationFrame(tick);
  }, []); // empty deps — intentional

  useEffect(() => {
    if (isPlaying && durationRef.current > 0) {
      lastTsRef.current = null;
      rafRef.current = requestAnimationFrame(tick);
    } else {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    }
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [isPlaying, tick]);

  // ── Spacebar to play / pause ───────────────────────────────────────────────
  useEffect(() => {
    const fn = e => {
      if (e.code !== 'Space') return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      if (durationRef.current <= 0) return; // no match loaded
      if (currentTimeRef.current >= durationRef.current) setCurrentTime(0);
      setIsPlaying(v => !v);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [setCurrentTime]); // setCurrentTime is stable

  // ── History helpers ───────────────────────────────────────────────────────
  const captureState = useCallback(() => ({
    selectedMap,
    selectedDates: [...selectedDates],
    selectedMatchIds: [...selectedMatchIds],
    selectedPlayers: [...selectedPlayers],
    showTrails, showEvents, showHeatmap, heatmapType,
    currentTime: currentTimeRef.current,
  }), [selectedMap, selectedDates, selectedMatchIds, selectedPlayers, showTrails, showEvents, showHeatmap, heatmapType]);

  // Save to history when matches are selected (suppressed during restore to preserve renamed labels)
  useEffect(() => {
    if (selectedMatchIds.size === 0) return;
    if (suppressHistorySave.current) { suppressHistorySave.current = false; return; }
    const mapLabel  = selectedMap || 'All maps';
    const dateLabel = selectedDates.size > 0
      ? [...selectedDates].map(d => d.replace('February_', 'Feb ')).join(', ')
      : 'All dates';
    const label = `${mapLabel} · ${dateLabel} · ${selectedMatchIds.size} match${selectedMatchIds.size !== 1 ? 'es' : ''}`;
    const item  = { id: Date.now(), label, savedAt: Date.now(), state: captureState() };
    setViewHistory(prev => {
      const deduped = prev.filter(h =>
        JSON.stringify([...h.state.selectedMatchIds].sort()) !==
        JSON.stringify([...item.state.selectedMatchIds].sort()),
      );
      const next = [item, ...deduped];
      saveHistory(next);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMatchIds]);

  // Flush latest view state (time, players, toggles) into the matching history entry
  // before navigating away, so "restore" always shows where you left off.
  const flushCurrentHistory = useCallback(() => {
    if (selectedMatchIds.size === 0) return;
    const current = captureState();
    const sortedCurrent = JSON.stringify([...selectedMatchIds].sort());
    setViewHistory(prev => {
      const idx = prev.findIndex(h =>
        JSON.stringify([...h.state.selectedMatchIds].sort()) === sortedCurrent,
      );
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], state: { ...next[idx].state, ...current } };
      saveHistory(next);
      return next;
    });
  }, [captureState, selectedMatchIds]);

  const pushBackStack = useCallback(() => {
    if (!hasMatchData) return;
    flushCurrentHistory();
    setBackStack(prev => [captureState(), ...prev].slice(0, 20));
  }, [captureState, flushCurrentHistory, hasMatchData]);

  const restoreState = useCallback((state) => {
    setSelectedMap(state.selectedMap ?? '');
    setSelectedDates(new Set(state.selectedDates ?? []));
    setSelectedMatchIds(new Set(state.selectedMatchIds ?? []));
    setSelectedPlayers(new Set(state.selectedPlayers ?? []));
    setShowTrails(state.showTrails ?? true);
    setShowEvents(state.showEvents ?? true);
    setShowHeatmap(state.showHeatmap ?? false);
    setHeatmapType(state.heatmapType ?? 'traffic');
    setCurrentTime(state.currentTime ?? 0);
    setIsPlaying(false);
  }, [setCurrentTime]);

  const goBack = useCallback(() => {
    const [prev, ...rest] = backStack;
    if (!prev) return;
    flushCurrentHistory();
    setBackStack(rest);
    restoreState(prev);
  }, [backStack, flushCurrentHistory, restoreState]);

  // History rename / delete
  const handleRename = useCallback((id, newLabel) => {
    setViewHistory(prev => {
      const next = prev.map(h => h.id === id ? { ...h, label: newLabel } : h);
      saveHistory(next);
      return next;
    });
  }, []);

  const handleDelete = useCallback((id) => {
    setViewHistory(prev => {
      const next = prev.filter(h => h.id !== id);
      saveHistory(next);
      return next;
    });
  }, []);

  // ── Player context menu ───────────────────────────────────────────────────
  const selectAllMatchesForPlayer = useCallback(async (userId) => {
    setPlayerMenu(null);
    try {
      const matches = await fetchPlayerMatches(userId);
      if (matches.length === 0) return;
      // Restrict to current map if one is selected
      const filtered = selectedMap ? matches.filter(m => m.mapId === selectedMap) : matches;
      if (filtered.length === 0) return;
      const allIds = filtered.map(m => m.matchId);
      // Persist for tick state
      setPlayerMatchCache(prev => new Map(prev).set(userId, allIds));
      const alreadyAllSelected = allIds.every(id => selectedMatchIds.has(id));
      pushBackStack();
      if (alreadyAllSelected) {
        // Deselect all this player's matches
        setSelectedMatchIds(prev => {
          const n = new Set(prev);
          allIds.forEach(id => n.delete(id));
          return n;
        });
      } else {
        // Select all this player's matches — restrict visible players to just this one
        pendingPlayerFilter.current = userId;
        setSelectedMatchIds(new Set(allIds));
      }
    } catch (err) { console.error(err); }
  }, [pushBackStack, selectedMatchIds, selectedMap]);

  const togglePlayer = useCallback(uid => {
    setSelectedPlayers(prev => { const n = new Set(prev); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  }, []);

  const toggleMatch = useCallback(id => {
    pushBackStack();
    setSelectedMatchIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    setCurrentTime(0);
    setIsPlaying(false);
  }, [pushBackStack, setCurrentTime]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen overflow-hidden bg-panel text-slate-200 text-sm" onClick={() => setPlayerMenu(null)}>

      {/* ── LEFT SIDEBAR ──────────────────────────────────────────── */}
      <aside className="w-72 min-w-[18rem] flex flex-col gap-3 p-3 border-r border-border overflow-y-auto">

        <div className={clsx('text-xs px-2 py-1 rounded font-mono', serverReady ? 'bg-green-900/40 text-green-400' : 'bg-yellow-900/40 text-yellow-400')}>
          {statusMsg}
        </div>

        {/* Map */}
        <Select
          label="Map" value={selectedMap}
          onChange={v => {
            pushBackStack();
            setSelectedMap(v);
            setSelectedDates(new Set());
            setSelectedMatchIds(new Set());
            setMatchDataMap(new Map());
          }}
          placeholder="All maps" options={maps.map(m => ({ value: m, label: m }))}
          disabled={!serverReady}
        />

        {/* Dates — multi-select */}
        <CheckboxDropdown
          label="Dates" options={dates.map(d => ({ value: d, label: d.replace('_', ' ') }))}
          selected={selectedDates}
          onChange={v => { pushBackStack(); setSelectedDates(v); }}
          placeholder="All dates" disabled={!serverReady}
        />

        {/* ── Match list ───────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs text-slate-400 uppercase tracking-wide font-medium flex-none">
              Matches ({filteredMatches.length}/{matchList.length})
            </span>
            <div className="flex items-center gap-1.5">
              {selectedMatchIds.size > 0 && (
                <button
                  onClick={() => { pushBackStack(); setSelectedMatchIds(new Set()); setMatchDataMap(new Map()); }}
                  className="text-xs text-slate-500 hover:text-slate-300 transition"
                >
                  Clear
                </button>
              )}
              {/* Sort icon dropdown */}
              <div className="relative" ref={sortMenuRef}>
                <button
                  onClick={() => setShowSortMenu(v => !v)}
                  title="Sort matches"
                  className={clsx(
                    'text-xs px-1.5 py-0.5 rounded border transition',
                    showSortMenu ? 'border-indigo-500 text-indigo-300' : 'border-border text-slate-500 hover:border-indigo-400 hover:text-slate-300',
                  )}
                >
                  ⇅
                </button>
                {showSortMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded shadow-xl py-1 z-30 min-w-[130px]">
                    {[
                      ['date',     'Date'],
                      ['players',  'Players'],
                      ['bots',     'Bots'],
                      ['duration', 'Duration'],
                    ].map(([val, lbl]) => (
                      <button
                        key={val}
                        onClick={() => { setMatchSort(val); setShowSortMenu(false); }}
                        className={clsx(
                          'w-full text-left px-3 py-1.5 text-xs transition',
                          matchSort === val
                            ? 'text-indigo-300 bg-panel'
                            : 'text-slate-300 hover:bg-panel hover:text-white',
                        )}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Match search */}
          <input
            value={matchSearch} onChange={e => setMatchSearch(e.target.value)}
            placeholder="Search matches…"
            className="px-2 py-1 text-xs bg-surface border border-border rounded focus:outline-none focus:border-indigo-500"
          />

          {/* Match rows */}
          <div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto pr-1">
            {filteredMatches.length === 0 && <div className="text-xs text-slate-600 px-1 py-2">No matches found</div>}
            {filteredMatches.map(m => {
              const checked = selectedMatchIds.has(m.matchId);
              const loading = loadingMatches.has(m.matchId);
              return (
                <label key={m.matchId} className={clsx(
                  'flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition hover:bg-surface',
                  checked && 'bg-surface/60 ring-1 ring-indigo-600/40',
                )}>
                  <input type="checkbox" checked={checked} onChange={() => toggleMatch(m.matchId)} className="flex-none mt-0.5" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="font-mono text-xs truncate text-slate-300">Match {matchNumberMap.get(m.matchId)} · {m.matchId.slice(0, 6)}</span>
                    <span className="text-[11px] text-slate-500">
                      ({m.playerCount}P · {m.botCount}B) · {fmtMs(m.durationMs)}
                    </span>
                    <span className="text-[10px] text-slate-600">{m.date?.replace('_', ' ')} · {m.mapId}</span>
                  </div>
                  {loading && <span className="text-[10px] text-indigo-400 animate-pulse flex-none">…</span>}
                </label>
              );
            })}
          </div>
        </div>

        {/* ── Player list ───────────────────────────────────────────── */}
        {allPlayers.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 uppercase tracking-wide font-medium">
                Players ({humans.length}H · {bots.length}B)
              </span>
              <div className="flex gap-1">
                {[
                  { label: 'All',   fn: () => setSelectedPlayers(new Set(allPlayers.map(p => p.userId))) },
                  { label: 'Human', fn: () => setSelectedPlayers(new Set(humans.map(p => p.userId))) },
                  { label: 'None',  fn: () => setSelectedPlayers(new Set()) },
                ].map(({ label, fn }) => (
                  <Btn key={label} label={label} small onClick={fn} />
                ))}
              </div>
            </div>

            <input
              value={playerSearch} onChange={e => setPlayerSearch(e.target.value)}
              placeholder="Search players…"
              className="px-2 py-1 text-xs bg-surface border border-border rounded focus:outline-none focus:border-indigo-500"
            />

            <div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto pr-1">
              {filteredPlayers.map(p => {
                const col     = colorMap[p.userId] ?? '#888';
                const checked = selectedPlayers.has(p.userId);
                const label   = p.isBot ? `Bot #${p.userId}` : p.userId.slice(0, 8) + '…';
                return (
                  <div
                    key={p.userId}
                    className={clsx('flex items-center gap-2 px-2 py-1 rounded transition hover:bg-surface group', checked ? 'opacity-100' : 'opacity-40')}
                  >
                    <input type="checkbox" checked={checked} onChange={() => togglePlayer(p.userId)} className="flex-none" />
                    <span className="w-2.5 h-2.5 rounded-full flex-none" style={{ background: col }} />
                    <span title={p.userId} className="truncate text-xs font-mono flex-1 cursor-default">{label}</span>
                    {p.isBot && <span className="text-[10px] text-orange-400 font-semibold flex-none">BOT</span>}
                    <button
                      onClick={e => { e.stopPropagation(); setPlayerMenu({ userId: p.userId, isBot: p.isBot, x: e.clientX, y: e.clientY }); }}
                      className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-200 transition text-[11px] px-1 flex-none"
                      title="More options"
                    >⋮</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wide mb-1">Legend <span className="normal-case font-normal text-slate-600">(click to filter)</span></p>
          {[
            { color: '#ef4444', sym: '●', label: 'Kill (player)', eventType: 'Kill' },
            { color: '#dc2626', sym: '●', label: 'BotKill',       eventType: 'BotKill' },
            { color: '#7c3aed', sym: '✕', label: 'Killed',        eventType: 'Killed' },
            { color: '#f97316', sym: '✕', label: 'BotKilled',     eventType: 'BotKilled' },
            { color: '#eab308', sym: '♦', label: 'Loot',          eventType: 'Loot' },
            { color: '#a855f7', sym: '★', label: 'KilledByStorm', eventType: 'KilledByStorm' },
            { color: '#ffffff', sym: '○', label: 'Start position', eventType: null },
          ].map(({ color, sym, label, eventType }) => {
            const active = soloEventType === eventType && eventType !== null;
            const dimmed = soloEventType !== null && !active;
            return (
              <button
                key={label}
                onClick={() => eventType && setSoloEventType(active ? null : eventType)}
                className={clsx(
                  'flex items-center gap-2 text-xs px-1 py-0.5 rounded transition text-left',
                  eventType ? 'cursor-pointer hover:bg-surface' : 'cursor-default',
                  active && 'bg-surface ring-1 ring-indigo-500/50',
                  dimmed && 'opacity-30',
                )}
              >
                <span style={{ color }} className="w-4 text-center font-bold flex-none">{sym}</span>
                <span className="text-slate-300">{label}</span>
                {active && <span className="ml-auto text-indigo-400 text-[10px]">✓</span>}
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── MAIN ──────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap shrink-0">
          {/* Back */}
          <button
            disabled={backStack.length === 0}
            onClick={goBack}
            className={clsx(
              'px-2 py-1.5 rounded text-xs border transition',
              backStack.length > 0
                ? 'border-border text-slate-300 hover:border-indigo-500 hover:text-white'
                : 'border-border/30 text-slate-600 cursor-not-allowed',
            )}
          >
            ← Back
          </button>

          {/* Mode toggles */}
          <div className="flex gap-1">
            <Btn label="Trails"  active={showTrails}  onClick={() => setShowTrails(v => !v)} />
            <Btn label="Events"  active={showEvents}  onClick={() => setShowEvents(v => !v)} />
            <Btn label="Heatmap" active={showHeatmap} onClick={() => setShowHeatmap(v => !v)} />
          </div>

          {showHeatmap && (
            <div className="flex gap-1">
              {['traffic', 'kills', 'deaths'].map(t => (
                <Btn key={t} label={t[0].toUpperCase() + t.slice(1)} active={heatmapType === t} onClick={() => setHeatmapType(t)} />
              ))}
            </div>
          )}

          {/* Reset button */}
          <button
            onClick={() => {
              setShowTrails(true);
              setShowEvents(true);
              setShowHeatmap(false);
              setHeatmapType('traffic');
              setSoloEventType(null);
              setPlaySpeed(1);
              playSpeedRef.current = 1;
              setCurrentTime(0);
              setIsPlaying(false);
              setResetViewKey(k => k + 1);
            }}
            className="px-2 py-1.5 rounded text-xs border border-border text-slate-400 hover:border-indigo-500 hover:text-white transition"
            title="Reset zoom, speed and display options to defaults"
          >
            ↺ Reset
          </button>

          {/* History button — always visible, pushed to right */}
          <button
            onClick={() => setShowHistory(v => !v)}
            className={clsx(
              'ml-auto px-3 py-1.5 rounded text-xs border font-semibold transition flex items-center gap-1.5',
              showHistory
                ? 'border-indigo-500 bg-indigo-600 text-white'
                : 'border-border text-slate-400 hover:border-indigo-500 hover:text-slate-200',
            )}
          >
            History
            {viewHistory.length > 0 && (
              <span className={clsx(
                'text-[10px] px-1 rounded-full font-mono',
                showHistory ? 'bg-indigo-400/40 text-indigo-100' : 'bg-slate-700 text-slate-400',
              )}>
                {viewHistory.length}
              </span>
            )}
          </button>
        </div>

        {/* Canvas */}
        <div className="flex-1 flex items-center justify-center overflow-hidden bg-[#0d1117] relative">
          {activeMapId ? (
            <MapCanvas
              mapId={activeMapId}
              events={canvasEvents}
              startPositions={startPositions}
              selectedPlayers={selectedPlayers}
              colorMap={colorMap}
              showTrails={showTrails}
              showEvents={showEvents}
              showHeatmap={showHeatmap}
              heatmapType={heatmapType}
              noMatchSelected={!hasMatchData}
              resetViewKey={resetViewKey}
            />
          ) : (
            <div className="text-slate-600 text-sm text-center">
              <div className="text-2xl mb-2">🗺</div>
              <div>{serverReady ? 'Select a map to begin' : 'Waiting for backend…'}</div>
            </div>
          )}
        </div>

        {/* Timeline */}
        {hasMatchData && (
          <div className="flex items-center gap-2 px-3 py-3 border-t border-border shrink-0">
            <button
              className="w-8 h-8 flex items-center justify-center rounded bg-indigo-600 hover:bg-indigo-500 transition text-white font-bold flex-none"
              onClick={() => {
                if (currentTimeRef.current >= durationRef.current) setCurrentTime(0);
                setIsPlaying(v => !v);
              }}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            {/* Current time */}
            <span className="text-xs font-mono text-slate-200 w-12 text-right flex-none tabular-nums">
              {fmtMs(displayTime)}
            </span>

            {/* Scrubber */}
            <input
              type="range"
              min={0}
              max={duration || 1}
              value={displayTime}
              onChange={e => {
                setIsPlaying(false);
                setCurrentTime(Number(e.target.value));
              }}
              className="flex-1"
              style={{
                background: `linear-gradient(to right,#6366f1 ${duration ? (displayTime / duration) * 100 : 0}%,#2e3550 0%)`,
              }}
            />

            {/* Total duration */}
            <span className="text-xs font-mono text-slate-500 w-12 flex-none tabular-nums">
              {fmtMs(duration)}
            </span>

            {/* Speed selector — refs on button itself, no wrapper needed */}
            <button
              ref={el => { speedBtnRef.current = el; speedBtnContainerRef.current = el; }}
              onClick={() => setShowSpeedMenu(v => !v)}
              className={clsx(
                'flex-none text-xs font-mono rounded px-2 py-1 border transition min-w-[3rem] text-center',
                showSpeedMenu
                  ? 'border-indigo-500 bg-indigo-600/20 text-indigo-300'
                  : 'border-border bg-surface text-slate-300 hover:border-indigo-400',
              )}
              title="Playback speed"
            >
              {playSpeed}×
            </button>
          </div>
        )}
      </main>

      {/* ── HISTORY PANEL (fixed right overlay) ───────────────────── */}
      {showHistory && (
        <HistoryPanel
          history={viewHistory}
          onRestore={item => {
            // Flush latest state into the current history entry before leaving
            flushCurrentHistory();
            // Suppress auto-save so the renamed label is not overwritten
            suppressHistorySave.current = true;
            // Move item to top of history (preserving its label)
            setViewHistory(prev => {
              const next = [item, ...prev.filter(h => h.id !== item.id)];
              saveHistory(next);
              return next;
            });
            pushBackStack();
            restoreState(item.state);
            // Panel stays open — user closes it manually
          }}
          onRename={handleRename}
          onDelete={handleDelete}
          onClear={() => { setViewHistory([]); saveHistory([]); }}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* ── PLAYER CONTEXT MENU ───────────────────────────────────── */}
      {playerMenu && (
        <PlayerMenu
          userId={playerMenu.userId}
          isBot={playerMenu.isBot}
          x={playerMenu.x}
          y={playerMenu.y}
          onClose={() => setPlayerMenu(null)}
          onSelectAllMatches={() => selectAllMatchesForPlayer(playerMenu.userId)}
          isAllSelected={
            playerMatchCache.has(playerMenu.userId) &&
            playerMatchCache.get(playerMenu.userId).every(id => selectedMatchIds.has(id))
          }
        />
      )}

      {/* ── SPEED POPUP PORTAL — renders at document.body, escapes all overflow/stacking ── */}
      {showSpeedMenu && createPortal(
        (() => {
          const r = speedBtnRef.current?.getBoundingClientRect();
          if (!r) return null;
          return (
            <div
              ref={speedPopupRef}
              className="bg-surface border border-border rounded shadow-xl py-1 min-w-[5rem]"
              style={{ position: 'fixed', right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 6, zIndex: 9999 }}
            >
              {[0.5, 1, 2, 4, 8].map(s => (
                <button
                  key={s}
                  onClick={() => { setPlaySpeed(s); playSpeedRef.current = s; setShowSpeedMenu(false); }}
                  className={clsx(
                    'w-full text-right px-3 py-1.5 text-xs font-mono transition',
                    playSpeed === s
                      ? 'text-indigo-300 bg-indigo-600/20'
                      : 'text-slate-300 hover:bg-panel hover:text-white',
                  )}
                >
                  {s}×
                </button>
              ))}
            </div>
          );
        })(),
        document.body,
      )}
    </div>
  );
}
