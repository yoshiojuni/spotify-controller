const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

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

// セッションデータを定期的に保存
function saveSessionsToFile() {
  try {
    const sessionsToSave = {};
    
    // 機密情報を除外して保存
    Object.keys(sessions).forEach(sessionId => {
      const session = sessions[sessionId];
      sessionsToSave[sessionId] = {
        refresh_token: session.refresh_token,
        created: session.created,
        last_used: session.last_used
      };
    });
    
    const sessionsDir = path.join(__dirname, 'data');
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir);
    }
    
    fs.writeFileSync(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify(sessionsToSave, null, 2)
    );
    console.log('Sessions saved to file');
  } catch (error) {
    console.error('Error saving sessions:', error);
  }
}

// セッションデータをファイルから読み込む
function loadSessionsFromFile() {
  try {
    const sessionsFile = path.join(__dirname, 'data', 'sessions.json');
    if (fs.existsSync(sessionsFile)) {
      const data = fs.readFileSync(sessionsFile, 'utf8');
      const loadedSessions = JSON.parse(data);
      
      // セッションを復元
      Object.keys(loadedSessions).forEach(sessionId => {
        sessions[sessionId] = loadedSessions[sessionId];
      });
      
      console.log('Sessions loaded from file');
    }
  } catch (error) {
    console.error('Error loading sessions:', error);
  }
}

// アプリ起動時にセッションを読み込む
loadSessionsFromFile();

// 定期的にセッションを保存（5分ごと）
setInterval(saveSessionsToFile, 5 * 60 * 1000);

// 古いセッションをクリーンアップする関数（30日以上使われていないセッションを削除）
function cleanupOldSessions() {
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  
  Object.keys(sessions).forEach(sessionId => {
    if (sessions[sessionId].last_used < thirtyDaysAgo) {
      console.log(`Removing old session: ${sessionId}`);
      delete sessions[sessionId];
    }
  });
  
  console.log(`Session cleanup completed. Active sessions: ${Object.keys(sessions).length}`);
  saveSessionsToFile();
}

// 定期的に古いセッションをクリーンアップ（1日に1回）
setInterval(cleanupOldSessions, 24 * 60 * 60 * 1000);

app.get('/login', function(req, res) {
  console.log('Login route accessed');
  // セッションIDを生成
  const sessionId = generateSessionId();
  
  // リダイレクト先を取得（クエリパラメータから）
  const redirectAfterLogin = req.query.redirect_uri || '';
  
  // セッションを初期化
  sessions[sessionId] = {
    created: Date.now(),
    last_used: Date.now(),
    redirect_after_login: redirectAfterLogin
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
    
    // セッションを保存
    saveSessionsToFile();
    
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
    
    // 最大3回まで再試行
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      attempts++;
      
      try {
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
          console.error(`Token refresh attempt ${attempts} failed:`, response.status, errorData);
          
          if (attempts >= maxAttempts) {
            return false;
          }
          
          // 少し待ってから再試行
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        const data = await response.json();
        console.log('Token refreshed successfully for session:', sessionId);
        
        sessions[sessionId].access_token = data.access_token;
        if (data.refresh_token) {
          sessions[sessionId].refresh_token = data.refresh_token;
        }
        sessions[sessionId].token_expiry = Date.now() + (data.expires_in * 1000);
        sessions[sessionId].last_used = Date.now();
        
        // セッションを保存
        saveSessionsToFile();
        
        return sessions[sessionId].access_token;
      } catch (error) {
        console.error(`Token refresh attempt ${attempts} error:`, error);
        
        if (attempts >= maxAttempts) {
          return false;
        }
        
        // 少し待ってから再試行
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return false;
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

  // トークンの有効期限が切れている場合、または切れる120秒前の場合は更新
  if (!sessions[sessionId].token_expiry || Date.now() > sessions[sessionId].token_expiry - 120000) {
    console.log('Token expired or about to expire, refreshing...');
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

app.get('/session-status', function(req, res) {
  const sessionId = req.query.session_id;
  
  if (!sessionId || !sessions[sessionId]) {
    return res.json({ valid: false, reason: 'session_not_found' });
  }
  
  // セッションの最終使用時間を更新
  sessions[sessionId].last_used = Date.now();
  
  // トークンの有効期限をチェック
  const tokenExpiry = sessions[sessionId].token_expiry || 0;
  const now = Date.now();
  const expiresIn = Math.max(0, tokenExpiry - now);
  
  // トークンが期限切れかどうかをチェック
  const isTokenValid = expiresIn > 0;
  
  // リフレッシュトークンがあるかチェック
  const hasRefreshToken = !!sessions[sessionId].refresh_token;
  
  return res.json({
    valid: isTokenValid || hasRefreshToken,
    token_valid: isTokenValid,
    expires_in: Math.floor(expiresIn / 1000),
    can_refresh: hasRefreshToken,
    session_age: Math.floor((now - (sessions[sessionId].created || now)) / 1000)
  });
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

// 前の曲に移動するエンドポイント
app.get('/previous', async function(req, res) {
  const sessionId = req.query.session_id;
  
  const token = await ensureValidToken(sessionId);
  if (!token) {
    res.status(401).json({ error: 'No valid access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/previous', {
      method: 'POST',
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
        const retryResponse = await fetch('https://api.spotify.com/v1/me/player/previous', {
          method: 'POST',
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
    console.error('Error in previous track:', error);
    res.status(500).json({ error: 'Failed to go to previous track: ' + error.message });
  }
});

// 次の曲に移動するエンドポイント
app.get('/next', async function(req, res) {
  const sessionId = req.query.session_id;
  
  const token = await ensureValidToken(sessionId);
  if (!token) {
    res.status(401).json({ error: 'No valid access token available' });
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
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
        const retryResponse = await fetch('https://api.spotify.com/v1/me/player/next', {
          method: 'POST',
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
    console.error('Error in next track:', error);
    res.status(500).json({ error: 'Failed to go to next track: ' + error.message });
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

// ランダムなセッションIDを生成する関数
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// データディレクトリを作成
try {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }
} catch (error) {
  console.error('Error creating data directory:', error);
}

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = app;
