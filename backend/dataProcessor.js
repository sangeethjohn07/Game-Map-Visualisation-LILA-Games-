/**
 * dataProcessor.js
 * Reads all parquet files from player_data/, builds an in-memory cache with:
 *  - Decoded event strings
 *  - Pre-computed minimap pixel coordinates
 *  - Match/player/map/date indices
 */

const path = require('path');
const fs = require('fs');
const parquet = require('@dsnp/parquetjs');

const DATA_PATH = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH)
  : path.join(__dirname, '..', 'player_data');

const DATE_FOLDERS = [
  'February_10',
  'February_11',
  'February_12',
  'February_13',
  'February_14',
];

const MAP_CONFIGS = {
  AmbroseValley: { scale: 900, originX: -370, originZ: -473 },
  GrandRift: { scale: 581, originX: -290, originZ: -290 },
  Lockdown: { scale: 1000, originX: -500, originZ: -500 },
};

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
 * This means Date.getTime() returns the raw second value (e.g. 1_770_754_537)
 * instead of the correct millisecond value (1_770_754_537_000).
 *
 * Fix: multiply Date.getTime() × 1000 to recover real ms.
 * Consequence: diffs between events become seconds × 1000 = correct ms.
 * e.g. a 382-unit diff → 382 000 ms ≈ 6 min 22 s match duration.
 */
function parseTs(val) {
  if (val instanceof Date) return val.getTime() * 1000; // raw = Unix seconds; convert → ms
  if (typeof val === 'bigint') return Number(val);       // already ms if returned as BigInt
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
    // Silently skip corrupt / incompatible files
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main cache builder
// ---------------------------------------------------------------------------

async function buildCache() {
  console.log(`[dataProcessor] Loading data from: ${DATA_PATH}`);
  const t0 = Date.now();

  /** @type {Map<string, import('./types').MatchData>} */
  const matches = new Map();
  const mapMatches = new Map();   // mapId  -> Set<matchId>
  const dateMatches = new Map();  // date   -> Set<matchId>
  const maps = new Set();

  let totalFiles = 0;
  let processed = 0;
  let skipped = 0;

  for (const date of DATE_FOLDERS) {
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

      // Build event list for this player in this match
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

      // Initialise match entry on first encounter
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

  // Post-process: sort events, normalise timestamps, compute counts
  for (const match of matches.values()) {
    match.events.sort((a, b) => a.ts - b.ts);

    if (match.events.length > 0) {
      const minTs = match.events[0].ts;
      const maxTs = match.events[match.events.length - 1].ts;
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

  // Log-scale normalisation
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

module.exports = { buildCache, computeHeatmap, MAP_CONFIGS };
