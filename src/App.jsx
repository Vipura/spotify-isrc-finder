import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

// ─── useDebounce Hook ─────────────────────────────────────────────────
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

// ─── localStorage helpers ─────────────────────────────────────────────
const LS_KEY = 'isrc_saved_tracks';
function getSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { return []; }
}
function setSaved(tracks) {
  localStorage.setItem(LS_KEY, JSON.stringify(tracks));
}

// ─── Popular-tracks cache (refreshed once every 4 days) ───────────────
const FEATURED_LS_KEY = 'isrc_featured_cache_v2';
const FEATURED_TTL_MS = 4 * 24 * 60 * 60 * 1000;
function readFeaturedCache() {
  try { return JSON.parse(localStorage.getItem(FEATURED_LS_KEY)); }
  catch { return null; }
}
function writeFeaturedCache(tracks, expiresAt) {
  try { localStorage.setItem(FEATURED_LS_KEY, JSON.stringify({ tracks, savedAt: Date.now(), expiresAt })); }
  catch { /* storage full/unavailable */ }
}

// ─── URL / Track ID helpers ───────────────────────────────────────────
function extractTrackId(input) {
  try {
    const parsed = new URL(input.trim());
    if (parsed.hostname === 'open.spotify.com') {
      const segs = parsed.pathname.split('/').filter(Boolean);
      if (segs.length >= 2 && segs[0] === 'track') return segs[1];
    }
  } catch { /* not a URL */ }
  const match = input.match(/track[/:]([a-zA-Z0-9]+)/);
  if (match?.[1]) return match[1];
  return null;
}

function isSpotifyUrl(input) {
  return /open\.spotify\.com\/track/.test(input) || /spotify:track:/.test(input);
}

// ─── API wrappers ─────────────────────────────────────────────────────
// Defaults to proxy (/api) if on same origin or localhost, with explicit fallback
const BASE = import.meta.env.VITE_API_BASE_URL !== undefined 
  ? import.meta.env.VITE_API_BASE_URL 
  : '';

async function safeFetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // If relative fetch failed or localhost:5173 proxy failed, try direct backend on port 3001
    if (url.startsWith('/api')) {
      try {
        res = await fetch(`http://localhost:3001${url}`);
      } catch (retryErr) {
        throw new Error('Unable to connect to backend server. Make sure server is running on port 3001.');
      }
    } else {
      throw err;
    }
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    // If Vite proxy returned index.html or 404/504 HTML page, try direct backend fallback
    if (url.startsWith('/api')) {
      try {
        const directRes = await fetch(`http://localhost:3001${url}`);
        const directType = directRes.headers.get('content-type') || '';
        if (directType.includes('application/json')) {
          const directData = await directRes.json();
          if (!directRes.ok) throw new Error(directData.error?.message || directData.error || `Error ${directRes.status}`);
          return directData;
        }
      } catch (e) {
        // continue to throw original error
      }
    }
    const text = await res.text();
    throw new Error(`Server returned non-JSON response (${res.status}). Ensure backend is active.`);
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error?.message || (typeof data.error === 'object' ? JSON.stringify(data.error) : data.error) || `Error ${res.status}`);
  }
  return data;
}

// Browser-side search cache: repeated searches cost 0 API calls for 24h
const SEARCH_LS_KEY = 'isrc_search_cache_v2';
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_MAX_ENTRIES = 40;
const normalizeQuery = (q) => q.trim().toLowerCase().replace(/\s+/g, ' ');
function readSearchCache() {
  try { return JSON.parse(localStorage.getItem(SEARCH_LS_KEY)) || {}; }
  catch { return {}; }
}
function writeSearchCache(cache) {
  try { localStorage.setItem(SEARCH_LS_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
}

// Backend track shape → the shape the UI (and previously saved tracks) use
function toUi(t) {
  return {
    id: t.id,
    name: t.title,
    artists: t.artist,
    album: t.album,
    albumArt: t.artwork || null,
    duration: t.duration,
    isrc: t.isrc || null,
    isrcSource: t.isrc ? t.source : null, // provider the ISRC came from
    spotifyUrl: t.spotifyUrl || null,
  };
}

async function apiSearch(q) {
  const key = normalizeQuery(q);
  const cache = readSearchCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.t < SEARCH_TTL_MS) return hit.d;

  const raw = await safeFetchJson(`${BASE}/api/search?q=${encodeURIComponent(key)}`);
  const data = {
    tracks: (raw.tracks || []).map(toUi),
    artists: (raw.artists || []).map(a => ({ id: a.id, name: a.name, imageUrl: a.imageUrl })),
  };

  cache[key] = { t: Date.now(), d: data };
  const keys = Object.keys(cache);
  if (keys.length > SEARCH_MAX_ENTRIES) {
    keys.sort((a, b) => cache[a].t - cache[b].t)
      .slice(0, keys.length - SEARCH_MAX_ENTRIES)
      .forEach(k => delete cache[k]);
  }
  writeSearchCache(cache);
  return data;
}

// Pasted Spotify link
async function apiISRC(trackId) {
  try {
    const data = await safeFetchJson(`${BASE}/api/isrc/${trackId}`);
    return toUi(data.track);
  } catch (err) {
    if (err.message.includes('404')) throw new Error('Track not found on Spotify.');
    throw err;
  }
}

const apiId = (id) => encodeURIComponent(/^(\d+|sp:.+)$/.test(String(id)) ? id : `sp:${id}`);

// Resolve the ISRC of a selected track (Deezer first, Spotify only as fallback)
async function apiTrack(id) {
  const data = await safeFetchJson(`${BASE}/api/track/${apiId(id)}`);
  return toUi(data.track);
}

async function apiAlternatives(id) {
  const data = await safeFetchJson(`${BASE}/api/track/${apiId(id)}/alternatives`);
  return (data.alternatives || []).map(toUi);
}

async function apiSpotifyCode(id) {
  const data = await safeFetchJson(`${BASE}/api/track/${apiId(id)}/spotify`);
  return { track: data.track ? toUi(data.track) : null, differs: Boolean(data.differs) };
}

function sendFeedback(isrc, source, result) {
  return fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isrc, source, result }),
  }).then(r => r.ok).catch(() => false);
}

