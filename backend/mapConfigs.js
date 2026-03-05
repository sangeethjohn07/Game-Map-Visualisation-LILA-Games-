/**
 * mapConfigs.js
 * Coordinate mapping for each game map's minimap.
 *
 * To add a new map:
 *   1. Add an entry below with the map's exact map_id string from the parquet data.
 *   2. Set scale, originX, originZ to match the game's world-to-minimap transform.
 *   3. Add the minimap image to player_data/minimaps/ and frontend/public/minimaps/.
 *   4. Add the filename to minimapUrl() in frontend/src/api.js.
 *
 * Formula:
 *   u = (worldX - originX) / scale      → [0, 1]
 *   v = (worldZ - originZ) / scale      → [0, 1]
 *   pixelX = u * 1024
 *   pixelY = (1 - v) * 1024             ← Y-flip (image origin is top-left)
 */

const MAP_CONFIGS = {
  AmbroseValley: { scale: 900,  originX: -370, originZ: -473 },
  GrandRift:     { scale: 581,  originX: -290, originZ: -290 },
  Lockdown:      { scale: 1000, originX: -500, originZ: -500 },
  AmbroseValleyTest: { scale: 900,  originX: -370, originZ: -473 },

  // ── Add new maps below ────────────────────────────────────────────────────
  // ExampleMap: { scale: 800, originX: -400, originZ: -400 },
};

module.exports = { MAP_CONFIGS };
