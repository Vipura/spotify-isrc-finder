async function getAccessToken(clientId, clientSecret) {
  const res = await fetch('http://localhost:3001/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to authenticate');
  return data.access_token;
}

function ResultCard({ track, isrc }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(isrc);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {}
  };
  return (
    <div className="result-section">
      <div className="result-card">
        <div className="result-card-inner">
          <TrackInfo track={track} />
          <div className="result-label">ISRC Code</div>
          <div className="isrc-display">{isrc}</div>
          <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy to Clipboard'}
          </button>
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

function SettingsPanel({ clientId, setClientId, clientSecret, setClientSecret }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-section">
      <button type="button" className="settings-toggle" onClick={() => setOpen(!open)}>
        <span className="settings-toggle-title">Spotify API Credentials</span>
      </button>
      <div className={`settings-body ${open ? 'open' : ''}`}>
        <div className="form-group">
          <label className="form-label" htmlFor="clientId">Client ID</label>
          <input className="form-input" id="clientId" type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="clientSecret">Client Secret</label>
          <input className="form-input" id="clientSecret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        </div>
      </div>
    </div>
  );
}

function extractTrackId(input) {
  const clean = input.trim();
  const urlMatch = clean.match(/track\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  const uriMatch = clean.match(/spotify:track:([a-zA-Z0-9]+)/);
  if (uriMatch) return uriMatch[1];
  if (/^[a-zA-Z0-9]{22}$/.test(clean)) return clean;
  return null;
}

import React, { useState } from 'react';
import './App.css';

export default function App() {
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
      </div>
    </div>
  );
}
