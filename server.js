import express from 'express';
import cors from 'cors';
import { Agent, fetch as undiciFetch } from 'undici';

const app = express();
const PORT = 3001;

const directAgent = new Agent({ connect: { rejectUnauthorized: false } });
const directFetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: directAgent });

app.use(cors());
app.use(express.json());

app.post('/api/token', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret)
    return res.status(400).json({ error: 'Missing clientId or clientSecret' });
  try {
    const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await directFetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authString}`,
        'User-Agent': 'curl/8.4.0',
      },
      body: 'grant_type=client_credentials',
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/track/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
  try {
    const response = await directFetch(`https://api.spotify.com/v1/tracks/${req.params.id}`, {
      headers: { Authorization: authHeader }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Backend running at http://localhost:${PORT}`));
