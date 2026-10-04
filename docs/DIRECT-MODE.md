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

## One permanent link, and the host plays too

Three changes asked for after testing on real phones:

1. **A single URL for everybody.** The room id is now the constant
   `syncmusic-main`, so the host always opens the same room and the speaker
   link is simply `…/#/speaker` — no code, no per-session URL. Share it once,
   or print the QR once, and it keeps working. Honest trade-off: the link is
   public (anyone who has it can join) and only one host tab can hold the room
   at a time; a second host sees *"Someone else already has the room open."*
2. **The host phone is a speaker too.** Its own audio element follows the exact
   same scheduled host-clock timeline as the others, with an **on/off toggle**
   in the player. The browser only allows it after a tap — the toggle and the
   PLAY button provide that.
3. **Why it stuttered, and what changed.**
   * Transfers are now **serialised**: the host has one uplink, so sending the
     file to three phones at once made all three slow *and* delayed the
     PLAY/PAUSE messages behind the saturated channel.
   * Chunks are 32 kB and the channel is kept under 128 kB of queued data, so
     control messages never sit behind megabytes of audio.
   * A phone that loses chunks used to stay silent for the whole song. It now
     spots the gap after 2.5 s and sends `TRACK_NEED` with exactly the missing
     indexes; the host re-sends only those.

Measured locally, 3 speakers: 22.9 ms spread including a late joiner, 2.9 ms
after a host refresh, and the host's own output within 50 ms of the speakers.

## Why "nothing changed" on a real phone — and the latency work

Two separate problems, both fixed:

1. **The phone was running an old build.** The service worker was cache-first
   for *everything*, including `index.html`, so a phone that had opened the
   site once kept that version for days. It is now network-first for HTML and
   cache-first only for Vite's content-hashed assets (which can never go
   stale), the old caches are deleted on activation, and the page reloads once
   when a new worker takes over. Every screen also prints `build <date time>`
   in the footer so you can check on the phone itself.
2. **Audible lag between phones.** Three changes:
   * The drift loop no longer waits for a *perfect* clock estimate; three
     samples are enough. Refusing to correct during the first seconds after a
     (re)connect was exactly when a phone drifted audibly away.
   * Above ~120 ms the speaker snaps to the timeline immediately instead of
     nudging `playbackRate` (which needs tens of seconds to close that gap).
   * Every device has its own audio output delay (decoder, mixer, Bluetooth) —
     50–250 ms apart, and no browser API reports it. The speaker page now has
     a **−/+ 20 ms fine-tune** (and a slider) that is remembered on that phone.
     If one phone still echoes, nudge it there; that is the honest fix, not a
     claim of perfect sync.

Room slots: the public broker can keep an id reserved after a host leaves, so
the single link now maps to a short ordered list of slots. The host takes the
first free one; a speaker dials all of them **in parallel** and keeps the first
that answers. The shared URL never changes. Also fixed: a losing duplicate
channel used to knock the live speaker off the host's list.

## Locked screens, the live microphone, and Sound Check

**Screen off.** A speaker now publishes Media Session metadata the moment it is
enabled, so Android treats the tab as real media playback instead of a
background page, and it takes a screen wake lock while it is visible. Coming
back from a locked screen it re-aligns with the timeline immediately. Honest
limits: the tab must stay open, and an aggressive battery saver or "close tabs
on sleep" setting can still stop it. The e2e suite now asserts that a hidden
page keeps playing.

**Live microphone.** The host can open its mic and talk to every speaker
(`MIC` in the player). It is a normal WebRTC audio track — a PA channel, not
part of the scheduled timeline — so expect roughly 100–250 ms over the
internet, and expect feedback if a speaker phone is near the host. Late joiners
are called in automatically; turning it off stops the stream everywhere.

**Sound Check** (`/#/sound`) measures with the phone's own microphone:

| Tool | What you get |
| --- | --- |
| Level | RMS and peak-hold in dBFS, with a clipping warning |
| Spectrum | Ten octave bands, 31 Hz – 16 kHz, live |
| A/B | Save a spectrum, change something, save another, see the difference per band |
| Hum | 50 / 60 / 100 Hz energy, i.e. mains hum |
| Dominant tone | The narrow ring that feedback sits on |
| Test tones | 40–4000 Hz out of this phone, plus a 31 Hz → 16 kHz sweep |
| Plain-language read | Boomy / dull / harsh / clipping / hum, in words |

