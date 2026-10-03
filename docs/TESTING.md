# Testing & measurement plan

## 0. Pre-flight

```bash
npm run build
docker compose up -d --build        # or the two local dev servers
curl -s https://music.example.com/healthz
```

Confirm: `/speaker` loads over HTTPS, the WebSocket upgrades to `wss://`, and
`GET /api/session/active` returns the host session.

## 1. Device matrix

| Group | Phones | Purpose |
|---|---|---|
| A | 2 | Functional pass of every control |
| B | 5 | Audible sync check in one room |
| C | 10 | Mixed Android versions / Chrome versions |
| D | 25–100 (`tools/loadtest.mjs`) | Control-plane scale, proves no fixed cap |

Mix at least three device classes (budget, mid, flagship) and two Chrome major
versions. Note any phone on battery saver — it throttles timers.

## 2. Functional checklist

1. **Join** — open `/speaker`, host appears automatically (no code typed), CONNECT,
   ENABLE SPEAKER → `🔊 SPEAKER ACTIVE`.
2. **Leave** — close the tab; host list moves the speaker to `reconnecting`, then drops
   it after `SPEAKER_GRACE_MS`.
3. **Rejoin** — reopen the page; the phone reclaims the *same* speaker name.
4. **Play** — all phones start together; measure deviation (section 4).
5. **Pause** — all stop within the `applyAt` window (~400 ms lead).
6. **Seek** — drag host slider; every phone lands on the same position.
7. **Stop** — positions reset to 0.
8. **Next song** — new track preloads on every phone, then plays in sync.
9. **Network interruption** — enable airplane mode on one phone for 10 s: audio keeps
   playing from buffer, UI shows *Reconnecting*, then *Synchronizing*, then back in sync
   with no manual reload.
10. **Host reconnect** — kill the host's network: speakers show *HOST DISCONNECTED*;
    restore it: *HOST CONNECTED ✓* and playback continues.
11. **Browser refresh** — F5/pull-to-refresh on a speaker: reattaches, same identity,
    jumps to the live position.
12. **Screen lock** — audio continues; drift correction resumes when the screen wakes.
13. **Background browser** — switch apps; audio continues, timers throttle.
14. **Slow internet** — Chrome DevTools remote throttling (`Slow 3G`): first load is
    slower, playback still schedules correctly once buffered.
15. **Different devices / Chrome versions** — repeat 4–6 on each.
16. **Capacity** — set `MAX_CONNECTIONS_PER_INSTANCE=5` and connect a 6th client: it
    receives *"Server is currently at capacity. Please try again later."* and **no
    existing speaker is disconnected**. Reset afterwards.

## 3. Scale test (no device limit)

```bash
node tools/host-sim.mjs <sessionId> <hostToken> &
node tools/loadtest.mjs --url https://music.example.com --speakers 100
node tools/loadtest.mjs --url https://music.example.com --speakers 500   # infra permitting
```

Expect: `joined=N/N errors=0`, host snapshot shows `Connected Speakers: N`, and the
host UI never renders a `/limit` denominator. With `--scale server=4` + Redis, verify
speakers spread over instances still receive the same `SYNC_PLAY`.

## 4. What to measure

| Metric | How |
|---|---|
| Playback start deviation | `loadtest.mjs` p50/p95 for the control plane; for real audio, record all phones with one microphone and inspect the transient onsets in Audacity |
| Playback drift | Host panel per-speaker drift column + `Average Sync Drift` |
| Reconnect time | Stopwatch from airplane-mode off to `PLAYING` again (expect < 3 s) |
| Audio buffering | Speaker UI buffered bar; `PLAYBACK_STATUS.buffered` |
| CPU / RAM | `adb shell top -m 5`, Android Studio Profiler (host), `chrome://tracing` (speaker) |
| Network bandwidth | Host: should stay flat as speakers increase (control frames only). CDN: ~filesize × speakers, once |
| Server | `/healthz` connection count, container CPU, Redis `INFO clients` |

Record results per device; deviations above ~100 ms audible drift usually point to
Wi‑Fi contention or a Bluetooth output device rather than the protocol.

## 5. Acceptance

The build passes when every item in section 2 passes on at least 10 real phones, the
scale test reaches the capacity you provisioned, and no hard-coded speaker maximum
appears anywhere:

```bash
grep -rn "MAX_SPEAKERS\s*=\s*[0-9]\|/ *10\b" --include=*.ts --include=*.tsx --include=*.kt .
```
