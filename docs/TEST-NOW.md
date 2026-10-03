# Test it with your own phones right now (no server, no APK)

A free Cloudflare quick tunnel is pointing at the backend running in this workspace, so
there is a **real public HTTPS + WSS address** you can open on any phone:

```
BACKEND / SPEAKER:  https://figure-layout-lopez-tracked.trycloudflare.com
HOST CONSOLE:       https://figure-layout-lopez-tracked.trycloudflare.com/host
SPEAKER PAGE:       https://figure-layout-lopez-tracked.trycloudflare.com/speaker
```

> Honest caveat: this URL lives only while this workspace session is running, and a
> free quick tunnel has no uptime guarantee. It is for testing. For something permanent,
> run the backend image on any host — see `docs/DEPLOY-github.md`.

## 5-minute test

1. **Phone A (the host)** — open the **HOST CONSOLE** link.
   Tap **CREATE SESSION**, then pick an MP3/M4A/WAV with the file picker. It uploads once
   and appears in the playlist.
   *(This browser console is a stand-in for the Android Host app — same REST + WebSocket
   protocol, same server-timestamp scheduling. The real host is `apps/host-android`.)*
2. **Phones B, C, D…** — open the **SPEAKER PAGE** link in Chrome.
   The host appears by itself — no QR, no code. Tap **CONNECT**, then **ENABLE SPEAKER**
   (Android requires this one tap before any web page may play sound).
3. On the host console you now see **Connected Speakers: 3** and a live list with each
   phone's latency and drift.
4. Press **PLAY**. All phones start together about 1.5 s later — that gap is the
   scheduling lead that makes them start *at the same moment*.
5. Try: **Pause**, **Seek**, **Next**, **Resync All**, volume slider.
6. Put one phone in airplane mode for ~10 s. Audio keeps playing from its buffer, the UI
   shows *Reconnecting*, then it comes back and resyncs on its own — no reload.
7. Refresh a speaker tab: it returns with the **same** `Speaker N` name and jumps to the
   live position.

## How to judge the sync honestly

Put all the phones next to each other and listen for flam/echo on a track with sharp
percussion. Then look at the host's per-speaker drift column — under ~50 ms is where it
stops being audible as an echo. Bluetooth speakers add 100–200 ms of their own and will
always sound late; use the phones' own speakers for the test.

## Scale check (no device limit anywhere)

From a laptop with Node installed:

```bash
git clone https://github.com/karimcoders/sync-music && cd sync-music && npm install
node tools/loadtest.mjs --url https://figure-layout-lopez-tracked.trycloudflare.com --speakers 100
```

Through this tunnel, 5 virtual speakers measured ~8.5 ms one-way latency with
`errors=0`; the host console keeps showing the real count with no `/10` denominator.

## Automated proof (real Chromium, not a mock)

`tools/e2e.mjs` drives actual browsers through the whole product: host console creates a
session and uploads a track, N isolated browser contexts (= N phones) open `/speaker`,
connect, tap **ENABLE SPEAKER**, and then it reads each `<audio>` element's real
`currentTime`.

```bash
npx playwright install chromium
node tools/e2e.mjs https://figure-layout-lopez-tracked.trycloudflare.com 6
```

Last run against this public tunnel, 6 browser speakers:

```
✓ host shows Connected Speakers: 6
✓ inter-speaker spread at start:  22.5 ms
✓ inter-speaker spread after 6 s: 11.3 ms   (drift controller converging, rate back to 1.0)
✓ PAUSE stopped every speaker
✓ speaker 1 survived a browser refresh and re-attached
ALL CHECKS PASSED
```

## If the link is dead

The tunnel stopped with the workspace. Two permanent options:

* **Your own PC (free):** install Node 20 and cloudflared, then
  `npm install && npm run build && node server/dist/index.js` and
  `cloudflared tunnel --url http://localhost:8080` — you get a fresh public HTTPS URL.
* **Any host with Docker:** `docker run -p 8080:8080 ghcr.io/karimcoders/sync-music:latest`
  behind HTTPS, or `sudo ./deploy/deploy.sh your-domain.com`.
