import { config } from './config';
import { log } from './logger';

/**
 * Event layer used to fan session events out across backend instances.
 * - Single instance / local dev  -> in-process EventEmitter-like bus.
 * - Horizontal scaling          -> Redis Pub/Sub (REDIS_URL set).
 *
 * Each instance only owns the sockets physically connected to it; a command
 * published here reaches every instance participating in the session.
 */
export interface Bus {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: (payload: any) => void): Promise<void>;
  /** shared key/value for session state across instances (optional) */
  setJson(key: string, value: unknown, ttlMs: number): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  incr(key: string, by: number): Promise<number>;
  readonly kind: 'memory' | 'redis';
  close(): Promise<void>;
}

class MemoryBus implements Bus {
  readonly kind = 'memory' as const;
  private handlers = new Map<string, ((p: any) => void)[]>();
  private kv = new Map<string, { v: unknown; exp: number }>();
  private counters = new Map<string, number>();

  async publish(channel: string, payload: unknown) {
    for (const h of this.handlers.get(channel) ?? []) {
      try { h(payload); } catch (e) { log.error('bus handler failed', e); }
    }
  }
  async subscribe(channel: string, handler: (p: any) => void) {
    const arr = this.handlers.get(channel) ?? [];
    arr.push(handler);
    this.handlers.set(channel, arr);
  }
  async setJson(key: string, value: unknown, ttlMs: number) {
    this.kv.set(key, { v: value, exp: Date.now() + ttlMs });
  }
  async getJson<T>(key: string): Promise<T | null> {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) { this.kv.delete(key); return null; }
    return e.v as T;
  }
  async del(key: string) { this.kv.delete(key); }
  async keys(pattern: string) {
    const rx = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
    const now = Date.now();
    return [...this.kv.entries()].filter(([k, v]) => v.exp > now && rx.test(k)).map(([k]) => k);
  }
  async incr(key: string, by: number) {
    const v = (this.counters.get(key) ?? 0) + by;
    this.counters.set(key, v);
    return v;
  }
  async close() { /* nothing */ }
}

class RedisBus implements Bus {
  readonly kind = 'redis' as const;
  constructor(private pub: any, private sub: any) {
    this.sub.on('message', (ch: string, msg: string) => {
      const hs = this.handlers.get(ch);
      if (!hs) return;
      let payload: unknown;
      try { payload = JSON.parse(msg); } catch { return; }
      for (const h of hs) { try { h(payload); } catch (e) { log.error('bus handler failed', e); } }
    });
  }
  private handlers = new Map<string, ((p: any) => void)[]>();

  async publish(channel: string, payload: unknown) { await this.pub.publish(channel, JSON.stringify(payload)); }
  async subscribe(channel: string, handler: (p: any) => void) {
    const arr = this.handlers.get(channel) ?? [];
    if (arr.length === 0) await this.sub.subscribe(channel);
    arr.push(handler);
    this.handlers.set(channel, arr);
  }
  async setJson(key: string, value: unknown, ttlMs: number) {
    await this.pub.set(key, JSON.stringify(value), 'PX', Math.max(1000, ttlMs));
  }
  async getJson<T>(key: string) {
    const v = await this.pub.get(key);
    return v ? (JSON.parse(v) as T) : null;
  }
  async del(key: string) { await this.pub.del(key); }
  async keys(pattern: string) { return (await this.pub.keys(pattern)) as string[]; }
  async incr(key: string, by: number) { return (await this.pub.incrby(key, by)) as number; }
  async close() { await this.pub.quit().catch(() => {}); await this.sub.quit().catch(() => {}); }
}

export async function createBus(): Promise<Bus> {
  if (!config.redisUrl) {
    log.info('bus: in-memory (single instance). Set REDIS_URL to scale horizontally.');
    return new MemoryBus();
  }
  try {
    const { default: Redis } = await import('ioredis');
    const pub = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    const sub = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    pub.on('error', (e: Error) => log.error('redis pub error', e.message));
    sub.on('error', (e: Error) => log.error('redis sub error', e.message));
    log.info('bus: redis pub/sub enabled');
    return new RedisBus(pub, sub);
  } catch (e) {
    log.error('redis unavailable, falling back to in-memory bus', e);
    return new MemoryBus();
  }
}
