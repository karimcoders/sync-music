# Going live on `suger.sh`

I cannot push to your domain from here — I have no access to your DNS, your server, or
any hosting account. What I can (and did) do is make the deploy a single command, and
give you a public live URL you can test from real phones **right now**.

---

## A. Test it live right now (no server needed)

The whole system is already running in this workspace and the preview URL is public
HTTPS, so Android phones can use it immediately:

```
https://8080-<sandbox-id>.e2b.app/speaker
```

(that's the preview panel next to this chat — open it, then share the same URL to other
phones). A demo session "Demo Session" with a 3-second test tone is already seeded, so a
phone will discover the host automatically, with no code and no QR.

Caveat, honestly: this sandbox URL lives only as long as this workspace session. It is
for testing, not production.

## B. Deploy to `suger.sh` for real — 3 steps

You need a small VPS (Hetzner CX22 / DigitalOcean / Oracle free tier are all fine — 1 vCPU,
2 GB RAM comfortably handles a few thousand WebSocket speakers) and control of the
`suger.sh` DNS.

### 1. DNS

| Type | Name | Value |
|---|---|---|
| A | `@` | your server's public IPv4 |
| AAAA | `@` | your server's IPv6 (optional) |

Open ports **80** and **443**. Port 80 is required for the Let's Encrypt challenge.

### 2. Copy the project to the server and run one command

```bash
scp -r sync-music root@<server-ip>:/opt/
ssh root@<server-ip>
cd /opt/sync-music
sudo ./deploy/deploy.sh suger.sh
```

That script installs Docker if needed, generates `.env` with fresh random
`TOKEN_SECRET` / `AUDIO_URL_SECRET`, warns you if DNS doesn't point at the box, builds
the images, and starts **server + Redis + Caddy**. Caddy issues the TLS certificate
automatically, so you get `https://suger.sh` and `wss://suger.sh/ws` with no manual
certificate work.

When it finishes it prints:

```
==> live: https://suger.sh/speaker
```

### 3. Build the Host APK pointed at your domain

```bash
cd apps/host-android
./gradlew assembleRelease -PSYNC_BASE_URL=https://suger.sh
```

Install that APK on the one phone that will be the Host. Every other phone just opens
`https://suger.sh/speaker` in Chrome and taps **Enable Speaker**.

> Building the APK needs the Android SDK (Android Studio, or `sdkmanager` on a Linux
> box). This workspace has no Android toolchain, so I could not produce a signed APK
> here — the Gradle project is complete and ready to build.

## C. After it's up

```bash
./deploy/scale.sh 4          # 4 backend instances sharing sessions via Redis
docker compose logs -f server
curl https://suger.sh/healthz
node tools/loadtest.mjs --url https://suger.sh --speakers 100   # prove there is no cap
```

Raise capacity with `MAX_CONNECTIONS_PER_INSTANCE` in `.env` plus more instances — never
by introducing a product-level speaker limit.

For a big crowd, point `CDN_BASE_URL` at a CDN in front of the audio objects
(Cloudflare, BunnyCDN, CloudFront). Audio bandwidth — not the WebSocket traffic — is what
actually grows with the number of phones.

## D. If `suger.sh` isn't a domain you own

Tell me which it is and I'll adapt the config:

* **a PaaS** (Railway / Render / Fly.io): I'll add the platform manifest and drop Caddy,
  since those platforms terminate TLS themselves,
* **a domain you still need to register**: get it first, then step B works unchanged,
* **a subdomain** like `music.suger.sh`: just pass that to the script —
  `sudo ./deploy/deploy.sh music.suger.sh`.
