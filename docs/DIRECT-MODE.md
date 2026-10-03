# Direct mode — running with no server at all

Sync Music normally has a Node backend: it owns the clock, stores the audio and
fans messages out to every phone. **Direct mode replaces that backend with the
host's own browser tab.** The static web app alone is then enough, which is why
it can live on GitHub Pages (or any static host) and still work.

```
  normal mode                        direct mode
  host ──WebSocket──► server         host tab ──WebRTC data channel──► phone
  phone ─WebSocket──► server             │                        └──► phone
  audio ◄── CDN / server                 └── audio bytes are sent from the host
```

## What stays exactly the same

* NTP-style clock sync (T1–T4, offset from the lowest-RTT samples)
* playback scheduled against an absolute timestamp (`startAt`) on the authority's clock
* drift policy: <50 ms ignore · 50–150 ms `playbackRate` ±0.01 · >150 ms controlled seek
* one-tap **ENABLE SPEAKER** (Android autoplay policy is never bypassed)
* no maximum number of speakers is coded anywhere

## What is genuinely worse — read this before choosing it

| | Server mode | Direct mode |
|---|---|---|
| Host tab may close | yes, playback continues | **no — the host IS the server** |
| Audio delivery | once to a CDN, phones download in parallel | host uploads the file to **each** phone |
| Practical phone count | limited by the server | limited by the host phone's uplink and CPU (a handful on mobile data, more on good Wi-Fi) |
| First start after joining | fast | slower: the file transfer must finish first |
| Clock quality right after joining | good immediately (WebSocket) | poor for the first few seconds (fresh data channel) |

Because of that last row the host adds **2 extra seconds of lead** when a phone
joined less than 8 s ago, and each speaker **re-aligns itself** the moment its
clock estimate materially improves. Measured on this machine with 3 real
Chromium speakers: typically **4–30 ms apart after a few seconds**, but a phone
that joined seconds before PLAY can start up to ~0.5 s off and then snap in.
Server mode is tighter and more predictable — use it when you can.

## How it is chosen

1. `?mode=direct` or `?mode=server` in the URL wins.
2. A speaker link containing `?h=<room>` is always direct mode.
3. Otherwise the app pings `/healthz` on the configured backend (or the current
   origin). Backend answers → server mode; nothing answers → direct mode.

## Using it

1. Open the app (for example `https://karimcoders.github.io/sync-music/`) and tap
   **CONTROL THE MUSIC (HOST)**, then **CREATE SESSION**.
2. Pick an audio file. It never leaves your phone except to go to the speakers.
3. Share the **speaker link** shown on screen — it carries the room id, so there
   is still no code to type and nothing to scan.
4. Each phone opens it and taps **ENABLE SPEAKER** once.
5. Press **PLAY**.

The connection is brokered by the free public PeerJS server, which only
introduces the two browsers to each other; the audio and the control messages go
peer to peer and never touch it.

### Phones on different networks

Two phones on mobile data usually sit behind carrier-grade NAT, which blocks a
direct peer-to-peer path — the data channel then never opens. The app therefore
also offers the free public **OpenRelay TURN** servers, which relay the traffic
when no direct path exists. That costs a little extra latency but it connects.
If a speaker still cannot reach the host after ~12 s it now says so instead of
spinning forever; putting both phones on the same Wi-Fi or hotspot always works.

### Why it used to stutter, and why one phone stopped obeying

Two real bugs, both fixed:

* The track was handed to PeerJS as **one huge buffer**. That blocks the data
  channel for seconds, so control messages queued up behind the file and the
  audio stuttered. It is now streamed in **64 kB chunks paced against
  `bufferedAmount`**, which keeps the channel responsive while a file is being
  delivered.
* A message lost on one channel was lost **forever** — that is why only the
  phone that joined last seemed to react to pause/next. Every transport command
  now carries a monotonic `seq`; each speaker reports the last `seq` it applied
  and which track it actually holds, and the host **repairs anyone who is
  behind** with a full state snapshot (and re-sends the track if needed).

Measured after the fix, direct mode on one machine: 0.7 ms apart at start,
1.9 ms after six seconds, and a phone that joins mid-song lands 9.1 ms from the
others. A second pause reaches every phone, including the first one.

### Joining

Three ways, all equivalent: open the **link**, **scan the QR code** with the
in-app scanner (camera stays on the device), or type the **6-letter code**.

## Test it yourself

```bash
npm run build -w @sync-music/speaker-web
npx http-server apps/speaker-web/dist -p 9090   # any static server
node tools/p2p-e2e.mjs http://localhost:9090/ 3
```

This opens one real host tab and three real speaker tabs, plays a real file and
prints the measured spread.

## The host tab can now be refreshed

Until now a refresh of the host tab destroyed the room: the PeerJS id was
random and the uploaded audio only existed in that page's memory.

Now the host writes its room id to `localStorage` and the audio bytes to
IndexedDB (`sync-music` → `tracks`). On reload the page re-opens the **same**
PeerJS id and restores the playlist, so the speakers — which already retry with
backoff — come back on their own. Two details make it work in practice:

* The broker keeps the old registration alive for a few seconds, so
  `unavailable-id` right after a reload is retried (4 times, 1.5 s apart)
  instead of being reported as an error.
* The host no longer pushes the audio to a speaker on connect. It waits for the
  speaker's first `STATUS`, which reports `haveTrack`, and only sends the file
  if it is actually missing. A speaker that survived the refresh keeps playing
  from the blob it already has.
* Speakers run a liveness watchdog: the host answers every `PING`, so more than
  6 s of silence means the channel is dead even if PeerJS never fired `close`.

Measured locally, 3 speakers, 30 s tone, host refreshed mid-song: all speakers
reconnected, the playlist was restored, and playback resumed **14.8 ms** apart
(17.6 ms once the clocks had settled).
