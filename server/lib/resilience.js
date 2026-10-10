// ─── Resilience primitives: circuit breaker, throttle, stats ────────────
export class ProviderBlockedError extends Error {
  constructor(provider, retryInMs = 0) {
    super(`${provider} is temporarily blocked`);
    this.provider = provider;
    this.retryInMs = retryInMs;
  }
}
export class ProviderError extends Error {
  constructor(provider, detail = '') {
    super(`${provider} request failed ${detail}`.trim());
    this.provider = provider;
  }
}
export class ThrottledError extends Error {
  constructor(provider) {
    super(`${provider} throttled`);
    this.provider = provider;
  }
}
/** True for any "provider is unavailable right now" condition (not a user/data error). */
export const isProviderDown = (e) =>
  e instanceof ProviderBlockedError || e instanceof ProviderError || e instanceof ThrottledError;

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function parseRetryAfter(value, fallbackMs) {
  if (value === null || value === undefined || value === '') return fallbackMs;
  const n = Number(value);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return fallbackMs;
}

export class Breaker {
  constructor(name, { now = Date.now, threshold = 3, defaultCooldownMs = 60_000 } = {}) {
    this.name = name;
    this.now = now;
    this.threshold = threshold;
    this.defaultCooldownMs = defaultCooldownMs;
    this.failures = 0;
    this.blockedUntil = 0;
  }
  get blocked() { return this.now() < this.blockedUntil; }
  retryIn() { return Math.max(0, this.blockedUntil - this.now()); }
  assertOpen() { if (this.blocked) throw new ProviderBlockedError(this.name, this.retryIn()); }
  ok() { this.failures = 0; }
  fail() { if (++this.failures >= this.threshold) this.block(this.defaultCooldownMs); }
  block(ms) {
    this.blockedUntil = this.now() + Math.min(Math.max(ms, 1000), MAX_COOLDOWN_MS);
    this.failures = 0;
  }
  status() { return { blocked: this.blocked, retryInMs: this.retryIn(), consecutiveFailures: this.failures }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window limiter: at most `max` calls per `windowMs`. Delays briefly, else rejects. */
export class Throttle {
  constructor(name, max, windowMs, maxWaitMs, now = Date.now) {
    this.name = name; this.max = max; this.windowMs = windowMs; this.maxWaitMs = maxWaitMs; this.now = now;
    this.stamps = [];
  }
  async acquire() {
    const t = this.now();
    while (this.stamps.length && this.stamps[0] <= t - this.windowMs) this.stamps.shift();
    const slot = this.stamps.length >= this.max
      ? Math.max(t, this.stamps[this.stamps.length - this.max] + this.windowMs)
      : t;
    const wait = slot - t;
    if (wait > this.maxWaitMs) throw new ThrottledError(this.name);
    this.stamps.push(slot);
    if (wait > 0) await sleep(wait);
  }
}

export class Stats {
  constructor(data) {
    this.data = data || {
      since: new Date().toISOString(),
      calls: { deezer: { total: 0 }, spotify: { total: 0 }, itunes: { total: 0 } },
      cacheHits: { total: 0 },
    };
  }
  hit(provider, kind) {
    const c = this.data.calls[provider];
    c.total++;
    c[kind] = (c[kind] || 0) + 1;
  }
  cacheHit(kind) {
    this.data.cacheHits.total++;
    this.data.cacheHits[kind] = (this.data.cacheHits[kind] || 0) + 1;
  }
}
