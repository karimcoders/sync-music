# Sync Music — 1 Host Android app → N browser speaker phones

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/karimcoders/sync-music)

**Live web app (permanent):** https://karimcoders.github.io/sync-music/ ·
**Backend image:** `ghcr.io/karimcoders/sync-music:latest` ·
see [`docs/DEPLOY-github.md`](docs/DEPLOY-github.md) — the static page is live, the
backend still has to run on a server (Pages cannot host WebSockets).

One Android phone is the **Host**. Every other phone just opens a web page and taps
**Enable Speaker**. No client app, no QR code, no room PIN. Playback is scheduled
against a shared, NTP-style **server clock**, so the phones start together and stay
together within a few tens of milliseconds on a healthy network.

> **Connect as many speaker phones as your network and server infrastructure can support.**
> There is no product-level speaker limit anywhere in this codebase — the only cap is
> `MAX_CONNECTIONS_PER_INSTANCE`, an infrastructure guard you configure per deployment.

## Two ways to run it

* **Server mode (recommended)** — the Node backend in `server/` owns the clock and serves the audio. Deploy it anywhere (one click with the Render button above) and point the web app at it.
* **Direct mode (no server at all)** — if no backend is reachable, the host's browser tab becomes the authority and the phones connect to it over WebRTC. The static site alone is then enough, so the GitHub Pages link works on its own. The trade-offs are written down honestly in [`docs/DIRECT-MODE.md`](docs/DIRECT-MODE.md): the host tab must stay open, and it uploads the track to every phone.

## What this honestly is (and is not)

| Claim | Reality |
|---|---|
| Can a phone be forced to play audio remotely with nothing running? | **No.** A receiver must be running on that phone. Here that receiver is the `/speaker` web page in Chrome. |
| Does a speaker phone need an app? | No — only a browser. |
| Does the user need to tap something once? | **Yes.** Android/Chrome autoplay policy requires a user gesture (**Enable Speaker**). We do not try to bypass it. |
| Is synchronization perfect? | **No.** It is timestamp-scheduled and drift-corrected. Expect tens of milliseconds, varying with Wi‑Fi, device and audio pipeline. The host UI shows measured drift so you can judge it yourself. |
| Can the host control each phone's hardware volume? | **No.** Only the software volume of the web player (0.0–1.0). Physical volume belongs to each phone's OS. |
| Unlimited phones? | No guarantee is made. Capacity depends on server, bandwidth, CDN, Wi‑Fi and the phones themselves. |

---

## 1. Architecture

```
                         INTERNET
                            │
            ┌───────────────┴───────────────┐
            │   BACKEND (Node + TypeScript) │
            │   REST API + WebSocket gateway│
            │   Redis pub/sub (scale-out)   │
            │   Object storage / CDN (audio)│
            └───────┬───────────────┬───────┘
                    │               │
              HOST APP          SPEAKER WEB  (mobile browser)
              Android           Phone 1 … Phone N   ← dynamic, no cap
```

* Audio travels **storage/CDN → each phone**, once, cached locally.
* The Host only emits tiny control frames (`SYNC_PLAY`, `PAUSE`, `SEEK`, …), which the
  backend fans out. Host bandwidth is independent of the number of speakers.
* Speaker telemetry is **aggregated server-side** and sent only to the Host —
  speakers never receive each other's status.

```
sync-music/
├── apps/
│   ├── host-android/      Kotlin · Compose · Media3 · OkHttp WS
│   └── speaker-web/       React · TS · Vite · HTML5 Audio · PWA (optional)
├── packages/
│   ├── protocol/          shared message/REST types + tunables
│   └── sync-engine/       ClockSync (NTP-style) + DriftController
├── server/                Fastify · @fastify/websocket · Redis · signed URLs
├── tools/                 loadtest.mjs (N virtual speakers), host-sim.mjs
├── docker-compose.yml     server + redis + Caddy (automatic HTTPS/WSS)
├── Dockerfile · Caddyfile · .env.example
```

---

## 2. Run locally

```bash
npm install
npm run build          # builds packages, server and the speaker web app

# terminal 1 — backend (REST + WSS gateway)
PORT=8080 npm run dev:server

# terminal 2 — speaker web (proxies /api and /ws to :8080)
npm run dev:web        # http://localhost:5173/speaker
```

Smoke test without any phone:

```bash
# create a session
curl -XPOST localhost:8080/api/session/create -H 'content-type: application/json' \
     -d '{"name":"Karim'\''s Music"}'
# -> {"sessionId":"…","hostToken":"…"}

# attach a simulated host, then 50 virtual speakers
node tools/host-sim.mjs <sessionId> <hostToken> &
node tools/loadtest.mjs --url http://localhost:8080 --speakers 50
```

