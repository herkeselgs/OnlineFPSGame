# Duel

A trackpad-friendly 1v1 browser FPS. No download, no account — create a room, send the link, and you're shooting at each other in under 15 seconds.

Three low-recoil-to-high-recoil weapons (rifle / SMG / shotgun), two duel maps, server-authoritative netcode with client-side prediction and lag compensation, local progression/cosmetics, and match history — all running in a browser tab.

## Quick start

Requires Node 20+.

```bash
npm install
npm run dev
```

This starts the game server on `:8787` and the client dev server on `:5173`. Open `http://localhost:5173`, create a room in one tab, join with the code in another (or on a second device on the same network — the dev server prints a network URL you can use from a phone/laptop on the same wifi).

Other useful scripts (run from the repo root):

```bash
npm run typecheck   # typecheck all three packages
npm run build        # production build of client + server
```

## Project structure

This is an npm workspaces monorepo:

```
shared/   Game rules both client and server trust as the source of truth:
          movement physics, collision, weapon stats, map data, the network
          protocol, XP/cosmetics. Neither client nor server duplicates this
          logic — they import it directly.

server/   Authoritative game server (Node + ws). Runs the same movement
          code as the client at a fixed 60Hz tick, validates every shot
          server-side (including lag compensation), and is the only thing
          that can actually change a player's health/score.

client/   Three.js browser client. Predicts its own movement locally for
          responsiveness, reconciles against the server's authoritative
          state, and interpolates other players between snapshots.
```

See `shared/src/protocol.ts` for the full client↔server message contract if you're extending the netcode.

## How the netcode works (short version)

- Server runs a fixed 60Hz simulation per room using the exact same `stepPlayerMovement` function the client uses for prediction — there's no separate server-side reimplementation to drift out of sync.
- Client predicts its own movement immediately on input, buffers unacknowledged inputs, and replays them on top of each server correction (20Hz snapshots).
- Other players are rendered ~100ms in the past, interpolated between the last two snapshots, so 20Hz updates look like smooth 60fps motion.
- Hit validation is server-side: the server keeps a short position history per player and rewinds targets to where the shooter's client actually saw them before checking a hit, so a moving target under latency doesn't unfairly dodge a shot that looked like a hit on the shooter's screen.

## Deploying so friends can actually play

Locally everything talks to `localhost`, which only works for you. To let friends join from elsewhere you need the client and server hosted somewhere public. Recommended split (matches the brief this was built to):

**Server → Railway, Fly.io, or Render** (anything that runs a persistent Node process — the game server holds live WebSocket connections and in-memory room state, so it needs to be a long-running process, not a serverless function).

1. Deploy the `server/` directory (`npm run build -w server` produces `server/dist/index.js`; start command is `node dist/index.js`).
2. Set the `PORT` env var if your host requires a specific one (most inject this automatically).
3. Note the public URL your host gives you, e.g. `https://your-app.up.railway.app`.

**Client → Vercel** (or Netlify/Cloudflare Pages — it's a static Vite build, any static host works).

1. Deploy the `client/` directory. Build command: `npm run build`. Output directory: `client/dist`.
2. Set the environment variable `VITE_WS_URL` to your server's WebSocket URL, using `wss://` (secure) since Vercel serves over HTTPS and browsers block insecure `ws://` connections from an HTTPS page:
   ```
   VITE_WS_URL=wss://your-app.up.railway.app/ws
   ```
3. Redeploy after setting the env var (Vite bakes it in at build time).

No CORS configuration is needed — the game server doesn't serve cross-origin HTTP requests the client depends on, and WebSocket upgrade requests aren't subject to CORS the way `fetch` is.

**Rooms are in-memory.** A server restart (redeploy, host cycling a dormant instance, etc.) drops any live rooms. Fine for a casual game with no accounts; worth knowing if you scale this up later.

## What's built

- Movement: WASD + jump, pointer-lock or click-and-drag look modes, tunable trackpad acceleration curve, invert-Y — fully playable with a trackpad only.
- Combat: rifle (precise, semi-auto), SMG (fast, spreadier), shotgun (devastating up close, falls off hard at range) — all hitscan, server-validated.
- Two maps: Foundry (flat, industrial) and Bastion (stair-climbable verticality, warm palette).
- Full multiplayer loop: create/join by code, ready-up, countdown, live match, results, rematch.
- Progression: local XP/levels, color cosmetics unlocked by level, match history with K/D/accuracy/damage, all in `localStorage` (no account needed).
- Audio (synthesized, no asset files) and screen-shake/recoil tuned per weapon.
- Mobile-responsive landing page with a notice steering phone visitors toward creating a room and continuing on a laptop.

## What's not built / natural next steps

- No headshot multiplier (uniform hitbox) — would need a distinct head collider.
- No ranked matchmaking or accounts — by design, for zero-friction casual play. Would need a real backend + auth if you want persistent cross-device profiles.
- Only 1v1 — the room/protocol model doesn't hardcode 2 players anywhere except a couple of `MAX_PLAYERS` constants (`server/src/rooms/Room.ts`), so 2v2/FFA is a real but non-trivial extension (needs a team concept, more spawn points per map, and UI for >2 players in the lobby/scoreboard).
- Weapon balance and map design have had one real pass each but would benefit from actual playtesting at scale.
