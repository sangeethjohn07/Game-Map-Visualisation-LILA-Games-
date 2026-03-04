/**
 * server.js
 * Express backend for the Player Journey Visualization Tool.
 * Loads all parquet data once at startup, then serves fast cached responses.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { buildCache, computeHeatmap } = require('./dataProcessor');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve minimap images
app.use(
  '/minimaps',
  express.static(path.join(__dirname, '..', 'player_data', 'minimaps'))
);

// ---------------------------------------------------------------------------
// Cache bootstrap — load once on startup
// ---------------------------------------------------------------------------

let cache = null;
let cacheError = null;

(async () => {
  try {
    cache = await buildCache();
    console.log('[server] Cache ready. API accepting requests.');
  } catch (err) {
    cacheError = err;
    console.error('[server] Fatal: cache build failed:', err);
  }
})();

// Middleware: block requests until cache is ready
function requireCache(req, res, next) {
  if (cacheError) return res.status(500).json({ error: 'Data load failed', detail: cacheError.message });
  if (!cache) return res.status(503).json({ error: 'Data still loading — please retry in a moment' });
  next();
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

/** Health / status */
app.get('/api/status', (req, res) => {
  res.json({
    ready: cache !== null,
    error: cacheError ? cacheError.message : null,
    matchCount: cache?.matches?.size ?? 0,
    mapCount: cache?.maps?.size ?? 0,
  });
});

/** GET /api/maps → string[] */
app.get('/api/maps', requireCache, (req, res) => {
  res.json([...cache.maps].sort());
});

/** GET /api/dates → string[] */
app.get('/api/dates', requireCache, (req, res) => {
  res.json([...cache.dateMatches.keys()].sort());
});

/**
 * GET /api/matches?map=AmbroseValley&date=February_10
 * → [{matchId, mapId, date, playerCount, botCount, durationMs}]
 */
app.get('/api/matches', requireCache, (req, res) => {
  const { map, date } = req.query;

  let ids = [...cache.matches.keys()];

  if (map) {
    const allowed = cache.mapMatches.get(map) ?? new Set();
    ids = ids.filter(id => allowed.has(id));
  }
  if (date) {
    const allowed = cache.dateMatches.get(date) ?? new Set();
    ids = ids.filter(id => allowed.has(id));
  }

  const result = ids.map(id => {
    const m = cache.matches.get(id);
    return {
      matchId: m.matchId,
      mapId: m.mapId,
      date: m.date,
      playerCount: m.playerCount,
      botCount: m.botCount,
      durationMs: m.durationMs,
    };
  });

  res.json(result);
});

/**
 * GET /api/match/:matchId
 * → { matchId, mapId, date, durationMs, players, events }
 *
 * events are pre-sorted by ts (relative to match start).
 * Each event: { userId, isBot, ts, event, pixelX, pixelY }
 */
app.get('/api/match/:matchId', requireCache, (req, res) => {
  const match = cache.matches.get(req.params.matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  res.json({
    matchId: match.matchId,
    mapId: match.mapId,
    date: match.date,
    durationMs: match.durationMs,
    players: match.players,
    events: match.events,
  });
});

/**
 * GET /api/heatmap/:matchId?type=kills|deaths|traffic
 * → { type, gridSize, data: base64(Float32Array) }
 */
app.get('/api/heatmap/:matchId', requireCache, (req, res) => {
  const match = cache.matches.get(req.params.matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const type = ['kills', 'deaths', 'traffic'].includes(req.query.type)
    ? req.query.type
    : 'traffic';

  const grid = computeHeatmap(match.events, type);
  const buf = Buffer.from(grid.buffer);

  res.json({ type, gridSize: 32, data: buf.toString('base64') });
});

/**
 * GET /api/player/:userId/matches
 * → [{matchId, mapId, date, playerCount, botCount, durationMs}]
 * Returns all matches a specific player has appeared in.
 */
app.get('/api/player/:userId/matches', requireCache, (req, res) => {
  const { userId } = req.params;
  const results = [];
  for (const match of cache.matches.values()) {
    if (match.players.some(p => p.userId === userId)) {
      results.push({
        matchId: match.matchId,
        mapId: match.mapId,
        date: match.date,
        playerCount: match.playerCount,
        botCount: match.botCount,
        durationMs: match.durationMs,
      });
    }
  }
  res.json(results);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log('[server] Loading parquet data in background...');
});
