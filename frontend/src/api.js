/**
 * api.js — thin wrapper over the backend REST API.
 * All functions return parsed JSON or throw on error.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function get(url) {
  const res = await fetch(`${BASE}${url}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** GET /api/status → { ready, matchCount, mapCount } */
export const fetchStatus = () => get('/api/status');

/** GET /api/maps → string[] */
export const fetchMaps = () => get('/api/maps');

/** GET /api/dates → string[] */
export const fetchDates = () => get('/api/dates');

/**
 * GET /api/matches?map=&date=
 * → [{matchId, mapId, date, playerCount, botCount, durationMs}]
 */
export function fetchMatches(map, date) {
  const params = new URLSearchParams();
  if (map) params.set('map', map);
  if (date) params.set('date', date);
  return get(`/api/matches?${params}`);
}

/**
 * GET /api/match/:matchId
 * → { matchId, mapId, date, durationMs, players, events }
 */
export const fetchMatch = (matchId) => get(`/api/match/${matchId}`);

/**
 * GET /api/heatmap/:matchId?type=kills|deaths|traffic
 * → { type, gridSize, data: base64 }
 * Decodes data → Float32Array
 */
export async function fetchHeatmap(matchId, type = 'traffic') {
  const json = await get(`/api/heatmap/${matchId}?type=${type}`);
  const binary = atob(json.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return {
    type: json.type,
    gridSize: json.gridSize,
    data: new Float32Array(bytes.buffer),
  };
}

/**
 * GET /api/player/:userId/matches
 * → [{matchId, mapId, date, playerCount, botCount, durationMs}]
 */
export const fetchPlayerMatches = (userId) =>
  get(`/api/player/${encodeURIComponent(userId)}/matches`);

/**
 * Returns the URL for a minimap image given a mapId.
 * Filename mapping for the 3 known maps.
 */
export function minimapUrl(mapId) {
  const names = {
    AmbroseValley: 'AmbroseValley_Minimap.png',
    GrandRift: 'GrandRift_Minimap.png',
    Lockdown: 'Lockdown_Minimap.jpg',
  };
  return `/minimaps/${names[mapId] ?? `${mapId}_Minimap.png`}`;
}
