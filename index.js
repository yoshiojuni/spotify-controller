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

console.log('Environment configuration:');
console.log('CLIENT_ID:', client_id ? '設定済み' : '未設定');
console.log('CLIENT_SECRET:', client_secret ? '設定済み' : '未設定');
console.log('REDIRECT_URI:', redirect_uri);

app.use(express.static(path.join(__dirname, 'public')));

// セッション管理（サーバーメモリ内）
const sessions = {};

app.get('/login', function(req, res) {
  console.log('Login route accessed');
  // セッションIDを生成
  const sessionId = generateSessionId();
  
  // セッションを初期化
  sessions[sessionId] = {
    created: Date.now()
  };
  
  const scope = 'user-read-private user-read-email user-modify-playback-state user-read-playback-state';
  const loginUrl = 'https://accounts.spotify.com/authorize?' +
    'response_type=code' +
    '&client_id=' + client_id +
    '&scope=' + encodeURIComponent(scope) +
    '&redirect_uri=' + encodeURIComponent(redirect_uri) +
    '&state=' + sessionId;
  
  console.log('Redirecting to:', loginUrl);
  res.redirect(loginUrl);
});

app.get('/callback', async function(req, res) {
  console.log('Callback route accessed');
  const code = req.query.code || null;
  const error = req.query.error || null;
  const state = req.query.state || null;

  if (error) {
    console.error('Error in callback:', error);
    return res.status(500).json({ error: `Authentication error: ${error}` });
  }

  if (!code) {
    console.error('No code received in callback');
    return res.status(400).json({ error: 'No code provided' });
  }
  
  // セッションの検証
  if (!state || !sessions[state]) {
    console.error('Invalid session state');
    return res.status(400).json({ error: 'Invalid session state' });
  }

  console.log('Received authorization code');

  try {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const authorization = 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64');
    
    console.log('Requesting access token...');
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Token request failed:', response.status, errorData);
      throw new Error(`Token request failed: ${response.status} ${errorData}`);
    }

    const data = await response.json();
    console.log('Token received successfully');
    
    // セッションにトークン情報を保存
    sessions[state].access_token = data.access_token;
    sessions[state].refresh_token = data.refresh_token;
    sessions[state].token_expiry = Date.now() + (data.expires_in * 1000);
    sessions[state].last_used = Date.now();
    
    // クライアントにセッションIDとアクセストークンを返す
    res.redirect(`/#session_id=${state}&access_token=${data.access_token}`);
  } catch (error) {
    console.error('Error in callback:', error);
    res.status(500).json({ error: 'Authentication failed: ' + error.message });
  }
});

// トークンを更新する関数
async function refreshAccessToken(sessionId) {
  if (!sessionId || !sessions[sessionId] || !sessions[sessionId].refresh_token) {
    console.error('No refresh token available for session:', sessionId);
    return false;
  }

  try {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const authorization = 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64');
    
    console.log('Refreshing access token for session:', sessionId);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        refresh_token: sessions[sessionId].refresh_token,
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Token refresh failed:', response.status, errorData);
      return false;
    }

    const data = await response.json();
    console.log('Token refreshed successfully for session:', sessionId);
    
    sessions[sessionId].access_token = data.access_token;
    if (data.refresh_token) {
      sessions[sessionId].refresh_token = data.refresh_token;
    }
    sessions[sessionId].token_expiry = Date.now() + (data.expires_in * 1000);
    sessions[sessionId].last_used = Date.now();
    
    return sessions[sessionId].access_token;
  } catch (error) {
    console.error('Error refreshing token:', error);
    return false;
  }
}

// トークンが有効かチェックし、必要に応じて更新する
async function ensureValidToken(sessionId) {
  if (!sessionId || !sessions[sessionId]) {
    return null;
  }

  // セッションの最終使用時間を更新
  sessions[sessionId].last_used = Date.now();

  // トークンの有効期限が切れている場合、または切れる30秒前の場合は更新
  if (!sessions[sessionId].token_expiry || Date.now() > sessions[sessionId].token_expiry - 30000) {
    const newToken = await refreshAccessToken(sessionId);
    return newToken;
  }

  return sessions[sessionId].access_token;
}

app.get('/token', async function(req, res) {
  const sessionId = req.query.session_id;
  
  if (!sessionId || !sessions[sessionId]) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  // トークンが有効期限切れの場合は更新
  const token = await ensureValidToken(sessionId);
  if (!token) {
    res.status(401).json({ error: 'Failed to refresh token' });
    return;
  }

  res.json({ access_token: token });
});

