import { useState, useEffect } from 'react';
import './App.css';

// ─── Helpers ──────────────────────────────────────────────────────────

function extractTrackId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'open.spotify.com') {
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length >= 2 && segments[0] === 'track') {
        return segments[1];
      }
    }
  } catch {
    // fallback: spotify:track:ID or partial track/ID
    const match = url.match(/track[/:]([a-zA-Z0-9]+)/);
    if (match?.[1]) return match[1];
  }
  return null;
}

// ─── API calls (routed through Express backend proxy) ─────────────────

async function getAccessToken(clientId, clientSecret) {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Authentication failed. Check your API keys.');
  }
  return data.access_token;
}

async function getTrackData(trackId, token) {
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (res.status === 404) throw new Error('Track not found on Spotify.');
  if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch track data.');
  return data;
}

// ─── Components ───────────────────────────────────────────────────────

function SettingsPanel({ clientId, setClientId, clientSecret, setClientSecret }) {
  const [open, setOpen] = useState(!clientId || !clientSecret);
  const configured = clientId && clientSecret;

  return (
    <div className="settings-panel">
      <button className="settings-toggle" onClick={() => setOpen(!open)}>
        <span>
          <span className={`settings-dot ${configured ? 'configured' : 'missing'}`} />
          API Configuration
        </span>
        <span className={`toggle-icon ${open ? 'open' : ''}`}>▼</span>
      </button>
      <div className={`settings-content ${open ? 'open' : ''}`}>
        <div className="settings-fields">
          <div className="form-group">
            <label className="form-label" htmlFor="clientId">Client ID</label>
            <input
              className="form-input"
              id="clientId"
              type="text"
              placeholder="Paste your Spotify Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="clientSecret">Client Secret</label>
            <input
              className="form-input"
              id="clientSecret"
              type="password"
              placeholder="Paste your Client Secret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackInfo({ track }) {
  const albumArt = track.album?.images?.[1]?.url || track.album?.images?.[0]?.url;
  const artists = track.artists?.map((a) => a.name).join(', ');

  return (
    <div className="track-info">
      {albumArt && <img className="track-art" src={albumArt} alt="Album art" />}
      <div className="track-details">
        <div className="track-name">{track.name}</div>
        <div className="track-artist">{artists}</div>
      </div>
    </div>
  );
}

function ResultCard({ track, isrc }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(isrc);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = isrc;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="result-section">
      <div className="result-card">
        <div className="result-card-inner">
          <TrackInfo track={track} />
          <div className="result-label">ISRC Code</div>
          <div className="isrc-display">{isrc}</div>
          <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
            {copied ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                Copied!
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                Copy to Clipboard
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────

export default function App() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [trackUrl, setTrackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { track, isrc }

  // Persist credentials in localStorage
  useEffect(() => {
    setClientId(localStorage.getItem('spotifyClientId') || '');
    setClientSecret(localStorage.getItem('spotifyClientSecret') || '');
  }, []);

  useEffect(() => { localStorage.setItem('spotifyClientId', clientId); }, [clientId]);
  useEffect(() => { localStorage.setItem('spotifyClientSecret', clientSecret); }, [clientSecret]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setResult(null);

    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Please provide both your Client ID and Client Secret in the API Configuration above.');
      return;
    }
    if (!trackUrl.trim()) {
      setError('Please enter a Spotify track URL.');
      return;
    }

    const trackId = extractTrackId(trackUrl.trim());
    if (!trackId) {
      setError('Invalid URL — could not extract a track ID. Make sure the URL looks like https://open.spotify.com/track/...');
      return;
    }

    setLoading(true);
    try {
      const token = await getAccessToken(clientId.trim(), clientSecret.trim());
      const track = await getTrackData(trackId, token);
      const isrc = track?.external_ids?.isrc;
      if (!isrc) {
        setError('No ISRC found for this track in Spotify\'s response.');
        return;
      }
      setResult({ track, isrc });
    } catch (err) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-logo">
          <svg viewBox="0 0 24 24"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" /></svg>
        </div>
        <h1 className="app-title">ISRC Finder</h1>
        <p className="app-subtitle">Extract ISRC codes from Spotify tracks</p>
      </header>

      <div className="card">
        <form onSubmit={handleSubmit}>
          <SettingsPanel
            clientId={clientId}
            setClientId={setClientId}
            clientSecret={clientSecret}
            setClientSecret={setClientSecret}
          />

          <div className="url-section">
            <div className="form-group">
              <label className="form-label" htmlFor="trackUrl">Spotify Track URL</label>
              <div className="url-input-wrapper">
                <input
                  className="form-input"
                  id="trackUrl"
                  type="text"
                  placeholder="https://open.spotify.com/track/..."
                  value={trackUrl}
                  onChange={(e) => setTrackUrl(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="url-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                </span>
              </div>
            </div>
          </div>

          <button className="btn-primary" type="submit" disabled={loading}>
            <span className="btn-content">
              {loading && <span className="spinner" />}
              {loading ? 'Fetching...' : 'Find ISRC'}
            </span>
          </button>
        </form>

        {error && (
          <div className="error-banner">
            <span className="error-icon">⚠</span>
            <span className="error-text">{error}</span>
          </div>
        )}

        {result && <ResultCard track={result.track} isrc={result.isrc} />}
      </div>
    </div>
  );
}
