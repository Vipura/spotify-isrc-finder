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

export function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;
  
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  
  let matches = 0;
  let transpositions = 0;
  
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }
  
  if (matches === 0) return 0.0;
  
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (s1Matches[i]) {
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }
  }
  
  const jaro = ((matches / len1) + (matches / len2) + ((matches - transpositions / 2) / matches)) / 3.0;
  
  let prefix = 0;
  for (let i = 0; i < Math.min(len1, len2, 4); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  
  return jaro + prefix * 0.1 * (1.0 - jaro);
}

export function stringSimilarity(str1, str2) {
  if (str1 === str2) return 1.0;
  if (!str1 || !str2 || str1.length < 2 || str2.length < 2) return 0.0;
  const bigrams = (s) => {
    let bg = [];
    for (let i = 0; i < s.length - 1; i++) bg.push(s.substring(i, i+2));
    return bg;
  };
  const bg1 = bigrams(str1);
  const bg2 = bigrams(str2);
  const total = bg1.length + bg2.length;
  let intersection = 0;
  for (let i = 0; i < bg1.length; i++) {
    for (let j = 0; j < bg2.length; j++) {
      if (bg1[i] === bg2[j]) {
        intersection++;
        bg2[j] = null;
        break;
      }
    }
  }
  return (2.0 * intersection) / total;
}

export function generateSpellingVariants(q) {
  if (!q) return [];
  const variants = new Set();
  
  const rules = [
    [/w/g, 'v'], [/v/g, 'w'],
    [/th/g, 't'], [/t/g, 'th'],
    [/dh/g, 'd'], [/d/g, 'dh'],
    [/bh/g, 'b'], [/b/g, 'bh'],
    [/aa/g, 'a'], [/oo/g, 'u'], [/ee/g, 'i'],
    [/h\b/g, '']
  ];
  
  for (const [pattern, replacement] of rules) {
    const variant = q.replace(pattern, replacement);
    if (variant !== q) {
      variants.add(variant);
    }
  }
  
  let allReplaced = q;
  for (const [pattern, replacement] of rules) {
    if (pattern.toString().startsWith('/w/') || pattern.toString().startsWith('/v/')) continue; // Avoid toggling back and forth
    allReplaced = allReplaced.replace(pattern, replacement);
  }
  if (allReplaced !== q) variants.add(allReplaced);
  
  return Array.from(variants).slice(0, 3); // Max 3
}

export function scoreTrack(track, queryInfo) {
  const tTitle = cleanQuery(track.title);
  const tArtist = cleanQuery(track.artist);
  const { cleaned, splits } = queryInfo;
  
  let bestScore = 0;
  
  const scorePair = (t, a, qTitle, qArtist) => {
    const titleDice = stringSimilarity(t, qTitle);
    const artistDice = stringSimilarity(a, qArtist);
    const titleJaro = jaroWinkler(t, qTitle);
    
    // Combine Jaro and Dice for title
    const titleSim = titleDice * 0.4 + titleJaro * 0.6;
    return titleSim * 0.7 + artistDice * 0.3;
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

  // Exact match bonus
  if (splits.length > 0) {
    for (const split of splits) {
      if (tTitle === split.title && tArtist === split.artist) bestScore += 0.5;
      else if (tTitle === split.title) bestScore += 0.3;
      else if (tArtist === split.artist) bestScore += 0.15;
    }
  } else {
    if (tTitle === cleaned) bestScore += 0.4;
    else if (tTitle.includes(cleaned) || cleaned.includes(tTitle)) bestScore += 0.15;
    
    if (tArtist === cleaned) bestScore += 0.2;
    else if (tArtist.includes(cleaned) || cleaned.includes(tArtist)) bestScore += 0.1;
  }

  // Penalize unwanted versions unless explicitly in query
  const lowerTrackTitle = (track.title || '').toLowerCase();
  const lowerQuery = (cleaned || '').toLowerCase();
  const unwanted = ['remix', 'live', 'karaoke', 'cover', 'instrumental', 'acoustic', 'edit', 'tribute'];
  
  for (const word of unwanted) {
    if (lowerTrackTitle.includes(word) && !lowerQuery.includes(word)) {
      bestScore -= 0.3;
    }
  }
  
  return bestScore;
}

