# WorldChat — 3D Multiplayer Social World

## Architecture

Single-mode app: a 3D multiplayer social world with proximity voice/video chat.

### Stack
- **Server**: Node.js + Express + Socket.IO (`server/index.js`)
- **Client**: Vanilla HTML/CSS/JS + Three.js r128 (CDN) + WebRTC
- **No database** — all state in-memory

### Project Structure
```
virtual-world-chat/
├── .gitignore
├── package.json          (express, socket.io, uuid)
├── server/
│   └── index.js          (Express + Socket.IO server)
└── public/
    ├── index.html         (Login + Game UI)
    ├── style.css          (All styling)
    └── app.js             (Three.js, WebRTC, game logic)
```

### Features
- Login: enter name → create room or join with code
- 3D world: Neon Plaza map with pillars, platform, neon lights
- Player avatars: blocky humanoid with eyes, name labels, speech bubbles
- Movement: WASD + sprint (Shift) + jump (Space)
- Camera: right-drag orbit, scroll zoom, first-person when zoomed in
- Proximity voice/video: WebRTC peer connections within range
- Speaking indicator: shows who's talking in the top bar (Web Audio API analyser)
- Video on avatars: billboarded video planes above player heads
- Chat: text chat panel with timestamps
- Minimap: top-left canvas showing player positions
- Settings: volume, push-to-talk, mouse sensitivity, invert Y
- Tab menu: player list with distances

### Key Implementation Details
- **Proximity audio**: volume fades with distance (squared falloff)
- **WebRTC**: up to 5 peer connections, auto-connect to nearest players
- **Speaking detection**: AudioContext AnalyserNode on each remote stream, threshold-based
- **Video billboard**: video planes rotate to always face the camera each frame
- **Position sync**: 50ms send rate via Socket.IO

### Running
```bash
npm install && npm start
# http://localhost:3000
```

### Deploy (Railway)

Target platform is **Railway** (not Vercel — Vercel is serverless and can't support WebSockets).

```bash
# Install Railway CLI: https://docs.railway.app/guides/cli
railway login
railway init        # link to a new Railway project
railway up          # deploy
```

- Railway auto-detects Node.js via `package.json`
- `PORT` is set automatically by Railway — no manual config needed
- Health check: `GET /health` returns `{ "status": "ok" }`
- Config lives in `railway.toml` (build command, health check path, restart policy)
- `Procfile` defines the start command: `web: node server/index.js`
- `.env.example` documents available env vars
