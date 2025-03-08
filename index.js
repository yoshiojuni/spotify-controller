const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');

const port = process.env.PORT || 8888;
const app = express();

dotenv.config();

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;

app.use(express.static(path.join(__dirname, 'public')));

let access_token = null;
let refresh_token = null;

app.get('/login', function(req, res) {
  const scope = 'user-read-private user-read-email user-modify-playback-state user-read-playback-state';
  res.redirect('https://accounts.spotify.com/authorize?' +
    'response_type=code' +
    '&client_id=' + client_id +
    '&scope=' + encodeURIComponent(scope) +
    '&redirect_uri=' + encodeURIComponent(redirect_uri));
});

app.get('/callback', async function(req, res) {
  const code = req.query.code || null;

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64')),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      })
    });

    if (!response.ok) {
      throw new Error('Token request failed');
    }

    const data = await response.json();
    access_token = data.access_token;
    refresh_token = data.refresh_token;
    res.redirect('/#access_token=' + access_token);
  } catch (error) {
    console.error('Error in callback:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.get('/token', function(req, res) {
  if (!access_token) {
    res.status(401).json({ error: 'No access token available' });
    return;
  }
  res.json({ access_token: access_token });
});

app.get('/seek', async function(req, res) {
  if (!access_token) {
    res.status(401).json({ error: 'No access token available' });
    return;
  }

  const position = req.query.position;
  try {
    const response = await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${position}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });

    if (response.status === 204) {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (error) {
    console.error('Error in seek:', error);
    res.status(500).json({ error: 'Failed to seek' });
  }
});

app.get('/pause', async function(req, res) {
  if (!access_token) {
    res.status(401).json({ error: 'No access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });

    if (response.status === 204) {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (error) {
    console.error('Error in pause:', error);
    res.status(500).json({ error: 'Failed to pause' });
  }
});

app.get('/play', async function(req, res) {
  if (!access_token) {
    res.status(401).json({ error: 'No access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });

    if (response.status === 204) {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (error) {
    console.error('Error in play:', error);
    res.status(500).json({ error: 'Failed to play' });
  }
});

app.get('/current-playback', async function(req, res) {
  if (!access_token) {
    res.status(401).json({ error: 'No access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });

    if (response.ok) {
      const data = await response.json();
      res.json(data);
    } else {
      res.json({ error: 'Failed to get current playback state' });
    }
  } catch (error) {
    console.error('Error in current-playback:', error);
    res.status(500).json({ error: 'Failed to get playback state' });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = app;
