# Live on GitHub — what is deployed and what still needs a server

Repo: **https://github.com/karimcoders/sync-music**
Speaker page (live): **https://karimcoders.github.io/sync-music/**
Backend image: **ghcr.io/karimcoders/sync-music:latest**

## What GitHub hosts

| Piece | Where | Status |
|---|---|---|
| Speaker web client (static, PWA) | GitHub Pages | ✅ live |
| Backend container image | GHCR, built by Actions on every push | ✅ published |
| REST API + `wss://` gateway + uploads + Redis | **nowhere yet** | ❌ needs a server |

GitHub Pages is static hosting — exactly like surge.sh — so it cannot run the WebSocket
sync server. The page is live, but until a backend exists it will show its
**Server address** field instead of discovering a host. That is the honest state.

## Finishing the job (one of these)

### A. Any VPS with Docker (5 minutes)

```bash
ssh root@<server>
docker run -d --name sync-music -p 8080:8080 \
  -e PUBLIC_BASE_URL=https://api.yourdomain.com \
  -e TOKEN_SECRET="$(openssl rand -base64 48)" \
  -e AUDIO_URL_SECRET="$(openssl rand -base64 48)" \
  -v /srv/sync-audio:/data \
  ghcr.io/karimcoders/sync-music:latest
```

Put it behind HTTPS (Caddy/Nginx/Cloudflare Tunnel), or clone the repo and run
`sudo ./deploy/deploy.sh api.yourdomain.com`, which brings up server + Redis + Caddy
with automatic TLS.

### B. Render / Railway / Fly.io free tier

Point the service at this repo's `Dockerfile`, set `SERVE_WEB=false`, `TOKEN_SECRET`,
`AUDIO_URL_SECRET`, and the platform gives you an HTTPS URL.

## Then connect the two

1. Repo → **Settings → Secrets and variables → Actions → Variables** → add
   `BACKEND_URL = https://api.yourdomain.com`, then re-run the **Deploy speaker web to
   Pages** workflow. The address is baked into the build.
2. Or, with no rebuild at all, share the link with the address in it:
   `https://karimcoders.github.io/sync-music/?api=https://api.yourdomain.com`
   (it is remembered in `localStorage` after the first open).
3. Build the Host APK against the backend:
   `cd apps/host-android && ./gradlew assembleRelease -PSYNC_BASE_URL=https://api.yourdomain.com`

## Workflows in the repo

* `ci.yml` — builds everything and fails the build if a hard-coded speaker limit appears.
* `pages.yml` — builds the speaker client (`VITE_BACKEND_URL`, subpath-aware) and deploys to Pages.
* `docker.yml` — builds and pushes the backend image to GHCR.
