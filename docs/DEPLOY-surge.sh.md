# Deploying on surge.sh — what works and what cannot

## The one thing you must know

**surge.sh serves static files only.** It cannot run Node, WebSockets, file uploads or
Redis. So surge can host **half** of this product:

| Piece | Can surge host it? |
|---|---|
| `/speaker` web client (HTML/CSS/JS, PWA) | ✅ yes — this is exactly what surge is for |
| REST API, `wss://` gateway, audio upload/storage, Redis | ❌ no — needs a real server |

Anybody who tells you a WebSocket sync server can run on surge is wrong. The speaker page
on surge will simply point at a backend running somewhere else. That is a completely
normal split (static CDN + API server) and it works well.

```
 phones ──▶ https://sync-music.surge.sh/speaker     (static, free, HTTPS)
                        │
                        └── wss:// + REST ──▶ https://api.yourdomain.com   (Node backend)
                                                         │
                                                  audio objects / CDN
```

## Step 1 — backend first (required)

Pick any host that runs a container or Node process with HTTPS:

* **Your own VPS** — `sudo ./deploy/deploy.sh api.yourdomain.com` (Docker + Caddy + auto TLS)
* **Render / Railway / Fly.io** — free tiers are enough for a first test; they give you
  an HTTPS domain and terminate TLS, so set `SERVE_WEB=false` and skip Caddy.

Verify before continuing:

```bash
curl https://api.yourdomain.com/healthz
# {"ok":true,"instance":"…","bus":"memory","connections":0,…}
```

## Step 2 — publish the speaker page to surge

```bash
npx surge login            # once; or: export SURGE_LOGIN=… SURGE_TOKEN=$(npx surge token)
./deploy/surge.sh sync-music.surge.sh https://api.yourdomain.com
```

The script:

1. checks the backend's `/healthz`,
2. rebuilds the client with `VITE_BACKEND_URL` baked in,
3. writes `200.html` (so `/speaker` and any deep link resolve on surge) and `CNAME`,
4. runs `surge`.

Result: **https://sync-music.surge.sh/speaker** — free HTTPS, which is mandatory for the
audio-unlock gesture, service worker and `wss://`.

## Step 3 — phones

Each speaker phone opens `https://sync-music.surge.sh/speaker`, the page finds the host
session through your backend (no QR, no code), and the user taps **Enable Speaker** once.

The Host APK must point at the **backend**, not at surge:

```bash
cd apps/host-android
./gradlew assembleRelease -PSYNC_BASE_URL=https://api.yourdomain.com
```

## Changing the backend without rebuilding

The client resolves its server in this order:

1. `?api=https://api.yourdomain.com` in the URL (saved to `localStorage`, so the link
   only needs it once) — handy for sharing,
2. `VITE_BACKEND_URL` baked at build time,
3. same origin (when the Node server serves the page itself).

If none is set, the page shows a small **Server address** field instead of failing
silently. CORS is already open on the backend, so a cross-origin surge deployment works
without extra configuration.

## Limits of this setup

* Audio files are served by your backend (or its CDN), not by surge — surge bandwidth is
  irrelevant to playback, and the surge free tier is fine for the ~55 KB page bundle.
* surge gives HTTPS on `*.surge.sh` for free; custom domains on surge need their paid
  plan for SSL.
* Everything about synchronization, capacity and the dynamic (uncapped) speaker count is
  unchanged — those live in the backend.
