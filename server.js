// India's Got Latent — Hot or Not backend. Zero dependencies, Node 22.5+ (uses built-in node:sqlite).
// Run: node server.js
// Env: PORT (default 3000), DB_PATH (default ./votes.sqlite — point at a persistent volume in prod)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PEOPLE = require('./data.js');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'votes.sqlite');
const PUBLIC = path.join(__dirname, 'public');
const PEOPLE_BY_ID = new Map(PEOPLE.map(p => [p.id, p]));

// ---------- persistence (SQLite) ----------
// safety: snapshot the DB on every boot so votes survive accidents
try {
  const bdir = path.join(path.dirname(DB_PATH), 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, path.join(bdir, `votes-${new Date().toISOString().slice(0, 10)}.sqlite`));
  }
} catch {}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS players (
    person_id TEXT PRIMARY KEY,
    rating    REAL NOT NULL DEFAULT 1000,
    wins      INTEGER NOT NULL DEFAULT 0,
    losses    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS faceoffs (
    pair_key   TEXT PRIMARY KEY,
    voter_id   TEXT NOT NULL,
    winner_id  TEXT NOT NULL,
    loser_id   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ratings (
    person_id  TEXT NOT NULL,
    voter_id   TEXT NOT NULL,
    score      INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (person_id, voter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_faceoffs_voter ON faceoffs(voter_id);
  CREATE INDEX IF NOT EXISTS idx_ratings_person ON ratings(person_id);
`);

// one-time migration from the old db.json, if it exists and sqlite is empty
(function migrateJson() {
  const legacy = ['db.json', 'db.json.bak'].map(f => path.join(__dirname, f)).find(f => fs.existsSync(f));
  if (!legacy) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM faceoffs').get().n;
  if (count > 0) return;
  try {
    const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    db.exec('BEGIN');
    for (const [id, rating] of Object.entries(old.elo || {})) {
      const rec = (old.records || {})[id] || { w: 0, l: 0 };
      db.prepare('INSERT OR REPLACE INTO players(person_id, rating, wins, losses) VALUES(?,?,?,?)')
        .run(id, rating, rec.w, rec.l);
    }
    for (const [key, winnerId] of Object.entries(old.faceoffs || {})) {
      const [voterId, a, b] = key.split('|');
      db.prepare('INSERT OR IGNORE INTO faceoffs(pair_key, voter_id, winner_id, loser_id) VALUES(?,?,?,?)')
        .run(key, voterId || 'legacy', winnerId, winnerId === a ? b : a);
    }
    for (const [pid, voters] of Object.entries(old.ratings || {})) {
      for (const [voterId, score] of Object.entries(voters)) {
        db.prepare('INSERT OR REPLACE INTO ratings(person_id, voter_id, score) VALUES(?,?,?)')
          .run(pid, voterId, score);
      }
    }
    db.exec('COMMIT');
    fs.renameSync(legacy, legacy + '.migrated');
    console.log('migrated legacy votes from', path.basename(legacy));
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('json migration failed:', e.message);
  }
})();

const q = {
  player: db.prepare('SELECT rating, wins, losses FROM players WHERE person_id = ?'),
  upsertPlayer: db.prepare(`INSERT INTO players(person_id, rating, wins, losses) VALUES(?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET rating=excluded.rating, wins=excluded.wins, losses=excluded.losses`),
  faceoffExists: db.prepare('SELECT 1 AS x FROM faceoffs WHERE pair_key = ?'),
  insertFaceoff: db.prepare('INSERT INTO faceoffs(pair_key, voter_id, winner_id, loser_id) VALUES(?,?,?,?)'),
  ratingStats: db.prepare('SELECT AVG(score) AS avg, COUNT(*) AS count FROM ratings WHERE person_id = ?'),
  myScore: db.prepare('SELECT score FROM ratings WHERE person_id = ? AND voter_id = ?'),
  upsertRating: db.prepare(`INSERT INTO ratings(person_id, voter_id, score) VALUES(?,?,?)
    ON CONFLICT(person_id, voter_id) DO UPDATE SET score=excluded.score, updated_at=datetime('now')`),
  totalFaceoffs: db.prepare('SELECT COUNT(*) AS n FROM faceoffs'),
  totalRatings: db.prepare('SELECT COUNT(*) AS n FROM ratings'),
  voterPairs: db.prepare('SELECT pair_key FROM faceoffs WHERE voter_id = ?'),
};

// ---------- voter identity: IP + cookie ----------
function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function getVoter(req, res) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';')
    .map(c => c.trim().split('=')).filter(kv => kv.length === 2));
  let uid = cookies['igl_voter'];
  if (!uid || !/^[a-f0-9]{32}$/.test(uid)) {
    uid = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie',
      `igl_voter=${uid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  }
  return crypto.createHash('sha256').update(getIp(req) + '|' + uid).digest('hex').slice(0, 24);
}

// ---------- stats ----------
function playerRow(id) {
  return q.player.get(id) || { rating: 1000, wins: 0, losses: 0 };
}
function applyFaceoff(winnerId, loserId, voterId, key) {
  const K = 32;
  const w = playerRow(winnerId), l = playerRow(loserId);
  const expW = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
  const newW = w.rating + K * (1 - expW);
  const newL = l.rating - K * (1 - expW);
  db.exec('BEGIN');
  try {
    q.insertFaceoff.run(key, voterId, winnerId, loserId);
    q.upsertPlayer.run(winnerId, newW, w.wins + 1, w.losses);
    q.upsertPlayer.run(loserId, newL, l.wins, l.losses + 1);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return { winnerDelta: Math.round(newW - w.rating), loserDelta: Math.round(newL - l.rating),
           winnerElo: Math.round(newW), loserElo: Math.round(newL) };
}
function personOut(p, voterId) {
  const pl = playerRow(p.id);
  const rs = q.ratingStats.get(p.id);
  const mine = voterId ? q.myScore.get(p.id, voterId) : null;
  return {
    id: p.id, name: p.name, type: p.type, panels: p.panels, blurb: p.blurb,
    photo: fs.existsSync(path.join(PUBLIC, 'photos', p.id + '.jpg')) ? `/photos/${p.id}.jpg` : null,
    wiki: p.wiki || null, insta: p.insta || null, joke: p.joke || null,
    showScore: p.showScore ?? null,
    elo: Math.round(pl.rating), wins: pl.wins, losses: pl.losses,
    avgScore: rs.count ? Math.round(rs.avg * 100) / 100 : null,
    scoreCount: rs.count,
    myScore: mine ? mine.score : null,
  };
}

function inPool(p, pool) {
  switch (pool) {
    case 'panel': return p.type === 'panel';
    case 'contestant': return p.type === 'contestant';
    case 's1': return p.panels.some(x => x.startsWith('S1'));
    case 's2': return p.panels.some(x => x.startsWith('S2'));
    case 'panel-s1': return p.type === 'panel' && p.panels.some(x => x.startsWith('S1'));
    case 'panel-s2': return p.type === 'panel' && p.panels.some(x => x.startsWith('S2'));
    default: return true;
  }
}
function pairKey(voterId, a, b) { return voterId + '|' + [a, b].sort().join('|'); }

// ---------- api ----------
function api(req, res, url, body) {
  const voterId = getVoter(req, res);
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && url.pathname === '/api/people') {
    return send(200, { voterId, people: PEOPLE.map(p => personOut(p, voterId)) });
  }

  if (req.method === 'GET' && url.pathname === '/api/matchup') {
    const pool = url.searchParams.get('pool') || 'all';
    const cands = PEOPLE.filter(p => inPool(p, pool));
    if (cands.length < 2) return send(400, { error: 'pool too small' });
    const seen = new Set(q.voterPairs.all(voterId).map(r => r.pair_key));
    // contestants never face panelists — pairs always share a type;
    // try to find a pair this voter hasn't judged yet
    let a, b;
    for (let i = 0; i < 60; i++) {
      a = cands[Math.floor(Math.random() * cands.length)];
      const sameType = cands.filter(p => p.type === a.type && p.id !== a.id);
      if (!sameType.length) continue;
      b = sameType[Math.floor(Math.random() * sameType.length)];
      if (!seen.has(pairKey(voterId, a.id, b.id))) break;
    }
    if (!b || a.id === b.id) b = cands.find(p => p.type === a.type && p.id !== a.id);
    if (!b) return send(400, { error: 'pool too small' });
    return send(200, { a: personOut(a, voterId), b: personOut(b, voterId) });
  }

  if (req.method === 'POST' && url.pathname === '/api/faceoff') {
    const { winnerId, loserId } = body || {};
    if (!PEOPLE_BY_ID.has(winnerId) || !PEOPLE_BY_ID.has(loserId) || winnerId === loserId)
      return send(400, { error: 'bad ids' });
    if (PEOPLE_BY_ID.get(winnerId).type !== PEOPLE_BY_ID.get(loserId).type)
      return send(400, { error: 'contestants and panelists never face off' });
    const key = pairKey(voterId, winnerId, loserId);
    if (q.faceoffExists.get(key)) return send(200, { ok: true, duplicate: true });
    const deltas = applyFaceoff(winnerId, loserId, voterId, key);
    return send(200, { ok: true, ...deltas });
  }

  if (req.method === 'POST' && url.pathname === '/api/score') {
    const { personId } = body || {};
    const score = Number(body && body.score);
    if (!PEOPLE_BY_ID.has(personId)) return send(400, { error: 'bad id' });
    if (!Number.isInteger(score) || score < 0 || score > 10)
      return send(400, { error: 'score must be an integer 0-10' });
    q.upsertRating.run(personId, voterId, score);
    const p = personOut(PEOPLE_BY_ID.get(personId), voterId);
    return send(200, { ok: true, avgScore: p.avgScore, scoreCount: p.scoreCount });
  }

  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const people = PEOPLE.map(p => personOut(p, voterId));
    const hot = [...people].sort((x, y) => y.elo - x.elo);
    const judged = people.filter(p => p.type === 'contestant')
      .sort((x, y) => (y.avgScore ?? -1) - (x.avgScore ?? -1));
    // Audience Winners: contestants whose real show score matches the app audience average
    const audienceWinners = judged.filter(p =>
      p.showScore !== null && p.avgScore !== null && Math.abs(p.avgScore - p.showScore) <= 0.5);
    const totals = {
      faceoffVotes: q.totalFaceoffs.get().n,
      scoreVotes: q.totalRatings.get().n,
      people: PEOPLE.length,
    };
    return send(200, { hot, judged, audienceWinners, totals });
  }

  send(404, { error: 'not found' });
}

// ---------- static ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const ROUTES = { '/': 'index.html', '/judge': 'judge.html', '/leaderboard': 'leaderboard.html' };

function serveStatic(req, res, url) {
  let rel = ROUTES[url.pathname] || url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw || '{}'); } catch {}
        try { api(req, res, url, body); } catch (e) { console.error(e); res.writeHead(500); res.end(); }
      });
    } else {
      try { api(req, res, url, null); } catch (e) { console.error(e); res.writeHead(500); res.end(); }
    }
  } else {
    serveStatic(req, res, url);
  }
}).listen(PORT, () => console.log(`India's Got Latent: Hot or Not → http://localhost:${PORT} (db: ${DB_PATH})`));
