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

  // Filter active + deduplicate
  const seen = new Set();
  const unique = all.filter(m => {
    const end = m.endDate || m.end_date_iso;
    if (end && new Date(end).getTime() <= now) return false;
    const key = (m.question || m.title || '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.map(m => {
    const yesPrice = getYesPrice(m);
    const prob = Math.min(99, Math.max(1, Math.round(yesPrice * 100)));
    return {
      id: m.conditionId || m.id || m.slug || '',
      question: m.question || m.groupItemTitle || m.title || 'Market',
      probability: prob,
      volume: fmtVol(parseFloat(m.volume || m.volumeNum || m.liquidityNum || 0)),
      end_date: fmtDate(m.endDate || m.end_date_iso),
      polymarket_url: m.url || `https://polymarket.com/event/${m.slug || m.conditionId || ''}`,
      // search term for Reddit = first 4 meaningful words of question
      search_hint: (m.question || m.title || query)
        .replace(/^will\s+/i, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, 4)
        .join(' ')
    };
  })
  // Sort: highest probability first (strongest signal markets)
  .sort((a, b) => b.probability - a.probability)
  .slice(0, 30);
}

// ── REDDIT ALPHA ──────────────────────────────────────────────────────────────

async function fetchRedditAlpha(query) {
  const headers = {
    'User-Agent': 'AlphaFinder:v1.0 (by /u/alphafinder_app)',
    'Accept': 'application/json'
  };

  const terms = query.split(' ').slice(0, 4).join('+');
  const alphaTerms = `${terms} leak OR rumor OR insider OR confirmed OR source OR exclusive`;

  const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(alphaTerms)}&sort=new&limit=30&t=month&type=link`;

  const res = await fetch(searchUrl, { headers, timeout: 8000 });
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const data = await res.json();

  let posts = (data?.data?.children || [])
    .map(c => c.data)
    .filter(p => p && !p.over_18 && p.selftext !== '[removed]' && p.score > 5);

  // Widen to year if sparse
  if (posts.length < 3) {
    try {
      const widerUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(alphaTerms)}&sort=new&limit=25&t=year&type=link`;
      const r2 = await fetch(widerUrl, { headers, timeout: 6000 });
      if (r2.ok) {
        const d2 = await r2.json();
        const more = (d2?.data?.children || []).map(c => c.data)
          .filter(p => p && !p.over_18 && p.selftext !== '[removed]' && p.score > 3);
        posts = [...posts, ...more];
      }
    } catch {}
  }

  // Deduplicate
  const seenT = new Set();
  const unique = posts.filter(p => {
    if (seenT.has(p.title)) return false;
    seenT.add(p.title);
    return true;
  });

  // Score relevance
  const qWords = query.toLowerCase().split(' ').filter(w => w.length > 2);
  const alphaWords = ['leak', 'insider', 'source', 'exclusive', 'confirmed', 'rumor', 'rumour', 'reveal', 'scoop'];

  const scored = unique.map(p => {
    const text = (p.title + ' ' + (p.selftext || '')).toLowerCase();
    let score = qWords.filter(w => text.includes(w)).length * 2;
    if (alphaWords.some(w => text.includes(w))) score += 3;
    if (p.score > 100) score += 2;
    if (p.score > 1000) score += 3;
    return { ...p, _score: score };
  })
  .filter(p => p._score > 0)
  .sort((a, b) => (b._score * Math.log(b.score + 1)) - (a._score * Math.log(a.score + 1)))
  .slice(0, 8);

  return scored.map(p => {
    const confidence = calcConfidence(p.score, p.created_utc);
    return {
      title: p.title.slice(0, 140),
      subreddit: `r/${p.subreddit}`,
      upvotes: fmtNum(p.score),
      confidence,
      post_type: guessPostType(p.title + ' ' + (p.selftext || '')),
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
