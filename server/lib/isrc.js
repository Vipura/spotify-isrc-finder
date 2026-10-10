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

export function cleanQuery(q) {
  let cleaned = (q || '').toLowerCase();
  cleaned = cleaned.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  cleaned = cleaned.replace(/\(.*?\)|\[.*?\]/g, ' ');
  cleaned = cleaned.replace(/\b(feat|ft|official|lyrics|audio)\b/g, ' ');
  cleaned = cleaned.replace(/[^\p{L}\p{N}\s\-]/gu, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

export function parseQuery(q) {
  const cleaned = cleanQuery(q);
  const splits = [];
  if (cleaned.includes(' - ')) {
    const parts = cleaned.split(' - ');
    if (parts.length >= 2) {
      splits.push({ artist: parts[0].trim(), title: parts.slice(1).join(' ').trim() });
      splits.push({ artist: parts.slice(1).join(' ').trim(), title: parts[0].trim() });
    }
  } else if (cleaned.includes(' by ')) {
    const parts = cleaned.split(' by ');
    if (parts.length >= 2) {
      splits.push({ artist: parts[1].trim(), title: parts[0].trim() });
    }
  }
  return { cleaned, splits };
}

export function stringSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const getBigrams = (str) => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.slice(i, i + 2));
    }
    return bigrams;
  };
  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);
  if (b1.size === 0 && b2.size === 0) return 1;
  if (b1.size === 0 || b2.size === 0) return 0;
  let intersection = 0;
  for (const b of b1) {
    if (b2.has(b)) intersection++;
  }
  return (2.0 * intersection) / (b1.size + b2.size);
}

export function scoreTrack(track, queryInfo) {
  const tTitle = cleanQuery(track.title);
  const tArtist = cleanQuery(track.artist);
  const { cleaned, splits } = queryInfo;
  
  let bestScore = 0;
  
  const scorePair = (t, a, qTitle, qArtist) => {
    const titleSim = stringSimilarity(t, qTitle);
    const artistSim = stringSimilarity(a, qArtist);
    return titleSim * 0.7 + artistSim * 0.3;
  };

  if (splits.length > 0) {
    for (const split of splits) {
      const s = scorePair(tTitle, tArtist, split.title, split.artist);
      if (s > bestScore) bestScore = s;
    }
  } else {
    const s1 = scorePair(tTitle, tArtist, cleaned, cleaned);
    const s2 = stringSimilarity(`${tTitle} ${tArtist}`, cleaned);
    const s3 = stringSimilarity(`${tArtist} ${tTitle}`, cleaned);
    bestScore = Math.max(s1, s2, s3);
  }

  if (splits.length > 0) {
    for (const split of splits) {
      if (tTitle === split.title && tArtist === split.artist) bestScore += 0.5;
      else if (tTitle === split.title) bestScore += 0.2;
      else if (tArtist === split.artist) bestScore += 0.1;
    }
  } else {
    if (tTitle === cleaned || tArtist === cleaned) bestScore += 0.2;
    if (cleaned.includes(tTitle)) bestScore += 0.1;
  }

  const lowerTrackTitle = (track.title || '').toLowerCase();
  const lowerQuery = (cleaned || '').toLowerCase();
  const unwanted = ['remix', 'live', 'karaoke', 'cover', 'instrumental', 'acoustic', 'edit'];
  
  for (const word of unwanted) {
    if (lowerTrackTitle.includes(word) && !lowerQuery.includes(word)) {
      bestScore -= 0.3;
    }
  }
  
  return bestScore;
}