What it is **not**: a calibrated SPL meter. The numbers are relative to the mic
input (dBFS), Android applies its own filtering, and the low end especially is
approximate. It is reliable for comparisons — before vs after, spot A vs spot
B, left vs right — which is what a sound check actually needs.

## Removed again: the host-driven clock-bias loop

A previous build had the host hand each speaker a correction for its own clock
estimate (`CLOCK_BIAS`). On paper it fixes an asymmetric relay; in practice it
made real phones **worse** — the host's latency estimate is noisy, the
correction chased that noise, and phones audibly wandered. It is gone. The
message is still accepted and ignored so an older host cannot upset a newer
speaker. Do not re-add it without measurements on real phones.

Two other things that matter for how it sounds, learned by measuring:

* **48 kB is the right amount of audio in flight.** Raising it to 256 kB
  measurably broke PAUSE — the command sat behind queued audio for about a
  second. 48 kB is still ~8 Mbit/s at a 50 ms round trip, so it costs nothing.
* **Four room slots, dialled together.** A phone that negotiates a dozen ICE
  sessions at once spends its CPU and radio on that instead of on smooth
  playback; four is enough to step over ids the broker is still holding.

## Black-and-white app shell, a microphone that actually plays, no more ticking

Three fixes after testing on a real phone:

1. **The live microphone was silent on Android.** The music element is unlocked
   by the ENABLE SPEAKER tap, but the microphone arrived later in its own,
   never-unlocked `<audio>` — and Android blocks that. The speaker now unlocks
   a second element inside the same tap and only swaps the stream into it
   later, retrying once on the next touch if the browser still refuses. The
   speaker also shows a pulsing **Host is speaking** banner so it is obvious.
2. **The stutter was our own correction loop.** A phone's clock estimate
   jitters, so a single bad sample above the 120 ms threshold caused a seek —
   and a seek is an audible tick. Repeated, that is the "ruk ruk". A seek now
   needs **three consecutive readings that agree**; in between the speaker
   leans on a ±2 % playback-rate nudge, which nobody can hear.
3. **The UI is a black-and-white phone app.** One flat palette (black, white,
   grey — brightness carries the meaning, which survives sunlight on a cheap
   screen), a bottom tab bar (PLAYER / SPEAKER / SOUND), large app-style
   titles, greyscale artwork and white transport controls.

## Low internet, and what "offline" can honestly mean

The goal is a command that lands on every phone at the same instant even when
one of them is on a terrible connection — and music that does not stop when a
phone drops off the network. Four mechanisms, all measured:

1. **The phone keeps the music.** Every song a speaker receives is stored in
   its own IndexedDB (`sync-music-speaker`). On the next connection it tells
   the host what it already holds (`HELLO.cached`, repeated in `STATUS`), and
   the host skips those transfers entirely. Measured: after a reload the song
   was ready again in **6–26 ms** with nothing sent over the network.
2. **The whole playlist is pushed ahead of time**, current song first, as soon
   as a phone connects or a song is added — so PLAY never waits for a
   download, however slow that phone is.
3. **Commands are sent three times** (0, 60, 220 ms). They are tiny and
   idempotent — a speaker ignores a `seq` it has already applied — so a lossy
   link stops being a lost command. Measured on a **2G-throttled phone**
   (60 kB/s, 300 ms latency): it started **17 ms** from the fast phone and
   PAUSE reached both within 1.5 s.
4. **Playback free-runs when the network dies.** The speaker holds the bytes
   and the timeline, so it keeps playing on its own clock, says *"Offline —
   playing from this phone"*, and re-syncs silently when it comes back.
   Measured: network cut for 6 s, playback continued and the phone reconnected
   by itself.

What is **not** possible, stated plainly:

* **The first connection needs the internet once.** WebRTC needs a rendezvous
  (signalling) server before two phones can find each other, and this build has
  no server of its own. After that handshake, if both phones are on the same
  Wi-Fi, traffic is local — the internet can drop and the room keeps working.
