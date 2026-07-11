// India's Got Latent · Funny or Not — Cloudflare Worker backend (D1).
// Ports the same API as server.js. D1 is SQLite, so the SQL is unchanged; only
// the runtime (fetch handler + async D1 + Web Crypto) differs.
//
// Bindings/vars (wrangler.toml + secrets):
//   DB              D1 database
//   ALLOWED_ORIGIN  e.g. https://igl.loukik.dev (CORS + cross-site)
//   STATS_KEY       secret; protects /api/stats
//   BLOCKED_IPS     optional comma-separated denylist

import PEOPLE from '../../data.js';
import PHOTO_IDS from './photos.js';

const PHOTOS = new Set(PHOTO_IDS);
const VISIBLE = PEOPLE.filter(p => !p.hidden);
const BY_ID = new Map(PEOPLE.map(p => [p.id, p]));
const VALID_EVENTS = new Set(['visit', 'leaderboard_view', 'leaderboard_interact', 'judge_view']);

// ---------- helpers ----------
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getVoter(request) {
  const token = request.headers.get('x-igl-voter');
  if (token && /^[a-f0-9]{32}$/.test(token)) return (await sha256hex('t:' + token)).slice(0, 24);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return (await sha256hex('ip:' + ip)).slice(0, 24);
}
function pairKey(vid, a, b) { return vid + '|' + [a, b].sort().join('|'); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
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
function corsHeaders(origin, env) {
  const h = { 'Content-Type': 'application/json' };
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
    h['Access-Control-Allow-Headers'] = 'Content-Type, x-igl-voter, x-igl-session, ngrok-skip-browser-warning';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Vary'] = 'Origin';
  }
  return h;
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers });

