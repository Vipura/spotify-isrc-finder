import fs from 'fs';
import path from 'path';

// ─── APICache (extended from the original in-memory cache) ──────────────
// Same get/set API as before, plus: per-entry TTL, optional stale reads
// (used when every provider is blocked) and serialisation for persistence.
export class APICache {
  constructor(ttlMs, { maxEntries = 5000, now = Date.now } = {}) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }
  get(key, { stale = false } = {}) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (!stale && this.now() > item.expiry) return null;
    return item.data;
  }
  set(key, data, ttlMs = this.ttlMs) {
    this.cache.delete(key); // re-insert so eviction order = least recently written
    this.cache.set(key, { data, expiry: this.now() + ttlMs });
    while (this.cache.size > this.maxEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }
  toJSON() {
    const cutoff = this.now() - 2 * 24 * 60 * 60 * 1000; // drop entries long expired
    return [...this.cache.entries()].filter(([, v]) => v.expiry > cutoff);
  }
  load(entries) {
    for (const [k, v] of entries || []) this.cache.set(k, v);
  }
}

/**
 * Cache + counters + feedback, optionally persisted to one JSON file.
 * NOTE: on hosts with an ephemeral disk (e.g. Render free tier) the file is
 * lost on redeploy/spin-down; point DATA_FILE at a persistent disk to keep it.
 */
export function createStore({ file = null, now = Date.now } = {}) {
  const cache = new APICache(24 * 60 * 60 * 1000, { now });
  const state = { stats: null, feedback: { counts: {}, log: [] } };

  if (file && fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache.load(raw.cache);
      if (raw.state?.stats) state.stats = raw.state.stats;
      if (raw.state?.feedback) state.feedback = raw.state.feedback;
    } catch (e) {
      console.warn('Could not read store file, starting fresh:', e.message);
    }
  }

  let timer = null;
  const flush = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ cache, state }));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn('Store save failed:', e.message);
    }
  };
  const markDirty = () => {
    if (!file || timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, 5000);
    timer.unref?.();
  };

  return { cache, state, markDirty, flush };
}