app.get('/seek', async function(req, res) {
  const sessionId = req.query.session_id;
  const position = req.query.position;
  
  const token = await ensureValidToken(sessionId);
  if (!token) {
    res.status(401).json({ error: 'No valid access token available' });
    return;
  }

  try {
    const response = await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${position}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204) {
      res.json({ success: true });
    } else if (response.status === 401) {
      // トークンが無効な場合は更新を試みる
      const newToken = await refreshAccessToken(sessionId);
      if (newToken) {
        // 再試行
        const retryResponse = await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${position}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${newToken}`
          }
        });
        
        if (retryResponse.status === 204) {
          res.json({ success: true });
        } else {
          const errorData = await retryResponse.text();
          res.json({ success: false, error: errorData });
        }
      } else {
        res.status(401).json({ error: 'Failed to refresh token' });
      }
    } else {
      const errorData = await response.text();
      res.json({ success: false, error: errorData });
    }
  } catch (error) {
    console.error('Error in seek:', error);
    res.status(500).json({ error: 'Failed to seek: ' + error.message });
  }
});

app.get('/pause', async function(req, res) {
  const sessionId = req.query.session_id;
  
  const token = await ensureValidToken(sessionId);
  if (!token) {
    res.status(401).json({ error: 'No valid access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204) {
      res.json({ success: true });
    } else if (response.status === 401) {
      // トークンが無効な場合は更新を試みる
      const newToken = await refreshAccessToken(sessionId);
      if (newToken) {
        // 再試行
        const retryResponse = await fetch('https://api.spotify.com/v1/me/player/pause', {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${newToken}`
          }
        });
        
        if (retryResponse.status === 204) {
          res.json({ success: true });
        } else {
          const errorData = await retryResponse.text();
          res.json({ success: false, error: errorData });
        }
      } else {
        res.status(401).json({ error: 'Failed to refresh token' });
      }
    } else {
      const errorData = await response.text();
      res.json({ success: false, error: errorData });
    }
  } catch (error) {
    console.error('Error in pause:', error);
    res.status(500).json({ error: 'Failed to pause: ' + error.message });
  }
});

app.get('/play', async function(req, res) {
  const sessionId = req.query.session_id;
  
  const token = await ensureValidToken(sessionId);
  if (!token) {
    res.status(401).json({ error: 'No valid access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204) {
      res.json({ success: true });
    } else if (response.status === 401) {
      // トークンが無効な場合は更新を試みる
      const newToken = await refreshAccessToken(sessionId);
      if (newToken) {
        // 再試行
        const retryResponse = await fetch('https://api.spotify.com/v1/me/player/play', {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${newToken}`
          }
        });
        
        if (retryResponse.status === 204) {
          res.json({ success: true });
        } else {
          const errorData = await retryResponse.text();
          res.json({ success: false, error: errorData });
        }
      } else {
        res.status(401).json({ error: 'Failed to refresh token' });
      }
    } else {
      const errorData = await response.text();
      res.json({ success: false, error: errorData });
    }
  } catch (error) {
    console.error('Error in play:', error);
    res.status(500).json({ error: 'Failed to play: ' + error.message });
  }
});

app.get('/current-playback', async function(req, res) {
  const sessionId = req.query.session_id;
  
  const token = await ensureValidToken(sessionId);
  if (!token) {
    res.status(401).json({ error: 'No valid access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 200) {
      const data = await response.json();
      res.json(data);
    } else if (response.status === 204) {
      // デバイスがアクティブでない場合
      res.json({ error: 'No active device found. Please start playback in Spotify app.' });
    } else if (response.status === 401) {
      // トークンが無効な場合は更新を試みる
      const newToken = await refreshAccessToken(sessionId);
      if (newToken) {
        // 再試行
        const retryResponse = await fetch('https://api.spotify.com/v1/me/player', {
          headers: {
            'Authorization': `Bearer ${newToken}`
          }
        });
        
        if (retryResponse.status === 200) {
          const data = await retryResponse.json();
          res.json(data);
        } else if (retryResponse.status === 204) {
          res.json({ error: 'No active device found. Please start playback in Spotify app.' });
        } else {
          const errorData = await retryResponse.text();
          res.json({ error: 'Failed to get playback state: ' + errorData });
        }
      } else {
        res.status(401).json({ error: 'Failed to refresh token' });
      }
    } else {
      const errorData = await response.text();
      res.json({ error: 'Failed to get playback state: ' + errorData });
    }
  } catch (error) {
    console.error('Error in current-playback:', error);
    res.status(500).json({ error: 'Failed to get playback state: ' + error.message });
  }
});

// 古いセッションをクリーンアップする関数（24時間以上使われていないセッションを削除）
function cleanupSessions() {
  const now = Date.now();
  const sessionIds = Object.keys(sessions);
  
  for (const sessionId of sessionIds) {
    if (now - sessions[sessionId].last_used > 24 * 60 * 60 * 1000) {
      console.log('Cleaning up old session:', sessionId);
      delete sessions[sessionId];
    }
  }
}

// ランダムなセッションIDを生成する関数
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// 定期的にセッションをクリーンアップ（1時間ごと）
setInterval(cleanupSessions, 60 * 60 * 1000);

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = app;
