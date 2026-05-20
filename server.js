const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVol(n) {
  n = parseFloat(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return Math.round(n / 1_000) + 'K';
  return String(Math.round(n));
}

function fmtNum(n) {
  n = parseInt(n) || 0;
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
}

// Extract yes price — Gamma API may return outcomePrices as JSON string
function getYesPrice(m) {
  let prices = m.outcomePrices;
  if (typeof prices === 'string') {
    try { prices = JSON.parse(prices); } catch { prices = null; }
  }
  if (Array.isArray(prices) && prices[0] != null) {
    const v = parseFloat(prices[0]);
    if (!isNaN(v)) return v;
  }
  const t = parseFloat(m.tokens?.[0]?.price);
  if (!isNaN(t)) return t;
  const b = parseFloat(m.bestBid ?? m.bestAsk ?? m.lastTradePrice);
  if (!isNaN(b)) return b;
  return 0.5;
}

// Reddit confidence: upvotes + recency bonus
function calcConfidence(upvotes, created_utc) {
  const age_h = (Date.now() / 1000 - created_utc) / 3600;
  let base = Math.min(40 + Math.log10(Math.max(upvotes, 1)) * 18, 92);
  if (age_h < 48) base += 5;
  if (upvotes > 500) base = Math.min(base + 8, 95);
  return Math.round(base);
}

// Alpha score: Reddit posts that challenge market consensus are more valuable
// High alpha = strong Reddit signal where market is NOT already at extreme
function calcAlpha(redditConfidence, marketProb) {
  const uncertainty = 1 - Math.abs(marketProb / 100 - 0.5) * 2; // 1 at 50%, 0 at 0/100%
  return Math.round(redditConfidence * (0.5 + 0.5 * uncertainty));
}

function guessPostType(text = '') {
  const t = text.toLowerCase();
  if (/insider|source|exclusive|leak|confirmed/.test(t)) return 'insider';
  if (/rumor|rumour|hear|word is|apparently/.test(t))    return 'rumor';
  if (/analysis|predict|think|believe|odds/.test(t))     return 'analysis';
  if (/news|report|official|announce/.test(t))           return 'news';
  return 'discussion';
}

// ── POLYMARKET SEARCH ─────────────────────────────────────────────────────────

async function searchMarkets(query) {
  const q = encodeURIComponent(query);
  const headers = { 'Accept': 'application/json', 'User-Agent': 'AlphaFinder/1.0' };
  const now = Date.now();

  // Parallel: Gamma text search + CLOB search
  const [gammaRes, clobRes] = await Promise.allSettled([
    fetch(`https://gamma-api.polymarket.com/markets?limit=50&active=true&closed=false&q=${q}`, { headers, timeout: 10000 })
      .then(r => r.ok ? r.json() : []),
    fetch(`https://clob.polymarket.com/markets?next_cursor=&limit=30&active=true`, { headers, timeout: 8000 })
      .then(r => r.ok ? r.json() : {})
  ]);

  let all = [];

  if (gammaRes.status === 'fulfilled') {
    const raw = gammaRes.value;
    const gammaAll = Array.isArray(raw) ? raw : (raw.markets || []);
    // Gamma ignores q= param — filter client-side
    const ql = query.toLowerCase().split(' ').filter(w => w.length > 2);
    const gammaFiltered = ql.length
      ? gammaAll.filter(m => {
          const title = (m.question || m.groupItemTitle || m.title || '').toLowerCase();
          return ql.some(w => title.includes(w));
        })
      : gammaAll;
    all = all.concat(gammaFiltered);
  }

  if (clobRes.status === 'fulfilled') {
    const raw = clobRes.value;
    const ql  = query.toLowerCase();
    const clobMarkets = (raw.data || raw.markets || []).filter(m => {
      const title = (m.question || m.title || '').toLowerCase();
      return ql.split(' ').some(w => w.length > 3 && title.includes(w));
    });
    all = all.concat(clobMarkets);
  }

  // Filter active + deduplicate + remove noise markets
  const seen = new Set();
  const unique = all.filter(m => {
    const end = m.endDate || m.end_date_iso;
    if (end && new Date(end).getTime() <= now) return false;
    const question = m.question || m.title || '';
    if (isNoiseMarket(question)) return false;
    const key = question.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.map(m => marketToObj(m, query)).sort((a, b) => b.probability - a.probability).slice(0, 30);
}

// Markets with no Reddit alpha signal — short-term price flips, no discussion
const NOISE_MARKET_PATTERNS = [
  /\bup or down\b/i,           // XRP Up or Down, BNB Up or Down...
  /\bhigher or lower\b/i,
  /\d+:\d+[ap]m.{0,20}\d+:\d+[ap]m/i,  // time window markets "7:45AM-7:50AM"
  /\bwill .+ (reach|hit|exceed|cross|drop to|fall to|close (above|below))\s+\$?[\d,]+/i, // price target
  /\b(btc|eth|xrp|bnb|sol|doge|ada|matic|avax|link)\b.{0,30}\$[\d,]+/i, // crypto price markets
];

function isNoiseMarket(question) {
  return NOISE_MARKET_PATTERNS.some(re => re.test(question));
}

// Shared market object builder
const STOPWORDS = new Set(['will','the','a','an','of','in','by','to','is','are','was','were','for','on','at','or','and','if','get','have','has','before','after','this','that','what','who','how','when','where','does','do','can','would','could','should','its','their','there','than','then','with','from','about','into','out','not','any','all','some','which','more','most','until','since','during','through','between','among','within','without','under','over','above','below','around','new','next','first','last','per','its','be','vs','win','hit']);

function extractTopicQuery(question) {
  return question
    .replace(/\?/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 5)
    .join(' ');
}

function marketToObj(m, fallback = '') {
  const yesPrice = getYesPrice(m);
  const prob = Math.min(99, Math.max(1, Math.round(yesPrice * 100)));
  const question = m.question || m.groupItemTitle || m.title || 'Market';
  // Alpha opportunity: 1.0 at 50%, 0.0 at 0% or 100%
  const alpha_opportunity = Math.round((1 - Math.abs(prob / 100 - 0.5) * 2) * 100);
  return {
    question,
    probability: prob,
    alpha_opportunity,
    volume: fmtVol(parseFloat(m.volume || m.volumeNum || m.liquidityNum || 0)),
    volume_raw: parseFloat(m.volume || m.volumeNum || m.liquidityNum || 0),
    end_date: fmtDate(m.endDate || m.end_date_iso),
    end_date_iso: m.endDate || m.end_date_iso || null,
    polymarket_url: m.url || `https://polymarket.com/event/${m.slug || m.conditionId || ''}`,
    search_hint: extractTopicQuery(question) || fallback
  };
}

// ── TOP MARKETS (browse mode) ─────────────────────────────────────────────────

async function fetchTopMarkets() {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'AlphaFinder/1.0' };
  const now = Date.now();

  // Fetch geopolitics markets by volume
  const res = await fetch('https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&tag=geopolitics&order=volume&ascending=false', { headers, timeout: 12000 });
  if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`);
  const raw = await res.json();
  const markets = Array.isArray(raw) ? raw : (raw.markets || []);

  const now2 = Date.now();
  const seen = new Set();
  const unique = markets.filter(m => {
    const end = m.endDate || m.end_date_iso;
    if (end && new Date(end).getTime() <= now2) return false;
    const question = m.question || m.title || '';
    if (isNoiseMarket(question)) return false;
    const key = question.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique
    .map(m => marketToObj(m))
    // Sort by alpha opportunity (closest to 50% first = most uncertain = most edge)
    .sort((a, b) => b.alpha_opportunity - a.alpha_opportunity)
    .slice(0, 60);
}

// ── REDDIT ALPHA ──────────────────────────────────────────────────────────────

async function fetchRedditAlpha(query) {
  const headers = {
    'User-Agent': 'AlphaFinder:v1.0 (by /u/alphafinder_app)',
    'Accept': 'application/json'
  };

  // Search ONLY the topic — no "leak OR rumor" mixed in (pulls unrelated content)
  // We rank by alpha keywords AFTER fetching
  const topicQuery = encodeURIComponent(query);

  const searchUrl = `https://www.reddit.com/search.json?q=${topicQuery}&sort=new&limit=40&t=year&type=link`;

  const res = await fetch(searchUrl, { headers, timeout: 8000 });
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const data = await res.json();

  let posts = (data?.data?.children || [])
    .map(c => c.data)
    .filter(p => p && !p.over_18 && p.selftext !== '[removed]' && p.score > 3);

  // Deduplicate
  const seenT = new Set();
  const unique = posts.filter(p => {
    if (seenT.has(p.title)) return false;
    seenT.add(p.title);
    return true;
  });

  const qWords = query.toLowerCase().split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w));
  const alphaWords = ['leak', 'insider', 'source', 'exclusive', 'confirmed', 'rumor', 'rumour', 'reveal', 'scoop', 'breaking', 'classified', 'whistleblower', 'anonymous', 'claims', 'alleges'];

  // Minimum relevance threshold: post must contain at least 50% of topic words
  const minMatch = Math.max(1, Math.ceil(qWords.length * 0.5));

  const scored = unique.map(p => {
    const text = (p.title + ' ' + (p.selftext || '')).toLowerCase();
    const matchCount = qWords.filter(w => text.includes(w)).length;
    if (matchCount < minMatch) return { ...p, _score: -1 }; // off-topic, discard
    const alphaHits = alphaWords.filter(w => text.includes(w)).length;
    // Alpha signal = how many alpha keywords + upvote weight + recency
    const signal = matchCount * 2 + alphaHits * 5;
    const engagement = Math.log10(Math.max(p.score, 1));
    return { ...p, _score: signal * engagement };
  })
  .filter(p => p._score > 0)
  .sort((a, b) => b._score - a._score)
  .slice(0, 8);

  return scored.map(p => {
    const text = p.title + ' ' + (p.selftext || '');
    const alphaHits = alphaWords.filter(w => text.toLowerCase().includes(w)).length;
    const matchCount = qWords.filter(w => text.toLowerCase().includes(w)).length;
    // Signal: 0-100 based on alpha keyword density + relevance
    const signal = Math.min(99, Math.round(
      (alphaHits * 20 + matchCount * 10 + Math.log10(Math.max(p.score, 1)) * 8)
    ));
    return {
      title: p.title.slice(0, 140),
      subreddit: `r/${p.subreddit}`,
      upvotes: fmtNum(p.score),
      signal,             // replaces confusing "alpha" score
      has_alpha: alphaHits > 0,
      post_type: guessPostType(text),
      content: buildContent(p),
      reddit_url: `https://www.reddit.com${p.permalink}`,
      age_h: Math.round((Date.now() / 1000 - p.created_utc) / 3600)
    };
  });
}

function buildContent(p) {
  const text = p.selftext?.trim();
  if (text && text.length > 30 && text !== '[deleted]') {
    return text.slice(0, 300) + (text.length > 300 ? '…' : '');
  }
  return `${p.num_comments || 0} commentaires · ${p.score} upvotes · r/${p.subreddit}`;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/api/top', async (req, res) => {
  console.log('[top] fetch top markets by alpha opportunity');
  try {
    const markets = await fetchTopMarkets();
    console.log(`  ${markets.length} markets`);
    res.json({ markets, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[top]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/markets', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q requis' });
  console.log(`[markets] "${q}"`);
  try {
    const markets = await searchMarkets(q.trim());
    console.log(`  ${markets.length} markets`);
    res.json({ markets, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[markets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaks', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q requis' });
  console.log(`[leaks] "${q}"`);
  try {
    const leaks = await fetchRedditAlpha(q.trim());
    console.log(`  ${leaks.length} posts`);
    res.json({ leaks, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[leaks]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`\nAlphaFinder on http://localhost:${PORT}\n`));
