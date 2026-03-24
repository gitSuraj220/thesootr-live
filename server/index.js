require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const cache = new NodeCache();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Google Auth (Service Account) ─────────────────────────
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

// ── YouTube: Channel stats ──────────────────────────────────
app.get('/api/yt-realtime', async (req, res) => {
  const cacheKey = 'yt_rt';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const yt = google.youtube({ version: 'v3', auth: YT_API_KEY });

    const channelRes = await yt.channels.list({
      part: ['statistics'],
      id: [YT_CHANNEL],
    });
    const stats = channelRes.data.items?.[0]?.statistics || {};
    const result = {
      totalViews:    parseInt(stats.viewCount || 0),
      subscriberCount: parseInt(stats.subscriberCount || 0),
      videoCount:    parseInt(stats.videoCount || 0),
    };
    cache.set(cacheKey, result, 120);
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

    // Get most recent 50 videos via uploads playlist (1 unit vs 100 for search.list)
    const uploadsPlaylistId = YT_CHANNEL.replace(/^UC/, 'UU');
    const playlistRes = await yt.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
    });

    const videoIds = (playlistRes.data.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);

    if (videoIds.length === 0) return res.json([]);

    const statsRes = await yt.videos.list({
      part: ['statistics', 'snippet'],
      id: videoIds,
    });

    const videos = (statsRes.data.items || [])
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
    console.error('YT top-videos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TheSootr Live Dashboard running on port ${PORT}`));