`loadtest.mjs` prints joined count, per-speaker latency percentiles and the deviation
between each speaker's scheduled start and the commanded server timestamp. On loopback
with 30 speakers this project measures **p95 ≈ 1 ms of control-plane deviation**; real
phones add their own audio-pipeline latency on top.

## 3. Run the Android Host

```bash
cd apps/host-android
# point the app at your backend (HTTPS in release builds)
./gradlew assembleDebug -PSYNC_BASE_URL=https://music.example.com
adb install app/build/outputs/apk/debug/app-debug.apk
```

Open in Android Studio (Hedgehog+) if you prefer. Flow:
`SPLASH → HOME → CREATE SESSION → HOST CONTROL PANEL`.
The panel shows **Connected Speakers: N** (dynamic, never `/10`), a scrollable
`LazyColumn` of speakers with per-speaker latency/drift, playlist controls
(play, delete, move up/down, auto-next), master software volume and **Resync All**.

For local development against a laptop, expose the backend over HTTPS
(`cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`) and pass that
URL as `SYNC_BASE_URL`. Cleartext HTTP is disabled in the manifest on purpose.

## 4. Run the Speaker Web client

Phones open `https://your-domain/speaker` in Chrome. The page:

1. calls `GET /api/session/active` (server-side discovery — no QR, no code),
2. auto-attaches when exactly one host session exists, otherwise lists hosts with a
   **CONNECT** button,
3. asks for one tap: **ENABLE SPEAKER** (creates the `<audio>` element inside the user
   gesture, as Android requires),
4. clock-syncs, preloads/caches the track from the CDN, and waits for a timestamp.

It is installable as a PWA (`manifest.webmanifest` + `sw.js`) but **installation is
optional** — plain Chrome works identically.

## 4b. Deploy to your own domain (e.g. suger.sh)

```bash
sudo ./deploy/deploy.sh suger.sh      # DNS A record must point at the server first
./deploy/scale.sh 4                   # optional: 4 instances behind Redis pub/sub
```

Full walkthrough: [`docs/DEPLOY-suger.sh.md`](docs/DEPLOY-suger.sh.md).

## 5. HTTPS / WSS

`docker-compose.yml` ships Caddy, which obtains and renews Let's Encrypt certificates
automatically and terminates both HTTPS and WSS:

```bash
cp .env.example .env
# set PUBLIC_BASE_URL, TOKEN_SECRET, AUDIO_URL_SECRET (openssl rand -base64 48)
# edit Caddyfile: replace music.example.com with your domain, point DNS at the host
docker compose up -d --build
```

Browsers refuse microphone-free autoplay unlock, service workers, and `wss://` from
insecure origins, so HTTPS is mandatory in production. Never run this over plain HTTP.

## 6. Deploy the backend (and scale it)

```bash
docker compose up -d --build --scale server=4
```

* Every instance is stateless for HTTP; session state and commands flow through
  **Redis pub/sub**, so any instance can serve any speaker of any session.
* `MAX_CONNECTIONS_PER_INSTANCE` (default 5000) is the only cap. When it is reached a
  *new* connection receives `SERVER_AT_CAPACITY` → *"Server is currently at capacity.
  Please try again later."* Existing speakers are never dropped. Raise capacity by
  adding instances, not by changing product logic.
* `GET /healthz` reports instance id, bus type, live connection count and the configured
  guard — wire it to your load balancer.

## 7. Deploy the frontend

Either let the backend serve it (`SERVE_WEB=true`, the Dockerfile copies
`apps/speaker-web/dist` to `/app/web`), or publish `apps/speaker-web/dist` to any static
host/CDN (Netlify, Cloudflare Pages, S3+CloudFront). If you host it separately, the
client must reach the backend on the same origin or you must set CORS + absolute
`PUBLIC_BASE_URL`; the bundled Caddy setup keeps everything same-origin, which is the
simplest and fastest path.

For large audiences put the audio objects behind a CDN (`CDN_BASE_URL`) or switch
`STORAGE_DRIVER=s3`: audio delivery, not WebSocket traffic, is what actually scales with
speaker count.

## 8. Test with many phones

See [`docs/TESTING.md`](docs/TESTING.md) for the full matrix (2 / 5 / 10 / 25+ phones,
join, leave, rejoin, seek, network interruption, host reconnect, refresh, screen lock,
background tab, slow network) and what to measure.

---

## 9. Synchronization, precisely

