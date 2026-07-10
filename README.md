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

Locally everything talks to `localhost`, which only works for you. To let friends join from elsewhere you need the client and server hosted somewhere public.

This is an **npm workspaces monorepo** (`shared` / `server` / `client`), so both hosts need to install dependencies from the **repo root** (not from inside the subfolder) so the `@fps/shared` workspace package resolves. The steps below account for that.

Recommended split: **client → Vercel**, **server → Railway**. The server holds live WebSocket connections and in-memory room state, so it needs a persistent Node process — Railway (or Fly.io/Render, which work the same way) — not a serverless function.

### 1. Server → Railway

1. Go to [railway.app](https://railway.app) and sign in (GitHub login is easiest since this repo is already on GitHub).
2. Click **New Project → Deploy from GitHub repo**, and pick this repository. Authorize Railway's GitHub App if prompted.
3. Once the service is created, open it and go to **Settings**:
   - **Root Directory**: leave as `/` (the repo root) — do *not* point it at `server/`. The repo includes a `railway.json` at the root that tells Railway how to build and start the server correctly from there (`npm install && npm run build -w server` to build, `npm run start -w server` to run). Railway auto-detects this file, so you shouldn't need to type build/start commands manually — but if the fields are blank, set them to those two commands.
   - **Networking**: click **Generate Domain** to get a public URL like `your-app.up.railway.app`, so you can verify the deploy before touching DNS.
4. Go to the **Deployments** tab and wait for the build to finish. Confirm it's healthy by visiting `https://your-app.up.railway.app/health` — you should see `{"ok":true,"service":"fps-server","rooms":0}`.
5. You generally don't need to set a `PORT` variable — Railway injects one automatically and the server already reads `process.env.PORT`.

### 2. Client → Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
2. Click **Add New… → Project**, and import this repository.
3. On the **Configure Project** screen:
   - **Root Directory**: click **Edit** and set it to `client`. Vercel will detect the npm workspaces setup and still run `npm install` from the repo root automatically, so `@fps/shared` resolves correctly.
   - **Framework Preset**: should auto-detect as **Vite**. The repo also includes `client/vercel.json` pinning the build command (`npm run build`) and output directory (`dist`), so these fields should already be filled in correctly.
4. Expand **Environment Variables** and add:
   ```
   VITE_WS_URL = wss://your-app.up.railway.app/ws
   ```
   (use the Railway domain from step 1, with `wss://` and the `/ws` path — Vite bakes this in at build time, so it must be set here, not left for runtime).
5. Click **Deploy**. Once it finishes, open the Vercel URL and confirm you can create a room (open the browser console — if you see the `VITE_WS_URL was not set` warning, the env var didn't take; double check step 4 and redeploy).

No CORS configuration is needed anywhere — the game server doesn't serve cross-origin HTTP requests the client depends on, and WebSocket upgrade requests aren't subject to CORS the way `fetch` is.

**Rooms are in-memory.** A server restart (redeploy, Railway cycling a dormant instance, etc.) drops any live rooms. Fine for a casual game with no accounts; worth knowing if you scale this up later.

### 3. Pointing folvra.com at it

Recommended split: the client on the apex domain (`folvra.com`) and `www`, the server on a subdomain (`api.folvra.com`) — Railway can't usefully serve a bare apex domain, and keeping the WebSocket server on its own subdomain avoids apex-domain complications entirely.

**Client domain (in the Vercel dashboard):**

1. Open your project → **Settings → Domains**.
2. Add `folvra.com` and `www.folvra.com`.
3. Vercel will show you the *exact* DNS records to add, tailored to your account — add these at your domain registrar's DNS settings (wherever you bought `folvra.com`):
   - For the apex `folvra.com`: an **A record** at the root (`@`) pointing at the IP Vercel displays (historically `76.76.21.21`, but always use the value shown in your dashboard — it can change).
   - For `www.folvra.com`: a **CNAME record** with host `www` pointing at `cname.vercel-dns.com`.
4. Vercel auto-issues an SSL certificate once DNS propagates (usually minutes, can take up to ~24h). The Domains page shows a green check when it's live.

**Server domain (in the Railway dashboard):**

1. Open your service → **Settings → Networking → Custom Domain**.
2. Enter `api.folvra.com` and click **Add**.
3. Railway will display a **CNAME target** unique to your service (something like `xxxxxxxx.up.railway.app` or a Railway-managed hostname) — copy it exactly.
4. At your domain registrar, add a **CNAME record** with host `api` pointing at that target.
5. Wait for DNS propagation and for Railway to show the domain as verified with a valid TLS certificate (also usually minutes, occasionally longer).

**Summary of DNS records to add at your registrar** (exact target values come from each dashboard, not listed here since they're account-specific):

| Host | Type | Points to | Purpose |
|---|---|---|---|
| `@` (apex `folvra.com`) | A | IP shown in Vercel's Domains page | Client |
| `www` | CNAME | `cname.vercel-dns.com` | Client (www) |
| `api` | CNAME | Hostname shown in Railway's Custom Domain page | Server (WebSocket) |

**After DNS is live**, update the client's `VITE_WS_URL` env var in Vercel to use the real domain instead of the `*.up.railway.app` one, then redeploy:

```
VITE_WS_URL=wss://api.folvra.com/ws
```

Some registrars don't support A records at the apex (only CNAME/ALIAS) — if yours doesn't, use `www.folvra.com` as the primary URL you share (redirecting bare `folvra.com` isn't required for the game to work, just a nicety) or check whether your registrar offers an ALIAS/ANAME record type, which behaves like a CNAME but is legal at the apex.

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