// ---- Turnstile (proof-of-human) + signed session tokens ----
// Flow: browser solves Turnstile once -> POST /api/session verifies it and mints a
// short-lived HMAC session bound to the voter id -> votes carry x-igl-session.
// The session secret never leaves the Worker, so an outsider can't forge one; a
// scripted Sybil now has to solve a fresh Turnstile per fake identity.
async function verifyTurnstile(env, token, ip) {
  if (!token || !env.TURNSTILE_SECRET) return false;
  const form = new URLSearchParams();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function mintSession(env, vid, ttlSec = 1800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${vid}.${exp}`;
  return { session: `${payload}.${await hmacHex(env.SESSION_SECRET, payload)}`, exp };
}
async function validSession(env, vid, token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tvid, exp, sig] = parts;
  if (tvid !== vid || !/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.SESSION_SECRET, `${tvid}.${exp}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

function personOut(p, ctx) {
  const pl = ctx.players[p.id] || { rating: 1000, wins: 0, losses: 0 };
  const rs = ctx.rstats[p.id];
  return {
    id: p.id, name: p.name, type: p.type, panels: p.panels, blurb: p.blurb,
    photo: PHOTOS.has(p.id) ? `/photos/${p.id}.jpg` : null,
    wiki: p.wiki || null, insta: p.insta || null, joke: p.joke || null, jokeBy: p.jokeBy || null,
    showScore: p.showScore ?? null,
    elo: Math.round(pl.rating), wins: pl.wins, losses: pl.losses,
    avgScore: rs ? Math.round(rs.avg * 100) / 100 : null,
    scoreCount: rs ? rs.cnt : 0,
    myScore: ctx.myScores[p.id] ?? null,
  };
}
// One batched read of everything personOut needs (avoids per-person queries).
async function loadContext(env, vid) {
  const players = {}, rstats = {}, myScores = {};
  const pr = await env.DB.prepare('SELECT person_id, rating, wins, losses FROM players').all();
  for (const r of pr.results) players[r.person_id] = r;
  const rr = await env.DB.prepare('SELECT person_id, AVG(score) AS avg, COUNT(*) AS cnt FROM ratings GROUP BY person_id').all();
  for (const r of rr.results) rstats[r.person_id] = { avg: r.avg, cnt: r.cnt };
  if (vid) {
    const ms = await env.DB.prepare('SELECT person_id, score FROM ratings WHERE voter_id = ?').bind(vid).all();
    for (const r of ms.results) myScores[r.person_id] = r.score;
  }
  return { players, rstats, myScores };
}
// Normalize a client IP to a rate-limit key. IPv6 addresses rotate per-connection,
// so a /128 limit is trivially evaded; key IPv6 by its /64 network prefix (the typical
// single-customer allocation). IPv4 keeps its full address.
function ipKey(ip) {
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}
// Per-IP flood guard: increment this IP-key's count for the current unix-minute and
// return true if it now exceeds `limit`. Deliberately tight (40/min); the fastest real
// single-user burst was 44/min, so an extreme-fast voter or a busy shared /64 may
// occasionally get 429'd. Scripted floods get 429'd immediately.
async function rateLimited(env, ip, limit = 40) {
  const row = await env.DB.prepare(
    `INSERT INTO rate(ip, bucket, n) VALUES(?1, CAST(strftime('%s','now') AS INTEGER) / 60, 1)
     ON CONFLICT(ip, bucket) DO UPDATE SET n = n + 1 RETURNING n`).bind(ip).first();
  // opportunistic cleanup when a fresh minute-bucket opens (keeps the table tiny)
  if (row.n === 1) {
    await env.DB.prepare(`DELETE FROM rate WHERE bucket < CAST(strftime('%s','now') AS INTEGER) / 60 - 5`).run();
  }
  return row.n > limit;
}
async function playerRow(env, id) {
  return (await env.DB.prepare('SELECT rating, wins, losses FROM players WHERE person_id = ?').bind(id).first())
    || { rating: 1000, wins: 0, losses: 0 };
}
const upsertPlayer = (env, id, rating, wins, losses) =>
  env.DB.prepare(`INSERT INTO players(person_id, rating, wins, losses) VALUES(?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET rating=excluded.rating, wins=excluded.wins, losses=excluded.losses`)
    .bind(id, rating, wins, losses);

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // IP denylist
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const blocked = (env.BLOCKED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ip && blocked.includes(ip)) return json({ error: 'forbidden' }, 403, cors);

    const path = url.pathname;
    const method = request.method;
    const vid = await getVoter(request);
    let body = {};
    if (method === 'POST') { try { body = await request.json(); } catch {} }

    try {
      if (method === 'GET' && path === '/api/me') {
        const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM faceoffs WHERE voter_id = ?').bind(vid).first()).n;
        return json({ voterId: vid, myVotes: n }, 200, cors);
      }

      // Verify a Turnstile token and mint a signed session bound to this voter.
      if (method === 'POST' && path === '/api/session') {
        if (ip && await rateLimited(env, ipKey(ip), 40)) return json({ error: 'Whoa, slow down a sec.' }, 429, cors);
        if (!(await verifyTurnstile(env, body && body.token, ip)))
          return json({ error: 'verification failed' }, 403, cors);
        const { session, exp } = await mintSession(env, vid);
        return json({ ok: true, session, exp }, 200, cors);
      }

      if (method === 'GET' && path === '/api/people') {
        const ctx = await loadContext(env, vid);
        return json({ voterId: vid, people: VISIBLE.map(p => personOut(p, ctx)) }, 200, cors);
      }

      if (method === 'GET' && path === '/api/matchup') {
        const pool = url.searchParams.get('pool') || 'all';
        const cands = VISIBLE.filter(p => inPool(p, pool));
        if (cands.length < 2) return json({ error: 'pool too small' }, 400, cors);
        const ctx = await loadContext(env, vid);
        const seen = new Set((await env.DB.prepare('SELECT pair_key FROM faceoffs WHERE voter_id = ?').bind(vid).all())
          .results.map(r => r.pair_key));
        const byExposure = shuffle([...cands])
          .map(p => { const r = ctx.players[p.id] || { wins: 0, losses: 0 }; return { p, votes: r.wins + r.losses }; })
          .sort((x, y) => x.votes - y.votes);
        let a = null, b = null;
        for (const { p } of byExposure) {
          const opponents = shuffle(cands.filter(o => o.type === p.type && o.id !== p.id));
          const fresh = opponents.find(o => !seen.has(pairKey(vid, p.id, o.id)));
          if (fresh) { a = p; b = fresh; break; }
        }
        if (!a) {
          a = byExposure[0].p;
          const opponents = cands.filter(o => o.type === a.type && o.id !== a.id);
          b = opponents[Math.floor(Math.random() * opponents.length)];
        }
        if (!a || !b) return json({ error: 'pool too small' }, 400, cors);
        return json({ a: personOut(a, ctx), b: personOut(b, ctx) }, 200, cors);
      }

      if (method === 'POST' && path === '/api/faceoff') {
        // per-IP flood guard (40 votes/min/IP, IPv6 keyed by /64). Reads/matchups are unlimited.
        if (ip && await rateLimited(env, ipKey(ip), 40)) return json({ error: 'Whoa, slow down a sec.' }, 429, cors);
        // proof-of-human gate (flip on via ENFORCE_SESSION once the frontend is shipping sessions)
        if (env.ENFORCE_SESSION === 'true' && !(await validSession(env, vid, request.headers.get('x-igl-session'))))
          return json({ error: 'verification required', needSession: true }, 403, cors);
        const { winnerId, loserId } = body || {};
        if (!BY_ID.has(winnerId) || !BY_ID.has(loserId) || winnerId === loserId)
          return json({ error: 'bad ids' }, 400, cors);
        if (BY_ID.get(winnerId).type !== BY_ID.get(loserId).type)
          return json({ error: 'contestants and panelists never face off' }, 400, cors);
        if (BY_ID.get(winnerId).hidden || BY_ID.get(loserId).hidden)
          return json({ error: 'person not available' }, 400, cors);
        const key = pairKey(vid, winnerId, loserId);
        if (await env.DB.prepare('SELECT 1 AS x FROM faceoffs WHERE pair_key = ?').bind(key).first())
          return json({ ok: true, duplicate: true }, 200, cors);
        const w = await playerRow(env, winnerId), l = await playerRow(env, loserId);
        const K = 32, expW = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
        const newW = w.rating + K * (1 - expW), newL = l.rating - K * (1 - expW);
        await env.DB.batch([
          env.DB.prepare('INSERT INTO faceoffs(pair_key, voter_id, winner_id, loser_id) VALUES(?,?,?,?)')
            .bind(key, vid, winnerId, loserId),
          upsertPlayer(env, winnerId, newW, w.wins + 1, w.losses),
          upsertPlayer(env, loserId, newL, l.wins, l.losses + 1),
        ]);
        const myVotes = (await env.DB.prepare('SELECT COUNT(*) AS n FROM faceoffs WHERE voter_id = ?').bind(vid).first()).n;
        return json({ ok: true, winnerDelta: Math.round(newW - w.rating), loserDelta: Math.round(newL - l.rating),
          winnerElo: Math.round(newW), loserElo: Math.round(newL), myVotes }, 200, cors);
      }

      if (method === 'POST' && path === '/api/score') {
        const { personId } = body || {};
        const score = Number(body && body.score);
        if (!BY_ID.has(personId) || BY_ID.get(personId).hidden) return json({ error: 'bad id' }, 400, cors);
        if (!Number.isInteger(score) || score < 0 || score > 10)
          return json({ error: 'score must be an integer 0-10' }, 400, cors);
        await env.DB.prepare(`INSERT INTO ratings(person_id, voter_id, score) VALUES(?,?,?)
          ON CONFLICT(person_id, voter_id) DO UPDATE SET score=excluded.score, updated_at=datetime('now')`)
          .bind(personId, vid, score).run();
        const rs = await env.DB.prepare('SELECT AVG(score) AS avg, COUNT(*) AS cnt FROM ratings WHERE person_id = ?').bind(personId).first();
        return json({ ok: true, avgScore: rs.cnt ? Math.round(rs.avg * 100) / 100 : null, scoreCount: rs.cnt }, 200, cors);
      }

      if (method === 'GET' && path === '/api/leaderboard') {
        const ctx = await loadContext(env, vid);
        const people = VISIBLE.map(p => personOut(p, ctx));
        const hot = [...people].sort((x, y) => y.elo - x.elo);
        const judged = people.filter(p => p.type === 'contestant').sort((x, y) => (y.avgScore ?? -1) - (x.avgScore ?? -1));
        const audienceWinners = judged.filter(p =>
          p.showScore !== null && p.avgScore !== null && Math.abs(p.avgScore - p.showScore) <= 0.5);
        const totals = {
          faceoffVotes: (await env.DB.prepare('SELECT COUNT(*) AS n FROM faceoffs').first()).n,
          scoreVotes: (await env.DB.prepare('SELECT COUNT(*) AS n FROM ratings').first()).n,
          people: VISIBLE.length,
        };
        return json({ hot, judged, audienceWinners, totals }, 200, cors);
      }

      if (method === 'POST' && path === '/api/event') {
        if (VALID_EVENTS.has(body && body.event))
          await env.DB.prepare('INSERT INTO events(voter_id, event) VALUES(?,?)').bind(vid, body.event).run();
        return json({ ok: true }, 200, cors);
      }

      if (method === 'GET' && path === '/api/stats') {
        if (env.STATS_KEY && url.searchParams.get('key') !== env.STATS_KEY)
          return json({ error: 'forbidden' }, 403, cors);
        const n = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()).n;
        const evt = e => n('SELECT COUNT(DISTINCT voter_id) AS n FROM events WHERE event = ?', e);
        const byDay = (await env.DB.prepare(
          `SELECT substr(created_at,1,10) AS day, COUNT(DISTINCT voter_id) AS visitors
             FROM events GROUP BY day ORDER BY day DESC LIMIT 30`).all()).results;
        return json({
          uniqueVisitors: await n('SELECT COUNT(DISTINCT voter_id) AS n FROM events'),
          pageviews: await n("SELECT COUNT(*) AS n FROM events WHERE event = 'visit'"),
          faceoffVoters: await n('SELECT COUNT(DISTINCT voter_id) AS n FROM faceoffs'),
          faceoffVotes: await n('SELECT COUNT(*) AS n FROM faceoffs'),
          scoreVoters: await n('SELECT COUNT(DISTINCT voter_id) AS n FROM ratings'),
          scoreVotes: await n('SELECT COUNT(*) AS n FROM ratings'),
          leaderboardViewers: await evt('leaderboard_view'),
          leaderboardInteractors: await evt('leaderboard_interact'),
          judgeViewers: await evt('judge_view'),
          visitorsByDay: byDay,
        }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server error', detail: String(e && e.message || e) }, 500, cors);
    }
  },
};
