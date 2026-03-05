# LILA BLACK — Player Journey Visualizer

An internal tool for level designers to visualizing player movement, match events, and heatmaps from game session data.

---

## Stack

| Layer    | Tech                          |
|----------|-------------------------------|
| Frontend | React 18, Vite, Tailwind CSS  |
| Backend  | Node.js, Express              |
| Data     | Parquet files (`.nakama-0`)   |
| Cache    | Redis                         |

---

## Running Locally

**Prerequisites:** Node.js 18+, data files in `player_data/`

```bash
# Backend (port 3001)
cd backend
npm install
npm start

# Frontend (port 5173)
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

The backend auto-detects all date folders inside `player_data/` — no config needed when adding new data folders.

---



## Redis (optional)

Set `REDIS_URL` in your environment (or `backend/.env` for local dev). Without it, the server runs with in-memory cache only.

**Startup behaviour with Redis:**
- If Redis has cached data and no new files → loads from Redis instantly.
- If new files are detected → only reprocesses changed folders, then updates Redis.
- If Redis is empty → full rebuild from parquet, then saves to Redis.

**Manual cache rebuild:**
```bash
cd backend
npm run bulk-save
```