async function apiFeatured() {
  const data = await safeFetchJson(`${BASE}/api/featured`);
  return { tracks: (data.tracks || []).map(toUi), expiresAt: data.expiresAt };
}

async function apiArtistTopTracks(id, name) {
  const url = name ? `${BASE}/api/artists/${id}/top-tracks?name=${encodeURIComponent(name)}` : `${BASE}/api/artists/${id}/top-tracks`;
  const data = await safeFetchJson(url);
  return (data.tracks || []).map(toUi);
}

// ─── Spotify Embed Player (bottom bar) ──────────────────────────────────
// Uses Spotify's official embed which plays 30s previews for free, no login needed
function MiniPlayer({ track, onClose }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadingAudio, setLoadingAudio] = useState(true);
  const [hasPreview, setHasPreview] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    let isCancelled = false;

    const loadAudio = async () => {
      setLoadingAudio(true);
      setHasPreview(false);
      let urlToPlay = null;

      // Backend resolves a fresh URL every play: Deezer preview first, then a strictly
      // verified iTunes match (title + artist + duration). Nothing unverified is played.
      try {
        const pid = /^(\d+|sp:.+)$/.test(String(track.id)) ? track.id : `sp:${track.id}`;
        const params = new URLSearchParams({
          title: track.name || '',
          artist: track.artists || '',
          duration: String(track.duration || ''),
        });
        const res = await fetch(`${BASE}/api/preview/${encodeURIComponent(pid)}?${params}`);
        const data = await res.json();
        urlToPlay = data.previewUrl || null;
      } catch (err) {
        console.error("Preview fetch error:", err);
      }

      if (isCancelled) return;

      if (urlToPlay) {
        setHasPreview(true);
        a.src = urlToPlay;
        a.play().then(() => {
          if (!isCancelled) {
            setPlaying(true);
            setLoadingAudio(false);
          }
        }).catch(err => {
          console.error("Play error:", err);
          if (!isCancelled) setLoadingAudio(false);
        });
      } else {
        setLoadingAudio(false);
      }
    };

    loadAudio();
    
    return () => {
      isCancelled = true;
      a.pause();
    };
  }, [track.id, track.previewUrl, track.name, track.artists]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setProgress(a.currentTime);
    const onDur  = () => setDuration(a.duration);
    const onEnd  = () => setPlaying(false);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onDur);
    a.addEventListener('ended', onEnd);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('durationchange', onDur);
      a.removeEventListener('ended', onEnd);
    };
  }, []);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a || !hasPreview) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play(); setPlaying(true); }
  };

  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    a.currentTime = ratio * duration;
  };

  const pct = duration ? (progress / duration) * 100 : 0;

  return (
    <div className="mini-player">
      <audio ref={audioRef} />
      <img className="mp-art" src={track.albumArt} alt={track.album} />
      <div className="mp-info">
        <div className="mp-name">{track.name}</div>
        <div className="mp-artist">{track.artists}</div>
        <div className="mp-badge">{loadingAudio ? 'Loading...' : (hasPreview ? 'Preview · 30s' : 'No Preview')}</div>
      </div>
      <div className="mp-controls">
        <button className="mp-play-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} disabled={loadingAudio || !hasPreview}>
          {playing ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" opacity={(loadingAudio || !hasPreview) ? 0.5 : 1}>
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          )}
        </button>
        <div className="mp-progress-wrap" onClick={seek}>
          <div className="mp-progress-bar">
            <div className="mp-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="mp-times">
            <span>{Math.floor(progress)}s</span>
            <span>{duration ? `${Math.floor(duration)}s` : (hasPreview ? '30s' : '')}</span>
          </div>
        </div>
      </div>
      <button className="mp-close" onClick={onClose} aria-label="Close player">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}

