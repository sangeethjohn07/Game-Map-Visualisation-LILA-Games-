/**
 * dataProcessor.js
 * Reads all parquet files from player_data/, builds an in-memory cache with:
 *  - Decoded event strings
 *  - Pre-computed minimap pixel coordinates
 *  - Match/player/map/date indices
 *
 * Also exports processFile() for incremental ingestion (file watcher).
 */

const path = require('path');
const fs = require('fs');
const parquet = require('@dsnp/parquetjs');

const DATA_PATH = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH)
  : path.join(__dirname, '..', 'player_data');

// Auto-detect date folders from DATA_PATH instead of hardcoding.
// Any subdirectory that contains .nakama-0 files will be included.
function getDateFolders() {
  if (!fs.existsSync(DATA_PATH)) return [];
  return fs.readdirSync(DATA_PATH, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'minimaps')
    .map(e => e.name)
    .sort();
}

const { MAP_CONFIGS } = require('./mapConfigs');

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

function worldToMinimap(x, z, mapId) {
  const cfg = MAP_CONFIGS[mapId];
  if (!cfg) return { pixelX: 512, pixelY: 512 };
  const u = (x - cfg.originX) / cfg.scale;
  const v = (z - cfg.originZ) / cfg.scale;
  return {
    pixelX: Math.max(0, Math.min(1023, Math.round(u * 1024))),
    pixelY: Math.max(0, Math.min(1023, Math.round((1 - v) * 1024))),
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function isBot(userId) {
  return /^\d+$/.test(String(userId).trim());
}

/**
 * Filename format: {user_id}_{match_id}.nakama-0
 * UUIDs contain only hyphens (no underscores), so the first '_' separates userId from matchId.
 */
function parseFilename(filename) {
  const base = filename.endsWith('.nakama-0')
    ? filename.slice(0, -9)
    : filename;
  const idx = base.indexOf('_');
  if (idx === -1) return null;
  return {
    userId: base.slice(0, idx),
    matchId: base.slice(idx + 1),
  };
}

function decodeEvent(val) {
  if (Buffer.isBuffer(val)) return val.toString('utf-8').trim();
  if (val instanceof Uint8Array) return Buffer.from(val).toString('utf-8').trim();
  if (typeof val === 'string') return val.trim();
  return String(val).trim();
}

/**
 * @dsnp/parquetjs returns TIMESTAMP columns as Date objects, but treats the
 * raw INT64 (which the game stores as Unix SECONDS) as if it were milliseconds.
 * Fix: multiply Date.getTime() × 1000 to recover real ms.
 */
function parseTs(val) {
  if (val instanceof Date) return val.getTime() * 1000;
  if (typeof val === 'bigint') return Number(val);
  return Number(val);
}

// ---------------------------------------------------------------------------
// File reader
// ---------------------------------------------------------------------------

async function readParquetFile(filePath) {
  try {
    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();
    const rows = [];
    let record;
    while ((record = await cursor.next()) !== null) {
      rows.push(record);
    }
    await reader.close();
    return rows;
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main cache builder (full rebuild from disk)
// ---------------------------------------------------------------------------

async function buildCache() {
  console.log(`[dataProcessor] Loading data from: ${DATA_PATH}`);
  const t0 = Date.now();

  const matches = new Map();
  const mapMatches = new Map();
  const dateMatches = new Map();
  const maps = new Set();

  let totalFiles = 0;
  let processed = 0;
  let skipped = 0;

  for (const date of getDateFolders()) {
    const folderPath = path.join(DATA_PATH, date);
    if (!fs.existsSync(folderPath)) continue;

    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.nakama-0'));
    totalFiles += files.length;

    for (const file of files) {
      const parsed = parseFilename(file);
      if (!parsed) { skipped++; continue; }
      const { userId, matchId } = parsed;
      const bot = isBot(userId);

      const rows = await readParquetFile(path.join(folderPath, file));
      if (rows.length === 0) { skipped++; continue; }

      const mapId = String(rows[0].map_id || 'Unknown');

      const playerEvents = [];
      for (const row of rows) {
        const x = parseFloat(row.x) || 0;
        const z = parseFloat(row.z) || 0;
        const { pixelX, pixelY } = worldToMinimap(x, z, mapId);
        playerEvents.push({
          userId,
          isBot: bot,
          ts: parseTs(row.ts),
          event: decodeEvent(row.event),
          pixelX,
          pixelY,
        });
      }
      playerEvents.sort((a, b) => a.ts - b.ts);

      if (!matches.has(matchId)) {
        matches.set(matchId, {
          matchId,
          mapId,
          date,
          players: [],
          events: [],
          playerCount: 0,
          botCount: 0,
          durationMs: 0,
          rawMinTs: null, // set during post-processing
        });
        maps.add(mapId);

        if (!mapMatches.has(mapId)) mapMatches.set(mapId, new Set());
        mapMatches.get(mapId).add(matchId);

        if (!dateMatches.has(date)) dateMatches.set(date, new Set());
        dateMatches.get(date).add(matchId);
      }

      const match = matches.get(matchId);
      match.players.push({ userId, isBot: bot });
      for (const ev of playerEvents) match.events.push(ev);

      processed++;
      if (processed % 200 === 0) {
        process.stdout.write(`\r[dataProcessor] ${processed}/${totalFiles} files processed`);
      }
    }
  }

  // Post-process: sort events, store rawMinTs, normalise timestamps, compute counts
  for (const match of matches.values()) {
    match.events.sort((a, b) => a.ts - b.ts);

    if (match.events.length > 0) {
      const minTs = match.events[0].ts;
      const maxTs = match.events[match.events.length - 1].ts;
      match.rawMinTs = minTs;          // ← stored so incremental updates can normalize consistently
      match.durationMs = maxTs - minTs;
      for (const ev of match.events) ev.ts -= minTs;
    }

    match.playerCount = match.players.filter(p => !p.isBot).length;
    match.botCount = match.players.filter(p => p.isBot).length;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n[dataProcessor] Done — ${matches.size} matches, ${processed} files loaded, ${skipped} skipped in ${elapsed}s`
  );

  return { maps, matches, mapMatches, dateMatches };
}

// ---------------------------------------------------------------------------
// Incremental: process a single new file into an existing live cache
// ---------------------------------------------------------------------------

/**
 * Merges one new parquet file into the live in-memory cache.
 * Called by the file watcher when a new .nakama-0 file appears.
 *
 * @param {string} filePath  - absolute path to the new file
 * @param {string} date      - folder name, e.g. 'February_15'
 * @param {object} cache     - live cache object ({ maps, matches, mapMatches, dateMatches })
 * @returns {string|null}    - matchId that was updated, or null if skipped
 */
async function processFile(filePath, date, cache) {
  const filename = path.basename(filePath);
  const parsed = parseFilename(filename);
  if (!parsed) {
    console.warn(`[dataProcessor] Cannot parse filename: ${filename}`);
    return null;
  }

  const { userId, matchId } = parsed;
  const bot = isBot(userId);

  const rows = await readParquetFile(filePath);
  if (rows.length === 0) {
    console.warn(`[dataProcessor] No rows in file: ${filename}`);
    return null;
  }

  const mapId = String(rows[0].map_id || 'Unknown');

  // Build raw events (un-normalized timestamps)
  const rawEvents = [];
  for (const row of rows) {
    const x = parseFloat(row.x) || 0;
    const z = parseFloat(row.z) || 0;
    const { pixelX, pixelY } = worldToMinimap(x, z, mapId);
    rawEvents.push({
      userId,
      isBot: bot,
      ts: parseTs(row.ts),
      event: decodeEvent(row.event),
      pixelX,
      pixelY,
    });
  }
  rawEvents.sort((a, b) => a.ts - b.ts);

  if (cache.matches.has(matchId)) {
    // ── Existing match: merge new player's events ───────────────────────────
    const match = cache.matches.get(matchId);

    // Skip if this player was already processed (de-dupe)
    if (match.players.some(p => p.userId === userId)) {
      console.log(`[dataProcessor] Duplicate file ignored: ${filename}`);
      return null;
    }

    match.players.push({ userId, isBot: bot });

    const rawMinTs = match.rawMinTs ?? 0;
    for (const ev of rawEvents) {
      match.events.push({ ...ev, ts: ev.ts - rawMinTs });
    }

    match.events.sort((a, b) => a.ts - b.ts);

    // Recompute duration (max normalized ts is already relative to rawMinTs)
    if (match.events.length > 0) {
      match.durationMs = match.events[match.events.length - 1].ts;
    }

    match.playerCount = match.players.filter(p => !p.isBot).length;
    match.botCount = match.players.filter(p => p.isBot).length;

  } else {
    // ── New match: initialize from first file ───────────────────────────────
    const rawMinTs = rawEvents.length > 0 ? rawEvents[0].ts : 0;
    const rawMaxTs = rawEvents.length > 0 ? rawEvents[rawEvents.length - 1].ts : 0;
    const normalizedEvents = rawEvents.map(ev => ({ ...ev, ts: ev.ts - rawMinTs }));

    cache.matches.set(matchId, {
      matchId,
      mapId,
      date,
      players: [{ userId, isBot: bot }],
      events: normalizedEvents,
      playerCount: bot ? 0 : 1,
      botCount: bot ? 1 : 0,
      durationMs: rawMaxTs - rawMinTs,
      rawMinTs,
    });

    cache.maps.add(mapId);

    if (!cache.mapMatches.has(mapId)) cache.mapMatches.set(mapId, new Set());
    cache.mapMatches.get(mapId).add(matchId);

    if (!cache.dateMatches.has(date)) cache.dateMatches.set(date, new Set());
    cache.dateMatches.get(date).add(matchId);
  }

  console.log(`[dataProcessor] Ingested ${filename} → match ${matchId}`);
  return matchId;
}

// ---------------------------------------------------------------------------
// Heatmap computation
// ---------------------------------------------------------------------------

const HEATMAP_EVENTS = {
  kills: ['Kill', 'BotKill'],
  deaths: ['Killed', 'BotKilled', 'KilledByStorm'],
  traffic: ['Position', 'BotPosition'],
};

function computeHeatmap(events, type, gridSize = 32) {
  const grid = new Float32Array(gridSize * gridSize);
  const targets = new Set(HEATMAP_EVENTS[type] || HEATMAP_EVENTS.traffic);

  for (const ev of events) {
    if (!targets.has(ev.event)) continue;
    const cx = Math.min(gridSize - 1, Math.floor((ev.pixelX / 1024) * gridSize));
    const cy = Math.min(gridSize - 1, Math.floor((ev.pixelY / 1024) * gridSize));
    grid[cy * gridSize + cx]++;
  }

  let max = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
  if (max > 0) {
    const logMax = Math.log1p(max);
    for (let i = 0; i < grid.length; i++) {
      grid[i] = grid[i] > 0 ? Math.log1p(grid[i]) / logMax : 0;
    }
  }

  return grid;
}

module.exports = {
  buildCache,
  processFile,
  computeHeatmap,
  DATA_PATH,
  parseFilename,
};
