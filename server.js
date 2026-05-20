const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Normalize probability: Polymarket returns 0-1 floats
const pct = v => Math.round(parseFloat(v) * 100);

// Short volume formatter
function fmtVol(n) {
  n = parseFloat(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return Math.round(n / 1_000) + 'K';
  return String(Math.round(n));
}

// Short upvote formatter
function fmtNum(n) {
  n = parseInt(n) || 0;
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// Guess spoiler type from title/text
function guessSpoilerType(text = '') {
  const t = text.toLowerCase();
  if (/cancel|annul|end/.test(t))            return 'cancellation';
  if (/renew|season \d|saison \d/.test(t))   return 'renewal';
  if (/premiere|release|date|trailer/.test(t)) return 'release_date';
  if (/cast|actor|actric|star|play|role/.test(t)) return 'casting';
  return 'plot';
}

// Confidence score based on upvotes + recency
function calcConfidence(upvotes, created_utc) {
  const age_h = (Date.now() / 1000 - created_utc) / 3600;
  let base = Math.min(40 + Math.log10(Math.max(upvotes, 1)) * 18, 92);
  if (age_h < 48) base += 5;
  if (upvotes > 500) base = Math.min(base + 8, 95);
  return Math.round(base);
}

// Trend from Polymarket outcomePrices history (naive: compare last 2 prices if available)
function calcTrend(market) {
  // Polymarket doesn't expose history in CLOB easily; use spread as proxy
  const yes = parseFloat(market.outcomePrices?.[0] || market.tokens?.[0]?.price || 0.5);
  const no  = parseFloat(market.outcomePrices?.[1] || market.tokens?.[1]?.price || 0.5);
  if (Math.abs(yes - no) < 0.05) return 'stable';
  return yes > 0.55 ? 'up' : 'down';
}

// Date formatter
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
}

// ── POLYMARKET ────────────────────────────────────────────────────────────────

async function fetchPolymarketByQuery(query) {
  const keywords = encodeURIComponent(query);
  const now = Date.now();
  const headers = { 'Accept': 'application/json', 'User-Agent': 'TVpred/1.0' };

  // Primary: Gamma API — supports active/closed filters and full-text search
  let combined = [];
  try {
    const gammaUrl = `https://gamma-api.polymarket.com/markets?limit=30&active=true&closed=false&q=${keywords}`;
    const rg = await fetch(gammaUrl, { headers, timeout: 8000 });
    if (rg.ok) {
      const dg = await rg.json();
      const gammaMarkets = Array.isArray(dg) ? dg : (dg.markets || []);
      const q = query.toLowerCase();
      combined = gammaMarkets.filter(m => {
        const title = (m.question || m.groupItemTitle || m.title || '').toLowerCase();
        return q.split(' ').some(word => word.length > 3 && title.includes(word));
      });
    }
  } catch {}

  // Fallback: CLOB endpoint with active filter
  if (combined.length < 2) {
    try {
      const clobUrl = `https://clob.polymarket.com/markets?next_cursor=&limit=30&active=true`;
      const res = await fetch(clobUrl, { headers, timeout: 8000 });
      if (res.ok) {
        const data = await res.json();
        const markets = (data.data || data.markets || []);
        const q = query.toLowerCase();
        const filtered = markets.filter(m => {
          const title = (m.question || m.title || '').toLowerCase();
          const desc  = (m.description || '').toLowerCase();
          return q.split(' ').some(word => word.length > 3 && (title.includes(word) || desc.includes(word)));
        });
        combined = [...combined, ...filtered];
      }
    } catch {}
  }

  // Filter out markets already closed/resolved (end_date in the past)
  const active = combined.filter(m => {
    const end = m.endDate || m.end_date_iso || m.endDateIso;
    if (!end) return true; // no date = keep
    return new Date(end).getTime() > now;
  });

  // Deduplicate by question text
  const seen = new Set();
  const unique = active.filter(m => {
    const key = (m.question || m.title || '').slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by soonest end date first (most time-relevant)
  unique.sort((a, b) => {
    const da = new Date(a.endDate || a.end_date_iso || '9999').getTime();
    const db = new Date(b.endDate || b.end_date_iso || '9999').getTime();
    return da - db;
  });

  return unique.slice(0, 6).map(m => {
    // Handle both CLOB and Gamma formats
    const yesPrice = parseFloat(
      m.outcomePrices?.[0] ??
      m.tokens?.[0]?.price ??
      m.bestBid ??
      0.5
    );
    const volume = parseFloat(m.volume || m.volumeNum || m.liquidityNum || 0);
    return {
      show: extractShowName(m.question || m.title || '', query),
      question: m.question || m.groupItemTitle || m.title || 'Marché sans titre',
      probability: Math.min(99, Math.max(1, pct(yesPrice))),
      volume: fmtVol(volume),
      end_date: fmtDate(m.endDate || m.end_date_iso),
      trend: calcTrend(m),
      polymarket_url: m.url || `https://polymarket.com/event/${m.slug || m.conditionId || ''}`
    };
  });
}

// Extract show name from question, fallback to query
function extractShowName(question, query) {
  // Try to extract show name from "Will X be renewed..." patterns
  const match = question.match(/^Will (.+?) (be|win|get|have|release|return|get)/i)
              || question.match(/^(.+?) season \d/i)
              || question.match(/^(.+?): /i);
  if (match) return match[1].slice(0, 30).trim();
  // Capitalize query as fallback
  return query.split(' ').slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── REDDIT ────────────────────────────────────────────────────────────────────

async function fetchRedditLeaks(query) {
  const headers = {
    'User-Agent': 'TVpred:v1.0 (by /u/tvpred_app)',
    'Accept': 'application/json'
  };

  const show = query.split(' ').slice(0, 3).join('+');
  const leakTerms = `${show}+leak OR spoiler OR rumor OR renewal OR cancelled OR season`;

  const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(leakTerms)}&sort=new&limit=25&t=month&type=link`;

  const res = await fetch(searchUrl, { headers, timeout: 8000 });
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const data = await res.json();

  let posts = (data?.data?.children || [])
    .map(c => c.data)
    .filter(p => p && !p.over_18 && p.selftext !== '[removed]' && p.score > 10);

  // If sparse, widen to past year
  if (posts.length < 3) {
    try {
      const widerUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(leakTerms)}&sort=new&limit=25&t=year&type=link`;
      const r3 = await fetch(widerUrl, { headers, timeout: 6000 });
      if (r3.ok) {
        const d3 = await r3.json();
        const wider = (d3?.data?.children || [])
          .map(c => c.data)
          .filter(p => p && !p.over_18 && p.selftext !== '[removed]' && p.score > 5);
        posts = [...posts, ...wider];
      }
    } catch {}
  }

  // Also try subreddit-specific search
  const slug = query.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
  let extraPosts = [];
  try {
    const subUrl = `https://www.reddit.com/r/${slug}+tvshows+television/search.json?q=${encodeURIComponent(show)}&sort=hot&limit=10&restrict_sr=0&t=month`;
    const r2 = await fetch(subUrl, { headers, timeout: 5000 });
    if (r2.ok) {
      const d2 = await r2.json();
      extraPosts = (d2?.data?.children || []).map(c => c.data).filter(p => p && p.score > 5);
    }
  } catch {}

  const allPosts = [...posts, ...extraPosts];

  // Deduplicate by title
  const seenTitles = new Set();
  const unique = allPosts.filter(p => {
    if (seenTitles.has(p.title)) return false;
    seenTitles.add(p.title);
    return true;
  });

  // Score by relevance + engagement
  const scored = unique
    .map(p => ({
      ...p,
      relevance: scoreRelevance(p.title + ' ' + (p.selftext || ''), query)
    }))
    .filter(p => p.relevance > 0)
    .sort((a, b) => (b.relevance * b.score) - (a.relevance * a.score))
    .slice(0, 6);

  return scored.map(p => ({
    show: extractShowName(p.title, query),
    subreddit: `r/${p.subreddit}`,
    title: p.title.slice(0, 120),
    content: buildContent(p),
    confidence: calcConfidence(p.score, p.created_utc),
    upvotes: fmtNum(p.score),
    spoiler_type: guessSpoilerType(p.title + ' ' + (p.selftext || '')),
    reddit_url: `https://www.reddit.com${p.permalink}`
  }));
}

function scoreRelevance(text, query) {
  const t = text.toLowerCase();
  const words = query.toLowerCase().split(' ').filter(w => w.length > 2);
  const leakWords = ['leak', 'spoiler', 'rumor', 'rumour', 'confirmed', 'renew', 'cancel', 'season', 'reveal', 'exclusive'];
  let score = words.filter(w => t.includes(w)).length;
  if (leakWords.some(w => t.includes(w))) score += 2;
  return score;
}

function buildContent(p) {
  const text = p.selftext?.trim();
  if (text && text.length > 30 && text !== '[deleted]') {
    return text.slice(0, 280) + (text.length > 280 ? '...' : '');
  }
  // Fallback: generate from title context
  return `Post avec ${p.num_comments || 0} commentaires. Score: ${p.score} upvotes. Posté dans r/${p.subreddit}.`;
}

// ── ALL TV MARKETS ────────────────────────────────────────────────────────────

// TV-related keywords to identify show markets
const TV_KEYWORDS = ['season', 'renewed', 'cancelled', 'canceled', 'episode', 'premiere', 'series', 'emmy', 'finale', 'show', 'streaming', 'netflix', 'hbo', 'hulu', 'disney', 'apple tv', 'amazon'];

function isTvMarket(m) {
  const text = ((m.question || m.groupItemTitle || m.title || '') + ' ' + (m.description || '')).toLowerCase();
  return TV_KEYWORDS.some(kw => text.includes(kw));
}

async function fetchAllTvMarkets() {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'TVpred/1.0' };
  const now = Date.now();

  // Parallel fetch: broad entertainment + TV-specific keywords
  const urls = [
    'https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&tag=entertainment',
    'https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&q=season',
    'https://gamma-api.polymarket.com/markets?limit=50&active=true&closed=false&q=renewed',
    'https://gamma-api.polymarket.com/markets?limit=50&active=true&closed=false&q=cancelled',
    'https://gamma-api.polymarket.com/markets?limit=50&active=true&closed=false&q=premiere',
  ];

  const results = await Promise.allSettled(
    urls.map(url => fetch(url, { headers, timeout: 10000 }).then(r => r.ok ? r.json() : []))
  );

  let all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const raw = r.value;
      const arr = Array.isArray(raw) ? raw : (raw.markets || []);
      all = all.concat(arr);
    }
  }

  // Filter: active end date + TV-related
  const active = all.filter(m => {
    const end = m.endDate || m.end_date_iso;
    if (end && new Date(end).getTime() <= now) return false;
    return isTvMarket(m);
  });

  // Deduplicate
  const seen = new Set();
  const unique = active.filter(m => {
    const key = (m.question || m.title || '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort soonest end date first
  unique.sort((a, b) => {
    const da = new Date(a.endDate || a.end_date_iso || '9999').getTime();
    const db = new Date(b.endDate || b.end_date_iso || '9999').getTime();
    return da - db;
  });

  return unique.slice(0, 80).map(m => ({
    show: extractShowName(m.question || m.groupItemTitle || m.title || '', ''),
    question: m.question || m.groupItemTitle || m.title || 'Market',
    probability: Math.min(99, Math.max(1, pct(
      m.outcomePrices?.[0] ?? m.tokens?.[0]?.price ?? m.bestBid ?? 0.5
    ))),
    volume: fmtVol(parseFloat(m.volume || m.volumeNum || m.liquidityNum || 0)),
    end_date: fmtDate(m.endDate || m.end_date_iso),
    trend: calcTrend(m),
    polymarket_url: m.url || `https://polymarket.com/event/${m.slug || m.conditionId || ''}`
  }));
}

app.get('/api/markets', async (req, res) => {
  console.log('[markets] fetch all TV markets');
  try {
    const markets = await fetchAllTvMarkets();
    console.log(`  ${markets.length} TV markets found`);
    res.json({ markets, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[markets] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── LEAKS FOR SHOW ─────────────────────────────────────────────────────────────

app.get('/api/leaks', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Paramètre q requis' });
  }
  const query = q.trim();
  console.log(`[leaks] "${query}"`);
  try {
    const leaks = await fetchRedditLeaks(query);
    console.log(`  ${leaks.length} leaks`);
    res.json({ leaks, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[leaks] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MAIN API ROUTE ────────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Paramètre q requis' });
  }

  const query = q.trim();
  console.log(`[search] "${query}"`);

  const errors = [];
  let markets = [], leaks = [];

  // Fetch in parallel
  const [marketsResult, leaksResult] = await Promise.allSettled([
    fetchPolymarketByQuery(query),
    fetchRedditLeaks(query)
  ]);

  if (marketsResult.status === 'fulfilled') {
    markets = marketsResult.value;
    console.log(`  Polymarket: ${markets.length} marchés`);
  } else {
    console.error('  Polymarket error:', marketsResult.reason?.message);
    errors.push(`Polymarket: ${marketsResult.reason?.message}`);
  }

  if (leaksResult.status === 'fulfilled') {
    leaks = leaksResult.value;
    console.log(`  Reddit: ${leaks.length} posts`);
  } else {
    console.error('  Reddit error:', leaksResult.reason?.message);
    errors.push(`Reddit: ${leaksResult.reason?.message}`);
  }

  res.json({
    query,
    timestamp: new Date().toISOString(),
    markets,
    leaks,
    ...(errors.length ? { warnings: errors } : {})
  });
});

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// Serve frontend
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🎬 TVpred backend démarré sur http://localhost:${PORT}\n`);
});