// ─── Copy helper ──────────────────────────────────────────────────────
const copyToClipboard = async (text, setCopied) => {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); }
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
};

// ─── ISRC on demand (search results carry no ISRC) ────────────────────
function useIsrc(track) {
  const [cur, setCur] = useState({ isrc: track.isrc || null, source: track.isrcSource || 'spotify' });
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState('');

  const getIsrc = useCallback(async () => {
    if (status === 'loading') return;
    setStatus('loading'); setError('');
    try {
      const t = await apiTrack(track.id);
      setCur({ isrc: t.isrc, source: t.isrcSource || 'deezer' });
      setStatus('idle');
    } catch (err) {
      setError(err.message || 'Please try again in a moment.');
      setStatus('error');
    }
  }, [track.id, status]);

  const setCode = useCallback((isrc, source) => setCur({ isrc, source }), []);
  return {
    isrc: cur.isrc, source: cur.source, status, error, getIsrc, setCode,
    track: cur.isrc ? { ...track, isrc: cur.isrc, isrcSource: cur.source } : track,
  };
}

function CopyChip({ text, label }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={`isrc-chip ${done ? 'copied' : ''}`} onClick={() => copyToClipboard(text, setDone)} title="Copy ISRC">
      {done ? '\u2713 Copied' : (label || text)}
    </button>
  );
}

const FB_KEY = 'isrc_feedback_given';
const readFb = () => { try { return JSON.parse(localStorage.getItem(FB_KEY)) || {}; } catch { return {}; } };
const fmtDur = (ms) => ms ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : '';
const srcLabel = (s) => (s === 'spotify' ? 'Spotify' : 'Deezer');

