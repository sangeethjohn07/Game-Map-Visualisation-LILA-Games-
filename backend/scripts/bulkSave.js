/**
 * scripts/bulkSave.js
 * Standalone script: rebuilds the full cache from parquet files and saves to Redis.
 *
 * Run manually:     node scripts/bulkSave.js
 * Render cron job:  schedule "0 0 * * *", command "node scripts/bulkSave.js"
 *
 * Requires REDIS_URL environment variable to be set.
 * Optionally loads .env from backend root for local testing.
 */

// Load .env if present (local dev only — Render sets env vars in the dashboard)
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const { buildCache, getFolderCounts } = require('../dataProcessor');
const {
  connectRedis,
  saveCacheToRedis,
  disconnectRedis,
  isRedisAvailable,
} = require('../redisClient');

async function main() {
  console.log('[bulkSave] Starting bulk save —', new Date().toISOString());

  if (!process.env.REDIS_URL) {
    console.error('[bulkSave] ERROR: REDIS_URL is not set. Exiting.');
    process.exit(1);
  }

  // 1. Connect to Redis
  const redisOk = await connectRedis();
  if (!redisOk || !isRedisAvailable()) {
    console.error('[bulkSave] ERROR: Could not connect to Redis. Exiting.');
    process.exit(1);
  }

  // 2. Build fresh cache from parquet files
  console.log('[bulkSave] Building cache from parquet files...');
  let cache;
  try {
    cache = await buildCache();
    console.log(
      `[bulkSave] Cache built — ${cache.matches.size} matches across ${cache.maps.size} maps`
    );
  } catch (err) {
    console.error('[bulkSave] ERROR: Cache build failed:', err.message);
    await disconnectRedis();
    process.exit(1);
  }

  // 3. Save to Redis with current folder counts
  const folderCounts = getFolderCounts();
  console.log('[bulkSave] Saving cache to Redis...');
  const saved = await saveCacheToRedis(cache, folderCounts);
  if (!saved) {
    console.error('[bulkSave] ERROR: Failed to save cache to Redis.');
    await disconnectRedis();
    process.exit(1);
  }

  // 4. Clean up and exit
  await disconnectRedis();
  console.log('[bulkSave] Done —', new Date().toISOString());
  process.exit(0);
}

main().catch(err => {
  console.error('[bulkSave] Unhandled error:', err);
  process.exit(1);
});
