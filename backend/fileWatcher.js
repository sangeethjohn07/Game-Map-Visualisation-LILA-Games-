/**
 * fileWatcher.js
 * Watches player_data/ for new .nakama-0 Parquet files using chokidar.
 * When a new file is detected, processes it incrementally into the live
 * in-memory cache and triggers a Redis save.
 *
 * Useful for:
 *   - Local development (drop files into player_data/ folders)
 *   - Render paid tier with persistent disk (files uploaded via SSH/rsync)
 */

const chokidar = require('chokidar');
const path = require('path');
const { processFile, DATA_PATH } = require('./dataProcessor');
const { saveCacheToRedis } = require('./redisClient');

/**
 * Starts watching DATA_PATH for new .nakama-0 files.
 *
 * @param {object}   cache      - live in-memory cache reference
 * @param {Function} [onUpdate] - optional callback(matchId) after each successful update
 * @returns {chokidar.FSWatcher}
 */
function startFileWatcher(cache, onUpdate) {
  const pattern = path.join(DATA_PATH, '**', '*.nakama-0');

  const watcher = chokidar.watch(pattern, {
    ignoreInitial: true,          // skip files that already exist at startup
    persistent: true,
    usePolling: false,            // use native fs events (efficient)
    awaitWriteFinish: {
      stabilityThreshold: 2000,  // wait 2s after last write before triggering
      pollInterval: 500,
    },
  });

  watcher.on('add', async (filePath) => {
    // Derive the date folder name from the parent directory
    const date = path.basename(path.dirname(filePath));
    console.log(`[watcher] New file detected: ${path.relative(DATA_PATH, filePath)}`);

    try {
      const matchId = await processFile(filePath, date, cache);

      if (matchId) {
        console.log(`[watcher] Successfully ingested → match ${matchId}`);

        // Persist updated cache to Redis
        await saveCacheToRedis(cache);

        if (typeof onUpdate === 'function') onUpdate(matchId);
      }
    } catch (err) {
      console.error(`[watcher] Error processing ${path.basename(filePath)}:`, err.message);
    }
  });

  watcher.on('error', err => {
    console.error('[watcher] Watcher error:', err.message);
  });

  console.log(`[watcher] Watching for new files in: ${DATA_PATH}`);
  return watcher;
}

module.exports = { startFileWatcher };
