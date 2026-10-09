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
    throw new Error(data.error?.message || (typeof data.error === 'object' ? JSON.stringify(data.error) : data.error) || `Error ${res.status}`);
  }
  return data;
}

async function apiSearch(q) {
  return await safeFetchJson(`${BASE}/api/search?q=${encodeURIComponent(q)}`);
}

async function apiISRC(trackId) {
  try {
    return await safeFetchJson(`${BASE}/api/isrc/${trackId}`);
  } catch (err) {
    if (err.message.includes('404')) throw new Error('Track not found on Spotify.');
    throw err;
  }
}

async function apiFeatured() {
  const data = await safeFetchJson(`${BASE}/api/featured`);
  return data.tracks || [];
}

async function apiArtistTopTracks(id) {
  const data = await safeFetchJson(`${BASE}/api/artists/${id}/top-tracks`);
  return data.tracks || [];
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

      // Backend resolves: Deezer (by ISRC) → iTunes (verified by title/artist/duration)
      try {
        const params = new URLSearchParams({
          isrc: track.isrc || '',
          title: track.name || '',
          artist: track.artists || '',
          duration: String(track.duration || ''),
        });
        const res = await fetch(`${BASE}/api/preview?${params}`);
        const data = await res.json();
        urlToPlay = data.previewUrl || null;
      } catch (err) {
        console.error("Preview fetch error:", err);
      }

      // Last resort: Spotify's own preview URL, if it has one
      if (!urlToPlay) urlToPlay = track.previewUrl || null;

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

// ─── Track Grid Card (Vertical - for Popular on Spotify) ──────────────
function TrackGridCard({ track, onPlay, onSave, isSaved }) {
  const [copied, setCopied] = useState(false);
  const [igCopied, setIgCopied] = useState(false);
  const [noPreviewMsg, setNoPreviewMsg] = useState(false);

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
          <button className={`tc-save-icon ${isSaved ? 'saved' : ''}`} onClick={() => onSave(track)} title={isSaved ? 'Remove from saved' : 'Save track'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </button>
        </div>

        {track.isrc && (
          <div className="tc-actions">
            <div className={`tc-isrc-badge ${copied ? 'copied' : ''}`} onClick={() => copyToClipboard(track.isrc, setCopied)} title="Copy ISRC">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {copied ? <polyline points="20 6 9 17 4 12"/> : <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>}
              </svg>
              <span>{track.isrc}</span>
            </div>
            
            <button className={`tc-ig-btn ${igCopied ? 'copied' : ''}`} onClick={() => copyToClipboard(`isrc:${track.isrc}`, setIgCopied)} title="Copy ISRC for Instagram">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
              <span>{igCopied ? '\u2713' : 'for IG'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Track List Card (Horizontal - for Search Results) ─────────────────
function TrackListCard({ track, onPlay, onSave, isSaved }) {
  const [copied, setCopied] = useState(false);
  const [igCopied, setIgCopied] = useState(false);

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
        {track.isrc && (
          <>
            <div className={`tl-isrc-badge ${copied ? 'copied' : ''}`} onClick={() => copyToClipboard(track.isrc, setCopied)} title="Copy ISRC">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {copied ? <polyline points="20 6 9 17 4 12"/> : <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>}
              </svg>
              <span>{track.isrc}</span>
            </div>
            
            <button className={`tl-btn tl-ig ${igCopied ? 'copied' : ''}`} onClick={() => copyToClipboard(`isrc:${track.isrc}`, setIgCopied)} title="Copy ISRC for Instagram">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
              <span className="tl-ig-label">{igCopied ? '\u2713' : 'for IG'}</span>
            </button>
          </>
        )}
        <button className={`tl-btn tl-save ${isSaved ? 'saved' : ''}`} onClick={() => onSave(track)} title={isSaved ? 'Remove from saved' : 'Save track'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
      </div>
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

// ─── Main App ─────────────────────────────────────────────────────────
export default function App() {
  const [query, setQuery]           = useState('');
  const debouncedQuery              = useDebounce(query, 500); // Live search delay
  
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
  const searchRef = useRef(null);

  // Load featured on mount
  useEffect(() => {
    setFeatLoading(true);
    apiFeatured()
      .then(setFeatured)
      .catch(err => console.error('Featured error:', err))
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

  // Live Search Effect
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setSearchResults(null);
      setSearchArtists([]);
      setError('');
      setArtistTopTracks(null); // Fix: Ensure Popular section comes back
      return;
    }
    
    // Don't auto-search if viewing artist top tracks (unless they modify the query)
    setArtistTopTracks(null);
    performSearch(debouncedQuery);
  }, [debouncedQuery]);

  const performSearch = async (searchStr) => {
    setError('');
    setLoading(true);
    setActiveTab('home');

    try {
      if (isSpotifyUrl(searchStr)) {
        const trackId = extractTrackId(searchStr);
        if (!trackId) throw new Error('Could not extract track ID from the Spotify URL.');
        const data = await apiISRC(trackId);
        const track = {
          id: data.id,
          name: data.name,
          artists: data.artists?.map(a => a.name).join(', '),
          album: data.album?.name,
          albumArt: data.album?.images?.[1]?.url || data.album?.images?.[0]?.url || null,
          previewUrl: data.preview_url,
          isrc: data.external_ids?.isrc || null,
          duration: data.duration_ms,
          spotifyUrl: data.external_urls?.spotify,
        };
        setSearchResults([track]);
        setSearchArtists([]);
      } else {
        const { tracks, artists } = await apiSearch(searchStr);
        setSearchResults(tracks);
        setSearchArtists(artists || []);
        if (tracks.length === 0 && artists.length === 0) setError('No results found. Try a different search term.');
      }
    } catch (err) {
      setError(err.message || 'An unexpected error occurred.');
      setSearchResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleArtistClick = async (artist) => {
    setError('');
    setLoading(true);
    setSearchArtists([]); // hide suggestions
    try {
      const tracks = await apiArtistTopTracks(artist.id);
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
        <div className="aurora-ribbon aurora-ribbon-1" />
        <div className="aurora-ribbon aurora-ribbon-2" />
      </div>

      <div className={`app-container ${nowPlaying ? 'has-player' : ''}`}>
        {/* Header */}
        <header className="app-header">
          <div className="app-logo-wrap">
            <img src="/logo.jpg" alt="ISRC Finder Logo" className="app-logo-img" />
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
          <button className="search-btn" disabled>
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
          {(displayTracks.length > 0 || (contentLayout === 'featured' && featLoading)) && (
            <div className="section-header mt-4">
              <h3 className="capitalize-first">{headingText}</h3>
            </div>
          )}

          {/* Empty State */}
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
      </div>

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