1. **Clock sync.** Every client sends `CLOCK_SYNC{clientTime:T1}`; the server replies
   with `T2` (receive) and `T3` (send); the client records `T4`.
   `rtt = (T4−T1) − (T3−T2)`, `offset = ((T2−T1) + (T3−T4)) / 2`.
   A burst of 5 probes at join, then one every 15 s. The estimator keeps the window's
   lowest-RTT third — far more robust than averaging over jittery mobile networks.
   Device wall clocks are never trusted directly.
2. **Scheduled start.** `HOST_PLAY` → server computes `startAt = serverNow + 1500 ms` and
   broadcasts `SYNC_PLAY {audioId, position, startAt}` (a ~120-byte frame). Each client
   computes `delay = startAt − clock.now()`, pre-seeks, arms a timer and calls `play()`
   at the moment, compensating the residual timer error.
3. **Continuous drift control.** Clients report `PLAYBACK_STATUS` every 2–20 s —
   the interval **backs off automatically as the session grows** (`statusIntervalMs`).
   Locally, at 1 Hz, each client compares its `currentTime` with the projected
   authoritative position:
   * `|drift| < 50 ms` → do nothing,
   * `50–150 ms` → `playbackRate = 0.99 / 1.01` (inaudible, no seek),
   * `> 150 ms` → one controlled seek (rate-limited to once per 3 s).
4. **Resync / late join / reconnect.** The server's `SESSION_STATE` and `RESYNC` carry
   the authoritative position *at a server time*, so a phone joining mid-song lands at
   the right place immediately.

## 10. Reconnection & failure behaviour

* Speaker socket drops → audio keeps playing from buffer, UI shows **Reconnecting**,
  exponential backoff with jitter, identity reclaimed via a signed speaker token
  (same `Speaker 7`, not a new one), then state request → resync. **No manual reload.**
* Speakers that vanish stay in a `reconnecting` grace window (`SPEAKER_GRACE_MS`) before
  being dropped from the host list.
* Host drops → speakers show **HOST DISCONNECTED / Waiting for Host…**; on return,
  **HOST CONNECTED ✓ / Synchronizing…**.
* Session ends/expires → `SESSION_ENDED`, speakers return to discovery.
* Every error has a human message (`Unable to connect. Retrying…`, `Audio could not be
  loaded. Tap Retry.`, `Your browser blocked audio. Tap Enable Speaker.`); stack traces
  go to the server log only.

## 11. Security

HTTPS/WSS only · HMAC-signed, expiring audio URLs · short-lived signed host and speaker
tokens (host token stored in `EncryptedSharedPreferences`, never in the APK or frontend)
· random 18-byte session ids, never a guessable PIN · REST rate limiting plus a
per-connection WebSocket token bucket · MIME allow-list and `MAX_UPLOAD_BYTES` on upload
· server-side filename sanitisation (no path traversal, no browser filesystem access) ·
expiring sessions · host-only control messages rejected from speaker sockets.

## 12. API

```
POST   /api/session/create           → sessionId, hostToken, speakerUrl
GET    /api/session/active           → discovery list + autoAttach
GET    /api/session/:id/state        → transport + authoritative position + serverTime
POST   /api/session/:id/speaker/join → anonymous deviceId + speaker auth
POST   /api/session/:id/speaker/leave
POST   /api/session/:id/playlist     (host)
POST   /api/audio/upload             (host, multipart, MIME + size validated)
GET    /api/audio/:id?exp&sig        signed, HTTP Range capable
GET    /api/audio                    (host) library
DELETE /api/session/:id              (host)
GET    /healthz
WS     wss://<host>/ws
```

Message types live in `packages/protocol/src/index.ts` (TypeScript) and are mirrored in
`apps/host-android/.../net/Protocol.kt`; `PROTOCOL_VERSION` guards drift.

## 13. Data model

In-memory + Redis for live session/speaker state (they are ephemeral by nature), and a
durable record per audio object (`server/data/audio-index.json` with the `local` driver).
Swap in PostgreSQL by implementing the same three tables — `Session(id, hostId, status,
createdAt, expiresAt)`, `Speaker(id, sessionId, deviceId, name, group, status, lastSeen,
joinedAt)`, `Audio(id, filename, mimeType, size, duration, storageUrl, createdAt)` —
behind `server/src/storage.ts` and `sessions.ts`. Only an anonymous device identifier is
stored for a speaker; there are no accounts.

## 14. Known limitations

Background tabs and locked screens throttle timers in Chrome — playback continues, but
drift correction slows; keep the screen on for critical use. Bluetooth speakers add
100–200 ms of their own latency per device. Very weak Wi‑Fi raises buffering and drift
far more than the number of phones does.
