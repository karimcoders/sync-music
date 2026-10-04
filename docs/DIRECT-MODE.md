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

## The chopping was the sync loop, not the network

Playback was decoded and gap-free and listeners still heard it break up. The
cause was embarrassing and worth recording: **the correction loop was
restarting playback 22 times in 20 seconds** (`tools/p2p-e2e.mjs` now counts
them — `window.__syncAudio.resyncs`). Each restart is sample-accurate and
fades in over 6 ms, but twice a second it is chopping.

Two mistakes fed it:

1. **Chasing jitter.** A phone's clock estimate wanders by tens of ms over
   Wi-Fi, and the loop corrected on raw readings. The error is now smoothed,
   and a restart needs a large error confirmed several times in a row with a
   minimum gap between corrections.
2. **`AudioContext.outputLatency` was read live and only applied to one side.**
   Chrome re-reports it as the hardware buffer breathes, so the target moved
   under us; and it was subtracted from the reported position but not added
   when scheduling the start, leaving every phone late by its own buffer
   size. It is now read once and applied to both.

The loop runs in two regimes: **settling** (the first 8 s after a start or a
join — converge fast, the clock estimate is young) and **steady** (correct
only above ~150 ms, confirmed three times, at most once every 6 s).

Measured after the change, 3 speakers: worst unexplained step between played
time and real time **14.7 ms** over 8 s, start spread 10.6 ms, 10.6 ms after
6 s, 12 ms after a host refresh, and **3 deliberate corrections** in the whole
run instead of 22. The e2e now fails if an unexplained step exceeds 30 ms or
if the loop restarts playback more than 4 times.

## Changing the song must change it on every phone

Reported symptom: switch track and one phone keeps playing the old song while
another plays the new one. It was a real bug, with two causes.

1. **The speaker ignored the track name on transport messages.** Every PLAY,
   SEEK, RESYNC and STATE carries a `trackId`, and the speaker never looked at
   it — so a phone that did not hold the new file simply played the file it
   had, at the new position. Now a mismatch stops the audio immediately
   (silence is correct, the wrong song is not), takes the file from this
   phone's own cache if it is there, and asks the host for it with
   `TRACK_WANT` if it is not.
2. **The prefetch hijacked playback.** The host pushes the whole playlist
   ahead of time so switching is instant; the speaker treated the last file to
   arrive as "the current track". The phone then showed one title while
   holding another song's bytes, and a later PLAY for that id looked like a
   match. An arriving file only becomes current if it is the one we were told
   to play — otherwise it is just cached.

New suite `tools/switch-e2e.mjs` loads two different tones, plays the first,
switches to the second and checks that every phone follows, keeps playing, and
stays in sync. Measured: **every phone followed the switch in 215–370 ms**,
spread on the new song under 100 ms.

Also in this pass: a late joiner and a phone recovering from a host refresh
now get two forced alignment checks (700 ms and 1700 ms after joining),
because the deliberately slow steady-state loop was leaving them behind for
far too long. Late-join spread fell from ~400 ms to ~150 ms, post-refresh to
~20 ms.

## Stuck on "Switching to the new song"

A real phone sat on that message forever. Three separate causes, all fixed:

1. **The host refused to resend.** It keeps a record of which files it has
   already pushed to each phone (including what the phone itself reported as
   cached). A `TRACK_WANT` from a phone that plainly does *not* have the file
   hit that record and was dropped silently. A want now forces the send and
   jumps the queue ahead of background prefetching.
2. **The phone asked once.** A single request can be lost while the channel is
   draining megabytes. It now repeats every 2.5 s until the file is arriving,
   and the screen shows `Getting the new song… NN%` instead of a frozen line.
3. **Restarting a transfer that was already running.** A want for a file
   already streaming is now ignored, because restarting it throws away
   everything sent so far and makes the wait longer.

Two more things found while chasing it, both worth having on their own:

* **One phone was being counted as several speakers.** A joining phone dials
  four room slots at once; more than one can open. The host now keys speakers
  by the device id in HELLO, drops the duplicates, and only counts a
  connection once it has introduced itself. Besides the wrong count, it was
  streaming each song to the same phone several times — bandwidth the real
  phones needed.
* **Silent connections are reaped** after 15 s without a reply (10 s if they
  never said HELLO). The room id is fixed and the broker is public, so stale
  entries do appear.

Note for anyone reading the e2e output: the room is deliberately one fixed
public id, so other people's phones — including the owner's — can be in the
room while the tests run. `p2p-e2e` therefore asserts *at least* N speakers.

Measured: switch followed by every phone in 265 ms; a phone that had lost the
file got it and caught up in 2.0 s; steady-state smoothness unchanged
(0 rough steps, worst 15 ms).

## A real mixer, and YouTube

### The mixer (`/#/mixer`)

Two independent channel strips — **MUSIC** and **VOICE** — because what makes
a voice clear (cut bass, lift mid) is the opposite of what makes music full.
Each strip is the same chain a hardware channel gives you, built from Web
Audio nodes and inserted in front of the speaker:

