require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path');
const app = express();
const cache = new NodeCache();

// ── Upstash REST helpers (no package needed) ───────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(`${REDIS_URL}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const json = await res.json();
  return json.result;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Google Auth (Service Account for GA4) ─────────────────
function getGoogleAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
  const key = JSON.parse(
    Buffer.from(keyJson, 'base64').toString('utf-8')
  );
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
}

// ── YouTube Analytics OAuth ────────────────────────────────
const YT_OAUTH = new google.auth.OAuth2(
  process.env.YT_OAUTH_CLIENT_ID,
  process.env.YT_OAUTH_CLIENT_SECRET,
  (process.env.BASE_URL || 'https://thesootr-live.vercel.app') + '/auth/youtube/callback'
);

async function getYTAnalyticsAuth() {
  const token = await redisCmd('get', 'yt_refresh_token');
  if (!token) return null;
  YT_OAUTH.setCredentials({ refresh_token: token });
  return YT_OAUTH;
}

// Step 1: Start OAuth for YouTube Analytics
app.get('/auth/youtube', (req, res) => {
  const url = YT_OAUTH.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/yt-analytics.readonly'],
    prompt: 'consent',
  });
  res.redirect(url);
});

// Step 2: Store refresh token in Redis
app.get('/auth/youtube/callback', async (req, res) => {
  try {
    const { tokens } = await YT_OAUTH.getToken(req.query.code);
    if (tokens.refresh_token) {
      await redisCmd('set', 'yt_refresh_token', tokens.refresh_token);
      res.send('<h2>YouTube Analytics authorized! You can close this tab.</h2>');
    } else {
      res.send('<h2>No refresh token received. Try again at /auth/youtube</h2>');
    }
  } catch (e) {
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// YouTube Analytics: views in last 60 min (current + previous UTC hour)
app.get('/api/yt-views60', async (req, res) => {
  const cached = cache.get('yt_views60');
  if (cached !== undefined) return res.json(cached);

  try {
    const auth = await getYTAnalyticsAuth();
    if (!auth) return res.json({ views60: null, authorized: false });

    const today = new Date().toISOString().split('T')[0];
    const ytAnalytics = google.youtubeAnalytics({ version: 'v2', auth });

    const report = await ytAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate: today,
      endDate: today,
      metrics: 'views',
      dimensions: 'hour',
    });

    const nowHour = new Date().getUTCHours();
    const rows = report.data.rows || [];
    let views60 = 0;
    rows.forEach(([hour, views]) => {
      if (hour === nowHour || hour === nowHour - 1) views60 += views;
    });

    const result = { views60, authorized: true };
    cache.set('yt_views60', result, 300); // cache 5 min
    res.json(result);
  } catch (err) {
    console.error('YT Analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const GA4_PROPERTY = `properties/${process.env.GA4_PROPERTY_ID || '278320255'}`;
const YT_API_KEY   = process.env.YT_API_KEY;
const YT_CHANNEL   = process.env.YT_CHANNEL_ID || 'UCnOACbwmpn3_adWl_zU63YQ';


// ── GA4 Realtime ───────────────────────────────────────────
app.get('/api/realtime', async (req, res) => {
  const cacheKey = 'ga4_rt';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const auth = getGoogleAuth();
    const analytics = google.analyticsdata({ version: 'v1beta', auth });

    const [totalRes, sparkRes] = await Promise.all([
      // No dimension = deduplicated total active users (correct count)
      analytics.properties.runRealtimeReport({
        property: GA4_PROPERTY,
        requestBody: {
          metrics: [{ name: 'activeUsers' }],
        },
      }),
      // minutesAgo dimension for sparkline only
      analytics.properties.runRealtimeReport({
        property: GA4_PROPERTY,
        requestBody: {
          metrics: [{ name: 'activeUsers' }],
          dimensions: [{ name: 'minutesAgo' }],
          limit: 30,
        },
      }),
    ]);

    const activeUsers = parseInt(totalRes.data.rows?.[0]?.metricValues?.[0]?.value || 0);

    // Build sparkline: 30-min window, minute by minute
    const sparkMap = {};
    (sparkRes.data.rows || []).forEach(r => {
      const minsAgo = parseInt(r.dimensionValues[0].value);
      sparkMap[minsAgo] = parseInt(r.metricValues[0].value || 0);
    });
    const sparkline = [];
    for (let i = 29; i >= 0; i--) {
      sparkline.push(sparkMap[i] || 0);
    }

    const result = { activeUsers, sparkline };
    cache.set(cacheKey, result, 30);
    res.json(result);
  } catch (err) {
    console.error('GA4 realtime error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GA4 Top 10 News ────────────────────────────────────────
app.get('/api/top-news', async (req, res) => {
  const cacheKey = 'ga4_top10';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const auth = getGoogleAuth();
    const analytics = google.analyticsdata({ version: 'v1beta', auth });

    const resp = await analytics.properties.runRealtimeReport({
      property: GA4_PROPERTY,
      requestBody: {
        dimensions: [{ name: 'unifiedScreenName' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 50,
      },
    });

    const rows = (resp.data.rows || [])
      .filter(r => {
        const p = r.dimensionValues[0].value;
        return p !== '(other)' && p !== '/' && !p.includes('(not set)') && p !== '';
      })
      .slice(0, 10)
      .map(r => ({
        path: r.dimensionValues[0].value,
        title: r.dimensionValues[0].value,
        activeUsers: parseInt(r.metricValues[0].value || 0),
      }));

    cache.set(cacheKey, rows, 30);
    res.json(rows);
  } catch (err) {
    console.error('GA4 top-news error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── YouTube: Channel stats + views-last-60-min via Redis ───
app.get('/api/yt-realtime', async (req, res) => {
  const cacheKey = 'yt_rt';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const yt = google.youtube({ version: 'v3', auth: YT_API_KEY });

    const channelRes = await yt.channels.list({
      part: 'statistics',
      id: YT_CHANNEL,
    });
    const stats = channelRes.data.items?.[0]?.statistics || {};
    const totalViews      = parseInt(stats.viewCount || 0);
    const subscriberCount = parseInt(stats.subscriberCount || 0);
    const videoCount      = parseInt(stats.videoCount || 0);

    // ── Delta tracking via Upstash Redis ──────────────────
    let viewsLast60 = null;
    if (REDIS_URL && totalViews > 0) {
      const now = Date.now();
      const snapshot = JSON.stringify({ t: now, v: totalViews });

      // Push new snapshot, keep only last 150 entries (~75 min at 30s intervals)
      await redisCmd('lpush', 'yt_view_history', snapshot);
      await redisCmd('ltrim', 'yt_view_history', '0', '149');

      // Read full history, find oldest entry within 60-min window
      const raw = await redisCmd('lrange', 'yt_view_history', '0', '-1');
      if (Array.isArray(raw)) {
        const history = raw
          .map(e => (typeof e === 'string' ? JSON.parse(e) : e))
          .sort((a, b) => a.t - b.t);

        const cutoff = now - 60 * 60 * 1000;
        const baseline = history.find(h => h.t <= cutoff + 60 * 1000);
        if (baseline) {
          viewsLast60 = Math.max(0, totalViews - baseline.v);
        }
      }
    }

    const result = { totalViews, subscriberCount, videoCount, viewsLast60 };
    cache.set(cacheKey, result, 30);
    res.json(result);
  } catch (err) {
    console.error('YT realtime error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── YouTube Top 10 Videos ──────────────────────────────────
app.get('/api/yt-top-videos', async (req, res) => {
  const cacheKey = 'yt_top10';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const yt = google.youtube({ version: 'v3', auth: YT_API_KEY });

    // Use direct fetch to avoid googleapis quirks on serverless
    const uploadsPlaylistId = YT_CHANNEL.replace(/^UC/, 'UU');
    const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=50&key=${YT_API_KEY}`;
    const plRes = await fetch(plUrl).then(r => r.json());
    if (plRes.error) throw new Error(JSON.stringify(plRes.error));

    const videoIds = (plRes.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
    if (videoIds.length === 0) return res.json([]);

    const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds.join(',')}&key=${YT_API_KEY}`;
    const statsRes = await fetch(vUrl).then(r => r.json());
    if (statsRes.error) throw new Error(JSON.stringify(statsRes.error));

    const videos = (statsRes.items || [])
      .map(v => ({
        id: v.id,
        title: v.snippet?.title || '',
        thumbnail: v.snippet?.thumbnails?.medium?.url || '',
        publishedAt: v.snippet?.publishedAt,
        viewCount: parseInt(v.statistics?.viewCount || 0),
        likeCount: parseInt(v.statistics?.likeCount || 0),
        commentCount: parseInt(v.statistics?.commentCount || 0),
      }))
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 10);

    cache.set(cacheKey, videos, 300);
    res.json(videos);
  } catch (err) {
    const details = err.response?.data?.error || err.message;
    console.error('YT top-videos error:', JSON.stringify(details));
    res.status(500).json({ error: details });
  }
});

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TheSootr Live Dashboard running on port ${PORT}`));
