# Spotify ISRC Finder 🎵

A sleek, modern React + Express web application to instantly find and extract the **ISRC (International Standard Recording Code)** from any Spotify track link or ID.

![ISRC Finder](src/assets/hero.png)

## ✨ Features
- **Instant ISRC Lookup**: Paste any Spotify song link (`https://open.spotify.com/track/...`), URI, or 22-character ID.
- **Glassmorphism UI**: Beautiful dark theme crafted with smooth gradients, responsive layout, and subtle micro-animations.
- **One-Click Copy**: Copy the ISRC code to clipboard with visual confirmation.
- **Metadata Card**: Displays album artwork, song title, and artist details.
- **Local Credential Storage**: Securely stores your Spotify Client ID and Client Secret in browser localStorage.
- **Corporate Proxy & Firewall Bypass**: Custom backend proxy powered by Undici ensures uninterrupted API calls.

## 🚀 Getting Started

### 1. Prerequisites
- Node.js (v18 or later)
- Spotify Developer Account (for Client ID & Secret)

### 2. Installation
```bash
npm install
```

### 3. Run Development Server
Start the Express backend and Vite frontend:
```bash
# Start backend server (Port 3001)
npm run server

# Start Vite frontend (Port 5173)
npm run dev
```

## 🛠️ Tech Stack
- **Frontend**: React 19, Vite, Vanilla CSS (Glassmorphism design)
- **Backend**: Express 5, CORS, Undici (Direct Dispatcher)
- **API**: Spotify Web API (Client Credentials Flow)

## 📄 License
MIT License
