const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8888;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI || `http://localhost:${port}/callback`;
console.log('Using redirect URI:', redirect_uri);

// ルートパスへのアクセスを処理
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 再生位置を±1秒操作するAPI
app.get('/seek', async (req, res) => {
    const token = req.query.token;
    const shift = parseInt(req.query.shift) || 0;
  
    try {
      const playback = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
  
      if (!playback.data || !playback.data.progress_ms) {
        res.send('現在再生中の曲情報が取得できません。');
        return;
      }
  
      const currentPosition = playback.data.progress_ms;
      let newPosition = currentPosition + shift;
  
      if (newPosition < 0) newPosition = 0;
  
      await axios.put(`https://api.spotify.com/v1/me/player/seek?position_ms=${newPosition}`, {}, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
  
      res.send(`現在の再生位置: ${newPosition / 1000}秒`);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        res.status(401).send('トークンの有効期限が切れました。再度ログインしてください。');
      } else {
        res.status(500).send('エラーが発生しました: ' + error.message);
      }
    }
});
  

app.get('/login', (req, res) => {
  // より多くの権限を要求（歌詞取得のため）
  const scope = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
  console.log('Login request, redirecting with URI:', redirect_uri);
  
  // 明示的にリダイレクトURIを指定
  const auth_url = 'https://accounts.spotify.com/authorize?' +
    qs.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
    });
  
  console.log('Auth URL:', auth_url);
  res.redirect(auth_url);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  console.log('Callback received with code:', code ? 'コード受信' : 'コードなし');
  console.log('Using redirect URI for token exchange:', redirect_uri);

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    method: 'post',
    data: qs.stringify({
      code: code,
      redirect_uri: redirect_uri,
      grant_type: 'authorization_code',
    }),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64'),
    },
  };

  try {
    const response = await axios(authOptions);
    const access_token = response.data.access_token;
    
    // HTMLページにリダイレクト
    res.redirect(`/?token=${access_token}`);
  } catch (error) {
    res.send('Authentication error: ' + error.message);
  }
});

app.get('/now-playing', async (req, res) => {
  const token = req.query.token;

  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (response.status === 204 || response.data === "") {
      res.send('No track currently playing.');
      return;
    }

    const track = response.data.item;
    res.send(`Currently playing: ${track.name} by ${track.artists.map(a => a.name).join(", ")}`);
  } catch (error) {
    res.send('Error fetching current track: ' + error.message);
  }
});

// 歌詞を取得するAPI
app.get('/lyrics', async (req, res) => {
  const token = req.query.token;
  
  try {
    // 現在再生中の曲情報を取得
    const playbackResponse = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    
    if (playbackResponse.status === 204 || !playbackResponse.data) {
      return res.json({ error: '現在再生中の曲がありません。' });
    }
    
    const track = playbackResponse.data.item;
    const trackName = track.name;
    const artistName = track.artists[0].name;
    
    // 注: Spotify APIには直接歌詞を取得するエンドポイントがありません
    // 以下は曲の詳細情報を返します
    
    // 曲の詳細情報を取得
    const trackResponse = await axios.get(`https://api.spotify.com/v1/tracks/${track.id}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    
    // アーティスト情報を取得
    const artistResponse = await axios.get(`https://api.spotify.com/v1/artists/${track.artists[0].id}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    
    // 曲の特徴情報を取得
    const featuresResponse = await axios.get(`https://api.spotify.com/v1/audio-features/${track.id}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    
    // 曲の詳細情報を返す
    return res.json({
      info: {
        trackInfo: {
          name: trackName,
          artist: artistName,
          album: track.album.name,
          releaseDate: track.album.release_date,
          duration: Math.floor(track.duration_ms / 1000),
          popularity: trackResponse.data.popularity,
          explicit: track.explicit ? 'あり' : 'なし',
          previewUrl: track.preview_url || 'プレビューなし',
          spotifyUrl: track.external_urls.spotify
        },
        artistInfo: {
          name: artistName,
          genres: artistResponse.data.genres.join(', ') || 'ジャンル情報なし',
          followers: artistResponse.data.followers.total.toLocaleString(),
          popularity: artistResponse.data.popularity
        },
        audioFeatures: featuresResponse.data ? {
          danceability: (featuresResponse.data.danceability * 100).toFixed(0) + '%',
          energy: (featuresResponse.data.energy * 100).toFixed(0) + '%',
          key: getKeyName(featuresResponse.data.key, featuresResponse.data.mode),
          tempo: featuresResponse.data.tempo.toFixed(0) + ' BPM',
          valence: (featuresResponse.data.valence * 100).toFixed(0) + '%' // ポジティブ度
        } : '特徴情報なし'
      },
      message: '歌詞情報は利用できませんが、曲の詳細情報を表示しています。',
      track: {
        name: trackName,
        artist: artistName,
        album: track.album.name
      }
    });
  } catch (error) {
    console.error('エラー:', error.message);
    if (error.response && error.response.status === 401) {
      res.status(401).json({ error: 'トークンの有効期限が切れました。再度ログインしてください。' });
    } else {
      res.status(500).json({ error: 'エラーが発生しました: ' + error.message });
    }
  }
});

// 音楽キーを取得する補助関数
function getKeyName(key, mode) {
  const keys = ['C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'];
  const modes = ['minor', 'major'];
  
  if (key === -1) return '不明';
  return keys[key] + ' ' + modes[mode];
}

// デバッグ用のルート
app.get('/debug', (req, res) => {
  res.json({
    env: {
      NODE_ENV: process.env.NODE_ENV,
      CLIENT_ID: process.env.CLIENT_ID ? '設定済み' : '未設定',
      CLIENT_SECRET: process.env.CLIENT_SECRET ? '設定済み' : '未設定',
      REDIRECT_URI: process.env.REDIRECT_URI,
      PORT: process.env.PORT
    },
    paths: {
      __dirname: __dirname,
      publicPath: path.join(__dirname, 'public')
    }
  });
});

// ローカル開発環境でのみサーバーを起動
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, '0.0.0.0', () => {
    console.log(`App running on http://localhost:${port}/login`);
    console.log(`For iPhone access: http://192.168.1.211:${port}`);
  });
}

// Vercelでのデプロイ用にモジュールをエクスポート
module.exports = app;