```
in → bass (low shelf 160 Hz) → mid (bell 1.2 kHz) → treble (high shelf 3.8 kHz)
   → echo send → delay + feedback → limiter → level → out
```

* **Level goes to 200 %**, which is real amplification, so a limiter sits
  after it and the screen reports how many dB it is holding back. Past that a
  phone speaker simply runs out of air — the app says so rather than
  pretending.
* **Echo** is a delay line with feedback (amount / time / repeats), i.e. a
  slap or hall you dial in — not a convolution of a real room.
* Presets: Flat, Bass, Vocal, Speech, Party, Hall, Slapback.
* **Mic test** on the VOICE strip shows this phone's own input level with a
  peak hold, monitored silently so the phone cannot howl.
* Settings are per phone and remembered, so the one with the tinny speaker
  keeps its own curve. They change the sound live, on that phone only.

Proven, not asserted: `tools/mixer-yt-e2e.mjs` pushes an 80 Hz tone through
the actual strip and measures the output with an analyser — bass at −12 dB vs
+12 dB differs by **22.2 dB**, and the settings survive a reload.

### YouTube (`Play from YouTube` on the host)

People search songs on YouTube, so this had to work. It does — but not the way
it might look.

**A web page cannot take the audio out of a YouTube player.** The player is a
sandboxed iframe, the stream is protected, and capturing it would break both
the browser's rules and YouTube's. So instead of moving the audio, the app
moves the **time**: the host paste a link, every phone opens that same video
itself, and each one is held to the same second on the host's clock.

Honest consequences, all of them stated in the UI too:

* every phone needs internet for this (a song file, by contrast, is handed
  out over the local link and then plays offline);
* alignment is coarser — YouTube's seek lands on a keyframe, so corrections
  only happen above 400 ms;
* a video whose owner disabled embedding, or that is age-restricted, cannot
  play here; the phone says which, instead of failing silently;
* ads are per phone and will pull that phone out of sync until they end;
* there is no in-app search, because that needs a YouTube API key and an
  account. The host screen links out to YouTube search so you can copy a link.

Measured live in `tools/mixer-yt-e2e.mjs`: two phones put on the same video,
playing, **35 ms apart**.

## Making a song change instant

Four separate things used to make switching a song slow, and all four are fixed.

1. **One send queue per phone, not one for everybody.** A single global queue
   meant a slow phone downloading a 9 MB file blocked every other phone behind
   it. Each phone now drains its own queue, with an *urgent* lane for the song
   that is actually playing and a background lane for the prefetch.
2. **Decode ahead.** The host sends a `NEXT_HINT` naming the next song; each
   phone decodes it quietly while the current one plays, so the switch is a
   pointer swap instead of one to two seconds of CPU. Honest cost: one extra
   decoded song in memory (~21 MB per minute of stereo audio), never more than
   one, dropped as soon as the hint changes.
3. **No stale decode.** Decoding and installing are now separate steps. If the
   song changes mid-decode the result is discarded, instead of overwriting the
   new song and leaving a phone showing one title while playing another.
4. **One IndexedDB connection, keys-only listing.** The cache used to open a
   fresh database connection for every read and write and never close any, and
   it read every saved song's bytes into memory just to list their ids on each
   connect.

Also: any message from a phone now counts as proof of life (a phone busy
receiving chunks could previously be reaped mid-transfer), re-sends only happen
when a track was sent but stayed unconfirmed for 10 s, and a repeated
`TRACK_WANT` joins the transfer already in flight instead of restarting it.

Measured after the change, two phones, local broker: every phone followed the
switch in **267 ms**, then played the new song **13 ms** apart; a phone whose
copy of the file was deleted got it back in **242 ms**.

### Two real bugs behind "the mixer does nothing" and "every phone plays a different song"

**The mixer only existed on one of the two playback paths.** A phone plays
either the decoded buffer (Web Audio) or, while a file is still arriving or
when the browser cannot decode it, the plain `<audio>` element. Only the first
went through the channel strip; the element talked straight to the loudspeaker,
so on a real phone the sliders often did nothing at all. The element is now
routed into the same strip with `createMediaElementSource`. One guard matters:
an element routed into Web Audio is silent while the context is suspended, so
it is only taken over once the context is actually running — the mixer can
never mute a phone.

**"The first file to arrive wins" decided which song a phone played.** The host
prefetches the whole playlist, and those files land in whatever order the
network gives them, so three phones could settle on three different songs. The
host names the current track in every transport message; that name is now the
only authority, and a phone with no instruction yet keeps the bytes and plays
nothing instead of guessing.

### Why phones took seconds to start, and what the transfer does now

Measured on the bench with three phones and a 5 MB song, the host could only
push about **one megabyte per second to a phone**, no matter how fast the link
was. Two self-inflicted limits caused it:

* every chunk slept 150 ms whenever a transport command had gone out in the
  last 300 ms — and with status traffic that was most of the time;
* back-pressure polled `bufferedAmount` every 40 ms against a 48 kB ceiling,
  which is itself a hard cap of roughly 1 MB/s.

