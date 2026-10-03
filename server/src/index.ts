import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocketPlugin from '@fastify/websocket';

import { config, assertProductionSecrets } from './config';
import { log } from './logger';
import { createBus } from './bus';
import { SessionHub } from './sessions';
import { attachSocket, resolveTracks } from './ws';
import { audioStore, publicAudioUrl } from './storage';
import { randomId, sanitizeFilename, signAudioPath, signToken, verifyAudioSignature, verifyToken } from './security';

async function main() {
  assertProductionSecrets();
  fs.mkdirSync(config.dataDir, { recursive: true });

  const bus = await createBus();
  const hub = new SessionHub(bus);

  const app = Fastify({ logger: false, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 });

  await app.register(cors, { origin: true, credentials: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
  await app.register(websocketPlugin, { options: { maxPayload: 64 * 1024 } });

  const requireHost = (req: any, sessionId: string) => {
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const t = verifyToken<{ sid: string; role: string }>(auth);
    return !!t && t.role === 'host' && t.sid === sessionId;
  };

  /* ------------------------------ health ------------------------------ */
  app.get('/healthz', async () => ({
    ok: true,
    instance: hub.instanceId,
    bus: bus.kind,
    connections: hub.connectionCount,
    maxConnectionsPerInstance: config.maxConnectionsPerInstance, // infra guard only
  }));

  /* ------------------------------ session ----------------------------- */
  app.post('/api/session/create', async (req, reply) => {
    if (hub.atCapacity()) {
      return reply.code(503).send({ error: 'Server is currently at capacity. Please try again later.' });
    }
    const body = (req.body ?? {}) as { name?: string };
    const rec = await hub.createSession(body.name ?? 'Music Session');
    return {
      sessionId: rec.sessionId,
      hostId: rec.hostId,
      name: rec.name,
      status: rec.status,
      createdAt: new Date(rec.createdAt).toISOString(),
      expiresAt: new Date(rec.expiresAt).toISOString(),
      // short-lived host credential; speakers never see it
      hostToken: signToken({ sid: rec.sessionId, role: 'host', hid: rec.hostId }, config.sessionTtlMs),
      speakerUrl: `${config.publicBaseUrl || ''}/speaker`,
      wsUrl: `${(config.publicBaseUrl || '').replace(/^http/, 'ws')}/ws`,
    };
  });

  /** Server-side session discovery — no QR, no PIN. */
  app.get('/api/session/active', async () => {
    const sessions = await hub.listActiveSessions();
    return { sessions, autoAttach: sessions.length === 1 ? sessions[0].sessionId : null };
  });

  app.get('/api/session/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ls = await hub.ensureLocal(id);
    if (!ls) return reply.code(404).send({ error: 'Host session ended.' });
    return {
      sessionId: id,
      name: ls.rec.name,
      speakerCount: await hub.speakerCount(id),
      transport: hub.reportableTransport(id),
      serverTime: Date.now(),
    };
  });

  app.post('/api/session/:id/speaker/join', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ls = await hub.ensureLocal(id);
    if (!ls) return reply.code(404).send({ error: 'Host session ended.' });
    const body = (req.body ?? {}) as { deviceId?: string };
    const deviceId = (body.deviceId ?? randomId(10)).slice(0, 64);
    // Authorization to open the speaker socket; anonymous + short lived.
    return {
      sessionId: id,
      deviceId,
      speakerAuth: signToken({ sid: id, role: 'speaker', did: deviceId }, config.sessionTtlMs),
      wsUrl: `${(config.publicBaseUrl || '').replace(/^http/, 'ws')}/ws`,
    };
  });

  app.post('/api/session/:id/speaker/leave', async (req) => ({ ok: true }));

  app.delete('/api/session/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireHost(req, id)) return reply.code(401).send({ error: 'Unauthorized' });
    await hub.endSession(id);
    return { ok: true };
  });

  /* ------------------------------- audio ------------------------------- */
  app.post('/api/audio/upload', async (req, reply) => {
    const sessionId = String((req.query as any)?.sessionId ?? '');
    if (!sessionId || !requireHost(req, sessionId)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: 'No file provided.' });

    const mime = String(file.mimetype || '').toLowerCase();
    if (!config.allowedAudioMime.includes(mime)) {
      return reply.code(415).send({ error: `Unsupported audio type: ${mime || 'unknown'}. Use MP3, AAC/M4A or WAV.` });
    }
    const id = randomId(14);
    const filename = sanitizeFilename(file.filename ?? 'audio');
    const dest = audioStore.filePath(id);
    try {
      await pipeline(file.file, fs.createWriteStream(dest));
    } catch (e) {
      await fs.promises.unlink(dest).catch(() => {});
      log.error('upload failed', e);
      return reply.code(500).send({ error: 'Upload failed. Please try again.' });
    }
    if ((file.file as any).truncated) {
      await fs.promises.unlink(dest).catch(() => {});
      return reply.code(413).send({ error: `File too large. Maximum ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.` });
    }
    const size = (await fs.promises.stat(dest)).size;
    const fields: any = file.fields ?? {};
    const title = String(fields.title?.value ?? filename.replace(/\.[^.]+$/, '')).slice(0, 120);
    const artist = String(fields.artist?.value ?? 'Unknown artist').slice(0, 120);
    const duration = Number(fields.duration?.value ?? 0) || 0;

    await audioStore.put(id, { id, title, artist, filename, mimeType: mime, size, duration, createdAt: Date.now() });
    const url = publicAudioUrl(signAudioPath(id), `${req.protocol}://${req.hostname}`);
    return { id, title, artist, filename, mimeType: mime, size, duration, url };
  });

  app.get('/api/audio', async (req, reply) => {
    const sessionId = String((req.query as any)?.sessionId ?? '');
    if (!sessionId || !requireHost(req, sessionId)) return reply.code(401).send({ error: 'Unauthorized' });
    return {
      tracks: audioStore.list().map((m) => ({ ...m, url: publicAudioUrl(signAudioPath(m.id), `${req.protocol}://${req.hostname}`) })),
    };
  });

  /** Signed, range-capable audio delivery (replace with S3/CDN in production). */
  app.get('/api/audio/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { exp?: string; sig?: string };
    if (!verifyAudioSignature(id, q.exp, q.sig)) {
      return reply.code(403).send({ error: 'Audio link expired. Ask the host to resend.' });
    }
    const meta = audioStore.get(id);
    if (!meta || !audioStore.exists(id)) return reply.code(404).send({ error: 'Audio could not be loaded.' });

    const file = audioStore.filePath(id);
    const size = fs.statSync(file).size;
    const range = req.headers.range;
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', meta.mimeType);
    reply.header('Cache-Control', 'public, max-age=86400, immutable');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (start >= size || start > end) {
          return reply.code(416).header('Content-Range', `bytes */${size}`).send();
        }
        return reply.code(206)
          .header('Content-Range', `bytes ${start}-${end}/${size}`)
          .header('Content-Length', end - start + 1)
          .send(fs.createReadStream(file, { start, end }));
      }
    }
    return reply.header('Content-Length', size).send(fs.createReadStream(file));
  });

  /* ---------------------------- playlist REST --------------------------- */
  app.post('/api/session/:id/playlist', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireHost(req, id)) return reply.code(401).send({ error: 'Unauthorized' });
    const body = (req.body ?? {}) as { trackIds?: string[] };
    const tracks = resolveTracks(body.trackIds ?? []);
    await hub.setPlaylist(id, tracks);
    return { playlist: tracks };
  });

  /* ------------------------------ websocket ----------------------------- */
  app.get('/ws', { websocket: true }, (socket) => attachSocket(hub, socket as any));

  /* ------------------------- speaker web (optional) --------------------- */
  if (config.serveWeb && fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDir), prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.type('text/html').sendFile('index.html');
    });
    log.info(`serving speaker web app from ${config.webDir}`);
  }

  await app.listen({ host: config.host, port: config.port });
  log.info(`sync-music server on http://${config.host}:${config.port} (instance ${hub.instanceId}, bus ${bus.kind})`);
  log.info(`infrastructure guard MAX_CONNECTIONS_PER_INSTANCE=${config.maxConnectionsPerInstance} (not a product speaker limit)`);
}

main().catch((e) => { log.error('fatal', e); process.exit(1); });