function IsrcExtras({ track, code }) {
  const [open, setOpen] = useState(false);
  const [alts, setAlts] = useState(null);
  const [altsState, setAltsState] = useState('idle');
  const [altCodes, setAltCodes] = useState({});
  const [sp, setSp] = useState(null);
  const [spState, setSpState] = useState('idle');
  const [msg, setMsg] = useState('');
  const [fbMap, setFbMap] = useState(readFb);
  const given = fbMap[code.isrc];

  const sendFb = async (result) => {
    const next = { ...fbMap, [code.isrc]: result };
    setFbMap(next);
    try { localStorage.setItem(FB_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    sendFeedback(code.isrc, code.source, result);
  };

  const loadAlts = async () => {
    setAltsState('loading'); setMsg('');
    try { setAlts(await apiAlternatives(track.id)); setAltsState('idle'); }
    catch (e) { setMsg(e.message); setAltsState('error'); }
  };
  const loadAltCode = async (alt) => {
    setAltCodes(m => ({ ...m, [alt.id]: { status: 'loading' } }));
    try {
      const t = await apiTrack(alt.id);
      setAltCodes(m => ({ ...m, [alt.id]: { status: 'ok', isrc: t.isrc, source: t.isrcSource || 'deezer' } }));
    } catch (e) {
      setAltCodes(m => ({ ...m, [alt.id]: { status: 'error', error: e.message } }));
    }
  };
  const loadSpotify = async () => {
    setSpState('loading'); setMsg('');
    try { setSp(await apiSpotifyCode(track.id)); setSpState('idle'); }
    catch (e) { setMsg(e.message); setSpState('error'); }
  };

  return (
    <div className="isrc-extra">
      <div className="isrc-extra-row">
        <span className="isrc-src">via {srcLabel(code.source)}</span>
        <button type="button" className="isrc-link" onClick={() => setOpen(o => !o)} aria-expanded={open}>Try another code</button>
        {given ? (
          <span className="fb-thanks">{given === 'worked' ? '\u2713 Thanks \u2014 glad it worked' : 'Thanks for the feedback'}</span>
        ) : (
          <span className="fb-group">
            <button type="button" className="fb-btn fb-yes" onClick={() => sendFb('worked')}>Worked on Instagram</button>
            <button type="button" className="fb-btn fb-no" onClick={() => sendFb('failed')}>Didn't work</button>
          </span>
        )}
      </div>

      {open && (
        <div className="isrc-more">
          <div className="isrc-more-actions">
            <button type="button" className="isrc-more-btn" onClick={loadAlts} disabled={altsState === 'loading' || alts !== null}>
              {altsState === 'loading' ? 'Loading\u2026' : 'Other versions'}
            </button>
            {code.source !== 'spotify' && (
              <button type="button" className="isrc-more-btn" onClick={loadSpotify} disabled={spState === 'loading' || sp !== null}>
                {spState === 'loading' ? 'Loading\u2026' : "Spotify's code"}
              </button>
            )}
          </div>
          {msg && <div className="isrc-note">{msg}</div>}

          {sp && (sp.track && sp.differs ? (
            <div className="isrc-alt">
              <div className="isrc-alt-info"><strong>Spotify's code</strong></div>
              <CopyChip text={sp.track.isrc} />
              <button type="button" className="isrc-link" onClick={() => code.setCode(sp.track.isrc, 'spotify')}>Use this</button>
            </div>
          ) : (
            <div className="isrc-note">{sp.track ? 'Spotify has the same code.' : 'Spotify has no different code for this track.'}</div>
          ))}

          {alts && alts.length === 0 && <div className="isrc-note">No other versions found.</div>}
          {alts && alts.map(alt => {
            const c = altCodes[alt.id];
            return (
              <div className="isrc-alt" key={alt.id}>
                <div className="isrc-alt-info">
                  <span className="isrc-alt-album">{alt.album || 'Single'}</span>
                  <span className="isrc-alt-dur">{fmtDur(alt.duration)}</span>
                </div>
                {c?.status === 'ok' ? (
                  <>
                    <CopyChip text={c.isrc} />
                    {c.isrc !== code.isrc && <button type="button" className="isrc-link" onClick={() => code.setCode(c.isrc, c.source)}>Use this</button>}
                  </>
                ) : (
                  <button type="button" className="isrc-more-btn" onClick={() => loadAltCode(alt)} disabled={c?.status === 'loading'}>
                    {c?.status === 'loading' ? '\u2026' : (c?.status === 'error' ? 'Retry' : 'Get code')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Track Grid Card (Vertical - for Popular on Spotify) ──────────────
function TrackGridCard({ track, onPlay, onSave, isSaved }) {
  const [copied, setCopied] = useState(false);
  const [igCopied, setIgCopied] = useState(false);
  const code = useIsrc(track);

  const handlePlay = () => {
    onPlay(track); // Spotify embed always works - no preview URL needed
  };

  return (
    <div className="track-grid-card glass-card">
      <div className="tc-art-wrap" onClick={handlePlay}>
        {track.albumArt
          ? <img className="tc-art" src={track.albumArt} alt={track.album} />
          : <div className="tc-art-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" opacity=".3"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
        }
        <div className="tc-play-overlay">
            <div className="tc-play-circle">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
            </div>
          </div>
      </div>

      <div className="tc-body">
        <div className="tc-header-row">
          <div className="tc-text-info">
            <div className="tc-name" title={track.name}>{track.name}</div>
            <div className="tc-artist" title={track.artists}>{track.artists}</div>
          </div>
          <button className={`tc-save-icon ${isSaved ? 'saved' : ''}`} onClick={() => onSave(code.track)} title={isSaved ? 'Remove from saved' : 'Save track'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </button>
        </div>

        {code.isrc ? (
          <div className="tc-actions">
            <div className={`tc-isrc-badge ${copied ? 'copied' : ''}`} onClick={() => copyToClipboard(code.isrc, setCopied)} title="Copy ISRC">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {copied ? <polyline points="20 6 9 17 4 12"/> : <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>}
              </svg>
              <span>{code.isrc}</span>
            </div>
            
            <button className={`tc-ig-btn ${igCopied ? 'copied' : ''}`} onClick={() => copyToClipboard(`isrc:${code.isrc}`, setIgCopied)} title="Copy ISRC for Instagram">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
              <span>{igCopied ? '\u2713' : 'for IG'}</span>
            </button>
          </div>
        ) : (
          <div className="tc-actions">
            <button type="button" className="get-isrc-btn" onClick={code.getIsrc} disabled={code.status === 'loading'}>
              {code.status === 'loading' ? 'Getting\u2026' : (code.status === 'error' ? 'Retry' : 'Get ISRC')}
            </button>
          </div>
        )}
        {code.status === 'error' && <div className="isrc-note">{code.error}</div>}
        {code.isrc && <IsrcExtras track={track} code={code} />}
      </div>
    </div>
  );
}

// ─── Track List Card (Horizontal - for Search Results) ─────────────────
function TrackListCard({ track, onPlay, onSave, isSaved }) {
  const [copied, setCopied] = useState(false);
  const [igCopied, setIgCopied] = useState(false);
  const code = useIsrc(track);

  return (
    <div className="track-list-card glass-list-card">
      <div className="tl-art-wrap" onClick={() => onPlay(track)}>
        {track.albumArt
          ? <img className="tl-art" src={track.albumArt} alt={track.album} />
          : <div className="tl-art-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" opacity=".3"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
        }
        <div className="tl-play-overlay">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
        </div>
      </div>

      <div className="tl-info">
        <div className="tl-name" title={track.name}>{track.name}</div>
        <div className="tl-artist" title={track.artists}>{track.artists}</div>
      </div>

      <div className="tl-actions">
        {code.isrc ? (
          <>
            <div className={`tl-isrc-badge ${copied ? 'copied' : ''}`} onClick={() => copyToClipboard(code.isrc, setCopied)} title="Copy ISRC">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {copied ? <polyline points="20 6 9 17 4 12"/> : <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>}
              </svg>
              <span>{code.isrc}</span>
            </div>
            
            <button className={`tl-btn tl-ig ${igCopied ? 'copied' : ''}`} onClick={() => copyToClipboard(`isrc:${code.isrc}`, setIgCopied)} title="Copy ISRC for Instagram">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
              <span className="tl-ig-label">{igCopied ? '\u2713' : 'for IG'}</span>
            </button>
          </>
        ) : (
          <button type="button" className="get-isrc-btn" onClick={code.getIsrc} disabled={code.status === 'loading'}>
            {code.status === 'loading' ? 'Getting\u2026' : (code.status === 'error' ? 'Retry' : 'Get ISRC')}
          </button>
        )}
        <button className={`tl-btn tl-save ${isSaved ? 'saved' : ''}`} onClick={() => onSave(code.track)} title={isSaved ? 'Remove from saved' : 'Save track'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
      </div>
      {code.status === 'error' && <div className="tl-extra isrc-note">{code.error}</div>}
      {code.isrc && <div className="tl-extra"><IsrcExtras track={track} code={code} /></div>}
    </div>
  );
}

// ─── Artist Bubble ────────────────────────────────────────────────────
function ArtistBubble({ artist, onClick }) {
  return (
    <div className="artist-bubble" onClick={() => onClick(artist)}>
      {artist.imageUrl ? (
        <img src={artist.imageUrl} alt={artist.name} className="artist-img" />
      ) : (
        <div className="artist-img-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
      )}
      <div className="artist-info">
        <div className="artist-name">{artist.name}</div>
        <div className="artist-label">Artist</div>
      </div>
    </div>
  );
}


// ─── About & How It Works ─────────────────────────────────────────────
function AboutSection() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="about-section">
      <button className="about-toggle" onClick={() => setIsOpen(!isOpen)} aria-expanded={isOpen}>
        <span>What is Spotify ISRC Finder?</span>
        <svg className={`toggle-icon ${isOpen ? 'open' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div className={`about-content ${isOpen ? 'open' : ''}`}>
        <p>Spotify ISRC Finder converts any Spotify track link into its unique International Standard Recording Code (ISRC). An ISRC is a song's digital fingerprint, allowing you to identify exact tracks across music platforms and social media without getting wrong remixes, covers, or duplicate releases.</p>
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="how-it-works">
      <h2 className="section-title">How It Works</h2>
      <div className="steps-container">
        {[
          { n: 1, h: 'Search Anything', p: 'Type a song name, artist name, or paste a Spotify track URL in the search bar.' },
          { n: 2, h: 'Preview & Pick', p: 'Browse results, play 30-second previews, and select the exact track you need.' },
          { n: 3, h: 'Copy ISRC', p: 'Click "Copy ISRC" for the raw code, or "For IG" to get isrc:CODE format for Instagram.' },
          { n: 4, h: 'Save Favourites', p: 'Hit the heart icon to save tracks to your browser — they persist across sessions.' },
        ].map(({ n, h, p }) => (
          <div key={n} className="step-card">
            <div className="step-number">{n}</div>
            <div className="step-content">
              <h3>{h}</h3>
              <p>{p}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Site Footer ──────────────────────────────────────────────────────
function SiteFooter({ onOpen }) {
  return (
    <footer className="app-footer">
      <div className="footer-links">
        <button type="button" className="footer-link" onClick={() => onOpen('terms')}>Terms of Use</button>
        <span className="footer-dot">•</span>
        <button type="button" className="footer-link" onClick={() => onOpen('privacy')}>Privacy Policy</button>
        <span className="footer-dot">•</span>
        <a className="footer-link" href="https://help.instagram.com/" target="_blank" rel="noopener noreferrer">Instagram Help</a>
      </div>
      <div className="footer-creator">
        <span className="footer-made">Made by <strong>Don Vipura</strong></span>
        <div className="footer-socials">
          <a className="social-btn social-ig" href="https://www.instagram.com/don_vipura/" target="_blank" rel="noopener noreferrer" aria-label="Instagram - don_vipura">
            <InstagramIcon />
          </a>
          <a className="social-btn social-gh" href="https://github.com/Vipura" target="_blank" rel="noopener noreferrer" aria-label="GitHub - Vipura">
            <GithubIcon />
          </a>
        </div>
      </div>
      <p className="footer-copyright">&copy; {new Date().getFullYear()} ISRC Finder. Not affiliated with Spotify or Instagram.</p>
    </footer>
  );
}

const InstagramIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
  </svg>
);
const GithubIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
  </svg>
);

// ─── Legal Pages ──────────────────────────────────────────────────────
const LEGAL = {
  terms: {
    title: 'Terms of Use',
    updated: 'October 2026',
    intro: 'Welcome to ISRC Finder for IG. By using this app you agree to the terms below. If you do not agree, please stop using the app.',
    sections: [
      { h: '1. What this app does', p: 'ISRC Finder for IG lets you search for songs on Spotify, preview short audio clips, and copy a track\'s ISRC (International Standard Recording Code) so you can find the exact recording on Instagram Music.' },
      { h: '2. Acceptable use', p: 'You agree to use the app only for lawful, personal purposes. You must not attempt to overload, scrape, reverse-engineer, disrupt, or abuse the app or its servers, or use it to infringe anyone\'s rights.' },
      { h: '3. Third-party services & content', p: 'Track data comes from Spotify, and audio previews may come from Deezer or Apple iTunes. All music, artwork, names and trademarks belong to their respective owners. Previews are short clips provided for identification only and are not a substitute for the full songs.' },
      { h: '4. No affiliation', p: 'ISRC Finder for IG is an independent project. It is not affiliated with, endorsed by, or sponsored by Spotify, Instagram, Meta, Deezer, or Apple.' },
      { h: '5. Accuracy & availability', p: 'ISRCs and previews are provided as returned by third-party services. We do not guarantee that they are complete, accurate, or that a track will be available on Instagram. The app is provided "as is" without warranties of any kind, and may change or be unavailable at any time.' },
      { h: '6. Limitation of liability', p: 'To the maximum extent permitted by law, the creator is not liable for any damages arising from your use of, or inability to use, the app.' },
      { h: '7. Changes to these terms', p: 'These terms may be updated from time to time. Continued use of the app after changes means you accept the updated terms.' },
      { h: '8. Contact', p: 'Questions? Reach out to Don Vipura on Instagram (@don_vipura) or GitHub (Vipura).' },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    updated: 'October 2026',
    intro: 'Your privacy matters. This app is designed to collect as little as possible. Here is exactly what happens with your data.',
    sections: [
      { h: '1. Information we collect', p: 'We do not require accounts and do not ask for your name, email, or any personal details. The search terms and links you enter are sent to our server only to fetch results from Spotify and preview providers.' },
      { h: '2. Saved tracks', p: 'Tracks you save with the heart icon are stored only in your own browser (localStorage) on your device. We never receive or store this list, and you can remove it any time by un-saving tracks or clearing your browser data.' },
      { h: '3. Third-party services', p: 'To work, the app communicates with Spotify (track search and ISRC data), Deezer and Apple iTunes (audio previews), and Google Fonts (typography). Their own privacy policies apply to data they receive, such as your IP address.' },
      { h: '4. Cookies & analytics', p: 'We do not use advertising cookies or tracking and we do not run analytics. A service worker caches app files so the installed app loads quickly and works like a shortcut.' },
      { h: '5. Server logs', p: 'Our hosting provider may keep standard technical logs (such as IP address and request time) for security and reliability. We do not use them to identify you.' },
      { h: '6. Children', p: 'The app is not directed at children under 13 and we do not knowingly collect data from them.' },
      { h: '7. Your choices', p: 'Because we hold no personal profile about you, there is nothing to delete on our side. Clear your browser storage to erase locally saved tracks, or uninstall the app to remove the shortcut.' },
      { h: '8. Changes & contact', p: 'We may update this policy and will change the date above when we do. For questions, contact Don Vipura on Instagram (@don_vipura).' },
    ],
  },
};

function LegalPage({ type, onBack }) {
  const doc = LEGAL[type];
  return (
    <div className="legal-page">
      <button className="legal-back" onClick={onBack}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        Back to ISRC Finder
      </button>
      <div className="legal-card">
        <h1 className="legal-title">{doc.title}</h1>
        <p className="legal-updated">Last updated: {doc.updated}</p>
        <p className="legal-intro">{doc.intro}</p>
        {doc.sections.map(s => (
          <section key={s.h} className="legal-section">
            <h2>{s.h}</h2>
            <p>{s.p}</p>
          </section>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────
export default function App() {
  const [query, setQuery]           = useState('');
  const debouncedQuery              = useDebounce(query, 500); // live search delay
  const lastQueryRef                = useRef('');
  const searchReqRef                = useRef(0);
  
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  
  const [searchResults, setSearchResults] = useState(null); // null means not searched
  const [searchArtists, setSearchArtists] = useState([]);
  
  const [artistTopTracks, setArtistTopTracks] = useState(null); // { artistName, tracks }
  
  const [featured, setFeatured]     = useState([]);
  const [featLoading, setFeatLoading] = useState(true);
  
  const [nowPlaying, setNowPlaying] = useState(null);
  const [saved, setSavedState]      = useState(getSaved);
  const [activeTab, setActiveTab]   = useState('home');     // 'home' | 'saved'
  const [view, setView]             = useState('main');     // 'main' | 'terms' | 'privacy'
  const searchRef = useRef(null);

  const openView = (v) => { setView(v); window.scrollTo({ top: 0 }); };

  const [installPrompt, setInstallPrompt] = useState(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(false);

  const isStandalone = typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);
  const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
  const canShowInstall = !installDismissed && !isStandalone && (installPrompt || isIos);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const handleInstallClick = () => {
    if (!installPrompt) { setShowIosHint(s => !s); return; }
    installPrompt.prompt();
    installPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') {
        setInstallPrompt(null);
      }
    });
  };

  // Popular section: serve from localStorage; hit the API only when the cache is >4 days old
  useEffect(() => {
    const cached = readFeaturedCache();
    const hasCache = cached?.tracks?.length > 0;
    if (hasCache) setFeatured(cached.tracks);
    const validUntil = cached?.expiresAt || (cached?.savedAt + FEATURED_TTL_MS);
    if (hasCache && Date.now() < validUntil) {
      setFeatLoading(false);
      return;
    }
    apiFeatured()
      .then(({ tracks, expiresAt }) => {
        if (tracks.length) { setFeatured(tracks); writeFeaturedCache(tracks, expiresAt); }
      })
      .catch(err => console.error('Featured error:', err)) // stale cache (if any) stays on screen
      .finally(() => setFeatLoading(false));
  }, []);

  // Save to localStorage whenever saved list changes
  useEffect(() => { setSaved(saved); }, [saved]);

  const isSaved = useCallback((id) => saved.some(t => t.id === id), [saved]);

  const toggleSave = useCallback((track) => {
    setSavedState(prev => {
      const exists = prev.some(t => t.id === track.id);
      const next = exists ? prev.filter(t => t.id !== track.id) : [track, ...prev];
      setSaved(next);
      return next;
    });
  }, []);

  // Clearing the input restores the Popular section (no API call)
  useEffect(() => {
    if (query.trim()) return;
    lastQueryRef.current = '';
    setSearchResults(null);
    setSearchArtists([]);
    setError('');
    setArtistTopTracks(null);
  }, [query]);

  // Live search: after a 500ms pause, only with 3+ characters (cached results cost nothing)
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (q.length < 3) return;
    if (normalizeQuery(q) === lastQueryRef.current) return;
    setArtistTopTracks(null);
    performSearch(q);
  }, [debouncedQuery]);

  // Enter / Search button searches immediately (skipped if that exact query already ran)
  const submitSearch = () => {
    const q = query.trim();
    if (q.length < 3 || normalizeQuery(q) === lastQueryRef.current) return;
    setArtistTopTracks(null);
    performSearch(q);
  };

  const performSearch = async (searchStr) => {
    const reqId = ++searchReqRef.current;
    lastQueryRef.current = normalizeQuery(searchStr);
    setError('');
    setLoading(true);
    setActiveTab('home');

    try {
      if (isSpotifyUrl(searchStr)) {
        const trackId = extractTrackId(searchStr);
        if (!trackId) throw new Error('Could not extract track ID from the Spotify URL.');
        const track = await apiISRC(trackId);
        if (reqId !== searchReqRef.current) return;
        setSearchResults([track]);
        setSearchArtists([]);
      } else {
        const { tracks, artists } = await apiSearch(searchStr);
        if (reqId !== searchReqRef.current) return;
        setSearchResults(tracks);
        setSearchArtists(artists || []);
        if (tracks.length === 0 && artists.length === 0) setError('No results found. Try a different search term.');
      }
    } catch (err) {
      if (reqId !== searchReqRef.current) return;
      lastQueryRef.current = ''; // allow retrying the same query
      setError(err.message || 'An unexpected error occurred.');
      setSearchResults([]);
    } finally {
      if (reqId === searchReqRef.current) setLoading(false);
    }
  };

  const handleArtistClick = async (artist) => {
    setError('');
    setLoading(true);
    setSearchArtists([]); // hide suggestions
    lastQueryRef.current = '';
    try {
      const tracks = await apiArtistTopTracks(artist.id, artist.name);
      setArtistTopTracks({ artistName: artist.name, tracks });
    } catch (err) {
      setError(err.message || 'Failed to load artist top tracks.');
    } finally {
      setLoading(false);
    }
  };

  const clearSearch = () => {
    setQuery(''); // triggers useEffect to clear everything
  };

  // Determine what to show
  let contentLayout = 'featured'; // 'featured' (grid) | 'results' (list) | 'saved' (list)
  let displayTracks = [];
  let headingText = '';

  if (activeTab === 'saved') {
    contentLayout = 'saved';
    displayTracks = saved;
    headingText = `Saved (${saved.length})`;
  } else if (artistTopTracks) {
    contentLayout = 'results';
    displayTracks = artistTopTracks.tracks;
    headingText = `Top songs by ${artistTopTracks.artistName}`;
  } else if (searchResults !== null) {
    contentLayout = 'results';
    displayTracks = searchResults;
    headingText = `Results (${searchResults.length} found)`;
  } else {
    contentLayout = 'featured';
    displayTracks = featured;
    headingText = 'Popular on Spotify';
  }

  return (
    <>
      {/* Ambient aurora background */}
      <div className="aurora-canvas" aria-hidden="true">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
        <div className="aurora-blob aurora-blob-4" />
        <div className="aurora-blob aurora-blob-5" />
        <div className="aurora-grain" />
      </div>

      {view !== 'main' ? (
      <div className={`app-container ${nowPlaying ? 'has-player' : ''}`}>
        <LegalPage type={view} onBack={() => openView('main')} />
        <SiteFooter onOpen={openView} />
      </div>
      ) : (
      <div className={`app-container ${nowPlaying ? 'has-player' : ''}`}>
        
        {/* Install Banner */}
        {canShowInstall && (
          <div className="install-banner" role="region" aria-label="Install app">
            <div className="install-row">
              <img src="/isrc-icon-192.png" alt="" className="install-icon" />
              <span className="install-text">Install the web app as a shortcut for quick access</span>
              <button className="install-btn" onClick={handleInstallClick}>{installPrompt ? 'Install' : 'How?'}</button>
              <button className="install-dismiss" onClick={() => setInstallDismissed(true)} aria-label="Dismiss">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            {showIosHint && !installPrompt && (
              <p className="install-hint">Tap the <strong>Share</strong> button in Safari, then choose <strong>Add to Home Screen</strong>.</p>
            )}
          </div>
        )}

        {/* Header */}
        <header className="app-header">
          <div className="app-logo-wrap">
            <img src="/isrc-icon-192.png" alt="ISRC Finder Logo" className="app-logo-img" />
          </div>
          <h1 className="app-title">ISRC Finder for IG</h1>
          <p className="app-subtitle">Search by song, artist, or Spotify link — preview, copy &amp; save</p>
        </header>

        {/* Search bar */}
        <div className="search-form" onSubmit={e => e.preventDefault()}>
          <div className="search-input-wrap">
            <input
              ref={searchRef}
              className="search-input"
              type="text"
              placeholder="Search song, artist, or paste Spotify link..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); submitSearch(); } }}
              enterKeyHint="search"
              onFocus={e => {
                if (window.innerWidth <= 768) {
                  const form = e.target.closest('.search-form');
                  setTimeout(() => form?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
                }
              }}
              autoComplete="off"
              spellCheck={false}
              id="searchInput"
            />
            {query && (
              <button type="button" className="search-clear" onClick={clearSearch} aria-label="Clear">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>
          <button type="button" className="search-btn" onClick={submitSearch} disabled={loading || query.trim().length < 3}>
            {loading ? <span className="spinner" /> : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Search</>}
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="error-banner">
            <span className="error-icon">⚠</span>
            <span className="error-text">{error}</span>
          </div>
        )}

        {/* Tabs */}
        <div className="tabs">
          <button className={`tab-btn ${activeTab === 'home' ? 'active' : ''}`} onClick={() => setActiveTab('home')}>
            Popular on Spotify
          </button>
          <button className={`tab-btn ${activeTab === 'saved' ? 'active' : ''}`} onClick={() => setActiveTab('saved')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill={saved.length ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '5px', verticalAlign: 'middle'}}>
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            Saved ({saved.length})
          </button>
        </div>

        {/* Dynamic Content Section */}
        <div className="content-section">
          
          {/* Artist Suggestions (Only show when searching and artists found) */}
          {activeTab === 'home' && searchArtists.length > 0 && !artistTopTracks && (
            <div className="suggestions-section">
              <div className="section-header">
                <h3>Suggestions</h3>
                <span className="section-hint">Tap an artist to see top songs</span>
              </div>
              <div className="artist-bubbles-row">
                {searchArtists.map(artist => (
                  <ArtistBubble key={artist.id} artist={artist} onClick={handleArtistClick} />
                ))}
              </div>
            </div>
          )}

          {/* Tracks Heading */}
          {(displayTracks.length > 0 || contentLayout === 'featured' || artistTopTracks) && (
            <div className="section-header mt-4">
              <h3 className="capitalize-first">{headingText}</h3>
            </div>
          )}

          {/* Empty State */}
          {artistTopTracks && displayTracks.length === 0 && (
            <div className="empty-state">
              <p>No top tracks found for this artist.</p>
            </div>
          )}
          {activeTab === 'saved' && saved.length === 0 && (
            <div className="empty-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".25">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
              <p>No saved tracks yet.</p>
              <p style={{fontSize:'0.8rem'}}>Hit the bookmark icon on any track to save it here.</p>
            </div>
          )}

          {/* Loading Skeletons for Featured */}
          {contentLayout === 'featured' && featLoading && (
            <div className="tracks-grid">
              {Array.from({length: 8}).map((_, i) => <div key={i} className="skeleton-card" />)}
            </div>
          )}

          {/* Tracks Display */}
          {displayTracks.length > 0 && (
            <div className={contentLayout === 'featured' ? 'tracks-grid' : 'tracks-list'}>
              {displayTracks.map(track => {
                if (contentLayout === 'featured') {
                  return <TrackGridCard key={track.id} track={track} onPlay={setNowPlaying} onSave={toggleSave} isSaved={isSaved(track.id)} />;
                } else {
                  return <TrackListCard key={track.id} track={track} onPlay={setNowPlaying} onSave={toggleSave} isSaved={isSaved(track.id)} />;
                }
              })}
            </div>
          )}
        </div>

        <AboutSection />
        <HowItWorks />

        <SiteFooter onOpen={openView} />
      </div>
      )}

      {/* Mini Player */}
      {nowPlaying && (
        <MiniPlayer
          track={nowPlaying}
          onClose={() => setNowPlaying(null)}
        />
      )}
    </>
  );
}
