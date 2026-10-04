# Spotify ISRC Finder 🎵

**Live App:** - https://isrccode.netlify.app

A lightweight web application that extracts the International Standard Recording Code (ISRC) from any Spotify track link. 

An ISRC is a song's digital fingerprint. Using this code allows you to pinpoint the exact studio version of a track across different music platforms and social media libraries, preventing you from accidentally selecting wrong remixes, covers, or live versions.

## ✨ Features
* **Instant Extraction:** Fetches the exact ISRC code securely via the Spotify Web API.
* **Dual Copy Options:** 
  * **Copy ISRC:** Copies the raw alphanumeric code (e.g., `USUM71702893`) for general use.
  * **Copy for Instagram:** Copies the code pre-formatted with the search operator (`isrc:USUM71702893`) to bypass Instagram's fuzzy text search and instantly find the exact audio clip for Stories, Reels, or Notes.
* **Modern UI:** Built with a dark theme inspired by Spotify's native design language.

## 🚀 How It Works
1. **Copy the Link:** Open Spotify, click **Share** on any track, and select **Copy Song Link**.
2. **Find the Code:** Paste the URL into the search bar at [isrccode.netlify.app](https://isrccode.netlify.app) and click **Find ISRC**.
3. **Choose Your Copy Option:** Click either the standard copy button or the dedicated Instagram copy button.
4. **Paste & Add to Content:** Open Instagram, navigate to the Music search bar on any post, story, or note, and paste the code. The exact track will instantly appear!

## 🛠 Tech Stack
* **Frontend:** React + Vite (Hosted on Netlify)
* **Backend:** Node.js (Hosted on Render)
* **Data Provider:** Spotify Web API (Client Credentials Flow)
