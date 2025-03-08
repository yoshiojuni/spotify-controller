const express = require('express');
const request = require('request');
const dotenv = require('dotenv');
const path = require('path');

const port = 8888;
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

app.get('/callback', function(req, res) {
  const code = req.query.code || null;

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: {
      code: code,
      redirect_uri: redirect_uri,
      grant_type: 'authorization_code'
    },
    headers: {
      'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64'))
    },
    json: true
  };

  request.post(authOptions, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      access_token = body.access_token;
      refresh_token = body.refresh_token;
      res.redirect('/#access_token=' + access_token);
    }
  });
});

app.get('/token', function(req, res) {
  res.json({ access_token: access_token });
});

app.get('/seek', function(req, res) {
  const position = req.query.position;
  const options = {
    url: 'https://api.spotify.com/v1/me/player/seek?position_ms=' + position,
    headers: { 'Authorization': 'Bearer ' + access_token },
    json: true
  };

  request.put(options, function(error, response, body) {
    if (!error && response.statusCode === 204) {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  });
});

app.get('/pause', function(req, res) {
  const options = {
    url: 'https://api.spotify.com/v1/me/player/pause',
    headers: { 'Authorization': 'Bearer ' + access_token },
    json: true
  };

  request.put(options, function(error, response, body) {
    if (!error && response.statusCode === 204) {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  });
});

app.get('/play', function(req, res) {
  const options = {
    url: 'https://api.spotify.com/v1/me/player/play',
    headers: { 'Authorization': 'Bearer ' + access_token },
    json: true
  };

  request.put(options, function(error, response, body) {
    if (!error && response.statusCode === 204) {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  });
});

app.get('/current-playback', function(req, res) {
  const options = {
    url: 'https://api.spotify.com/v1/me/player',
    headers: { 'Authorization': 'Bearer ' + access_token },
    json: true
  };

  request.get(options, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      res.json(body);
    } else {
      res.json({ error: 'Failed to get current playback state' });
    }
  });
});

console.log(`Listening on port ${port}`);
app.listen(port);
