// ─── ISRC validation + track matching helpers ───────────────────────────
export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/;

/** Trim + uppercase + validate. Returns the clean ISRC or null. */
export function normalizeIsrc(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  return ISRC_RE.test(s) ? s : null;
}

/** Normalise a title/artist for comparison (strips brackets, punctuation, case). */
export const norm = (s) => (s || '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ').trim();

export const MATCH_DURATION_MS = 3000;

export function durationClose(aMs, bMs, tolMs = MATCH_DURATION_MS) {
  return Math.abs((aMs || 0) - (bMs || 0)) <= tolMs;
}

/**
 * Does `candidate` (a Spotify-style track) match the reference track?
 * Requires equal normalised title, matching artist, and duration within 3s
 * (duration check is skipped only if the reference has no duration).
 */
export function matchesReference(candidate, ref) {
  if (!candidate || !ref) return false;
  if (norm(candidate.name) !== norm(ref.name)) return false;
  const wantArtist = norm(ref.mainArtist);
  const names = (candidate.artistList || []).map(norm);
  if (wantArtist && !names.some((n) => n === wantArtist || n.includes(wantArtist) || wantArtist.includes(n))) return false;
  if (ref.duration && !durationClose(candidate.duration, ref.duration)) return false;
  return true;
}