* **A phone that is offline from the start cannot join**, and one that is
  offline cannot receive a *new* song or a *new* command — it keeps doing the
  last thing it was told. There is no way around that without a local server
  on the network (`server/` in this repo does exactly that job over LAN).
* Nothing here is zero-latency. It is a few tens of milliseconds, measured and
  printed by `tools/p2p-e2e.mjs`, not a promise.

New suite: `node tools/offline-e2e.mjs <url>`.

## The controller is locked; guests only ever see the speaker

A guest who is handed the link must not be able to take the music over, so the
app now has two faces:

* **Home** shows one thing — *Join as a speaker* — plus the sound tools. There
  is no mention of the controller; the only way in is the small padlock in the
  corner.
* **`/#/host` asks for an id and a password.** First run on a phone accepts the
  shipped default (`admin` / `syncmusic`) and immediately makes the owner
  choose their own. Only a salted SHA-256 is stored, never the password.
* The bottom tab bar shows **PLAYER** only to a signed-in owner, and the player
  has a **Sign out** button.

Said plainly: this is a lock on the interface. The app is a static page, so a
determined person can read its code — it stops a guest at a party, it is not
security. The backend in `server/` is where a real token is checked on every
command.

The UI itself was redesigned around this: a single hero on Home, large
app-style titles, one white-on-black action per screen, and the bottom tab bar
for the three places you actually go.

## The stutter: why it was there and what replaced the player

Every measurement said the phones were together, and listeners still heard the
music catch and hiccup. The spread figure was measuring the wrong thing — the
problem was not *where* the phones were on the timeline but *how* the audio was
being produced.

An `<audio>` element is the wrong instrument for this job:

* the browser owns its buffering and can stall for tens of milliseconds when
  the decoder or the Wi-Fi radio hiccups;
* `play()` starts "soon", not at a stated instant, so every start was a guess;
* every `currentTime` write is a real seek — audible, and we were doing them to
  correct drift, i.e. the fix was producing the symptom;
* `playbackRate` nudges of ±2 % are a hearable pitch wobble.

So a complete track is now **decoded once into memory and played through Web
Audio** (`apps/speaker-web/src/lib/p2p/bufferPlayer.ts`):

* starts are scheduled on the audio hardware's own clock — sample-accurate,
  no `setTimeout`, no `play()` latency;
* nothing re-buffers mid-song, because there is nothing left to fetch;
* corrections above ~30 ms are an exact reschedule with a 6 ms fade in and out
  (no click); below that, an inaudible 0.3 % rate ramp;
* positions are reported in **audible** time: `AudioContext.outputLatency` is
  subtracted, so phones with different hardware buffers line up on what you
  hear rather than on what was queued.

The `<audio>` element is still there as a fallback for a format the browser
cannot decode and for a track that is still arriving, and the speaker switches
over seamlessly the moment the decode finishes.

Measured after the change (`tools/p2p-e2e.mjs`, 3 speakers): every speaker on
the decoded engine, **worst gap between played time and real time over 8 s:
25 ms** (this is the new stutter check — it samples playback against the wall
clock and fails on a stall), start spread 14 ms, and all previous checks
unchanged.

Honest limits: decoding holds the song as PCM, roughly 10 MB per minute, so a
very long track on a very old phone can be refused — that phone falls back to
the element. And no browser gives us the true speaker-to-air delay, so the
per-phone nudge in Settings is still the last word if one phone echoes.

## Two more changes: silence beats a stutter, and colour says what is happening

**The element never makes audible sound any more.** It stutters — that is why
the decoded player exists — so if a song has not finished decoding when PLAY
arrives, the phone now stays quiet and says *"Preparing the song on this
phone — it will join in a moment"*, then joins exactly on the timeline. A
short, honest wait instead of broken audio.

**A suspended AudioContext is silence, and Android suspends it** when the
screen goes off or the system takes audio focus. We now watch for that on
`visibilitychange`, on focus and every 2 s, resume it and land back on the
timeline.

**The UI is in colour again, and the colour is the status.** You cannot read a
status line from across a room, so the whole screen changes mood: cool indigo
when idle, teal once a phone is connected, violet→pink with a slow aurora
while music plays, amber/red when something needs attention. Cards are glass
over that gradient, the primary action is a gradient button, and the now
playing card breathes while audio is running.