Now the send loop waits on the data channel's own `bufferedamountlow` event
with a 128 kB ceiling, drops back to a 48 kB trickle for 300 ms around each
command (so PAUSE still never queues behind audio), and yields the main thread
every eight chunks so the clock replies and the audio callbacks are not
starved. A phone that notices a hole in a file now asks again after 0.8 s
instead of 2.5 s. Result on the bench: all three phones playing in about
**3 s instead of 6**, a song switch landing on every phone in **246 ms** with
**5.5 ms** between them, and a three-phone run of the full suite at **6.9 ms**
spread.

Honest about what is still not perfect: while a phone is receiving a file its
own main thread stalls on each arriving chunk, so its position reading is
noisy. Playback restarts are now suppressed for exactly that period (the rate
ramp handles it instead), but on a loaded machine a run can still show a
handful of corrections in the first seconds after a join, and a phone cannot
make any sound at all until the whole file has arrived.

## The cloud shortcut (what beatsync.gg does, without a new account)

beatsync.gg is fast at getting a song onto every device for one reason: the
file lives on object storage behind a CDN (Cloudflare R2), so every phone
downloads its own copy over plain HTTPS, in parallel. Their clock
synchronisation is the same NTP-style idea this project already uses.

Our bottleneck was never the clock — it was that the host phone had to upload
the SAME song once per speaker over WebRTC. Five phones meant five uploads out
of one phone's connection, which is what "Getting the new song… 51 %" was.

So the host can now park each song in a **GitHub branch** (`audio-cdn`) and
broadcast a `TRACK_URL`. Every phone fetches it from GitHub's servers at its
own full speed, caches it, and tells the host it has it — the host then skips
the phone-to-phone transfer for that phone entirely. It needs no new account:
the same GitHub login that hosts this site does the job. `raw.githubusercontent.com`
serves the file with `access-control-allow-origin: *` and byte ranges, which
is all a browser needs.

Measured on the bench, three phones, one 5 MB song, time from "song added" to
"this phone holds the song":

| | phone 1 | phone 2 | phone 3 | slowest |
|---|---|---|---|---|
| phone-to-phone only | 9 543 ms | 4 166 ms | 9 798 ms | **9 798 ms** |
| with the cloud copy | 3 236 ms | 3 304 ms | 4 606 ms | **4 606 ms** |

The gap widens with every extra phone: the phone-to-phone path divides one
uplink between them, the cloud path does not.

Honest limits, all of them:

* the songs become **public files at a public URL**. The repository is public,
  so anyone with the link can download them. Do not use it for anything
  private.
* it needs a GitHub token with write access to one repository. It is typed in
  on the host phone, stored in that phone's browser only, never committed,
  never sent to a speaker. Anyone who can unlock the host page on that phone
  can read it — use a token scoped to this one repository.
* the host still has to upload the song once, and GitHub's API takes base64,
  which makes that one upload about a third larger than the file.
* if there is no token, no network, or the upload fails, nothing breaks: the
  phone-to-phone transfer is still running underneath.
* `tools/cloud-e2e.mjs <url> [token]` reproduces the table above.

### One uplink, one job at a time

The first version of the cloud shortcut uploaded to GitHub *while* also
pushing the same megabytes to every speaker over WebRTC. Both halves were
competing for the same single uplink on the host phone, so both were slow.

Now, when cloud delivery is on, the host uploads once and stops there. The
phones fetch it themselves. A backstop runs a few seconds later: any phone
that still has not confirmed it holds the song — no internet, GitHub blocked,
upload failed — gets the file pushed to it the old way. Late, but certain.

Bench, three phones, 5 MB song, "added" → "phone holds it": typically
**2.5–3.5 s** per phone with one straggler at 6–8 s, against a 9.8 s slowest
before any of this work.

## The music does not stop to wait for a download

Until now, switching to a song a phone did not have yet made that phone go
silent and show "Getting the new song… 33 %" for as long as the transfer
took. That is a hole in the party, and it was avoidable: the song already
playing is a perfectly good thing to listen to until the new file is actually
there.

So a phone now keeps playing what it has, says so plainly ("New song is
downloading — this one keeps playing until it is ready"), and swaps the
moment the file lands. Nothing is thrown away before there is something to
replace it with, and while a stand-in is playing the drift loop leaves it
alone — correcting it onto the NEW song's timeline would seek it to a
meaningless position.

The host also shows what is happening instead of a spinner: real upload
percentage (measured from the request body going out, with a time estimate),
then how many phones have confirmed they hold the song.

`tools/nogap-e2e.mjs` is the proof. A speaker is playing, a second song is
added and selected, and the speaker is sampled every 250 ms:

```
✓ the first song is playing at 1.44s
  silent samples while the new song arrived: 2/24
✓ the music kept playing the whole time the new song was downloading
✓ playing after the switch at 5.61s
✓ the speaker came back playing after a refresh (7.32s)
```

The refresh check is in the same file because the two go together: after a
reload Android will not let a page make sound until it is touched once — that
is a browser rule no app can skip — but after that single tap the speaker
rejoins the song already in progress, at the right position.
