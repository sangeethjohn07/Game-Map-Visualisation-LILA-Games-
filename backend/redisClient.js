/**
 * redisClient.js
 * Handles Redis connection, cache serialization, and save/load.
 *
 * Uses gzip compression before storing so the full cache fits within
 * Render's free Redis 25 MB limit (raw JSON ~20 MB → compressed ~4-6 MB).
 *
 * Gracefully degrades: if REDIS_URL is not set, or connection fails,
 * all functions become no-ops and the app runs with in-memory cache only.
 */

const { createClient } = require('redis');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const CACHE_KEY = 'lila:cache:v2'; // v2: folderCounts replaces single fingerprint

let client = null;
let connected = false;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function connectRedis() {
  if (!process.env.REDIS_URL) {
    console.log('[redis] REDIS_URL not set — running without Redis');
    return false;
  }

  try {
    client = createClient({ url: process.env.REDIS_URL });

    client.on('error', err => {
      console.warn('[redis] Client error:', err.message);
    });

    client.on('reconnecting', () => {
      console.log('[redis] Reconnecting...');
    });

    await client.connect();
    connected = true;
    console.log('[redis] Connected successfully');
    return true;
  } catch (err) {
    console.warn('[redis] Connection failed:', err.message);
    console.warn('[redis] Continuing without Redis (in-memory only)');
    client = null;
    connected = false;
    return false;
  }
}

async function disconnectRedis() {
  if (client && connected) {
    try {
      await client.disconnect();
      console.log('[redis] Disconnected');
    } catch (_) {}
    client = null;
    connected = false;
  }
}

function isRedisAvailable() {
  return connected && client !== null;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// Maps and Sets are not JSON-serializable — convert to plain arrays/objects.
// ---------------------------------------------------------------------------

function serializeCache(cache, folderCounts = {}) {
  return JSON.stringify({
    folderCounts,                  // { "February_10": 234, "February_15": 80, ... }
    maps: [...cache.maps],
    matches: [...cache.matches.entries()],
    mapMatches: [...cache.mapMatches.entries()].map(([k, v]) => [k, [...v]]),
    dateMatches: [...cache.dateMatches.entries()].map(([k, v]) => [k, [...v]]),
  });
}

function deserializeCache(json) {
  const data = JSON.parse(json);
  return {
    folderCounts: data.folderCounts ?? {},
    cache: {
      maps: new Set(data.maps),
      matches: new Map(data.matches),
      mapMatches: new Map(data.mapMatches.map(([k, v]) => [k, new Set(v)])),
      dateMatches: new Map(data.dateMatches.map(([k, v]) => [k, new Set(v)])),
    },
  };
}

// ---------------------------------------------------------------------------
// Save / Load
// ---------------------------------------------------------------------------

/**
 * Compresses and saves the in-memory cache to Redis.
 * @param {object} cache - live cache from buildCache() / processFile()
 * @returns {boolean} true on success
 */
async function saveCacheToRedis(cache, folderCounts = {}) {
  if (!isRedisAvailable()) return false;

  try {
    const t0 = Date.now();
    const json = serializeCache(cache, folderCounts);
    const compressed = await gzip(json);
    const b64 = compressed.toString('base64');

    await client.set(CACHE_KEY, b64);

    const elapsed = Date.now() - t0;
    const rawKB = (json.length / 1024).toFixed(1);
    const compKB = (compressed.length / 1024).toFixed(1);
    console.log(
      `[redis] Cache saved — ${rawKB} KB → ${compKB} KB compressed (${elapsed} ms)`
    );
    return true;
  } catch (err) {
    console.warn('[redis] Save failed:', err.message);
    return false;
  }
}

/**
 * Loads and decompresses the cache from Redis.
 * @returns {object|null} deserialized cache, or null if not found / error
 */
async function loadCacheFromRedis() {
  if (!isRedisAvailable()) return null;

  try {
    const b64 = await client.get(CACHE_KEY);
    if (!b64) {
      console.log('[redis] No cached data found');
      return null;
    }

    const compressed = Buffer.from(b64, 'base64');
    const json = (await gunzip(compressed)).toString('utf-8');
    const { cache, folderCounts } = deserializeCache(json);

    console.log(
      `[redis] Cache loaded — ${cache.matches.size} matches, ${cache.maps.size} maps, ${Object.keys(folderCounts).length} folders`
    );
    return { cache, folderCounts };
  } catch (err) {
    console.warn('[redis] Load failed:', err.message);
    return null;
  }
}

module.exports = {
  connectRedis,
  disconnectRedis,
  isRedisAvailable,
  saveCacheToRedis,
  loadCacheFromRedis,
  serializeCache,
  deserializeCache,
};
