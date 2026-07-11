// UI flag: contestants hidden for now — flip to true to bring them back
const SHOW_CONTESTANTS = false;

// ---- theme: 'black' (dark) or 'white' (light), persisted ----
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('igl_theme', t);
  document.querySelectorAll('.themeToggle').forEach(b => b.textContent = t === 'black' ? '☀️' : '🌙');
}
function toggleTheme() {
  applyTheme((localStorage.getItem('igl_theme') || 'black') === 'black' ? 'white' : 'black');
}
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(localStorage.getItem('igl_theme') || 'black');
  document.querySelectorAll('.themeToggle').forEach(b => b.onclick = toggleTheme);
});

// Shared helpers: API, photos, card rendering.

// API base: '' for same-origin (local dev), or an absolute backend URL (Pages + ngrok).
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) || '';
// Durable anonymous voter id in localStorage (works where 3rd-party cookies are blocked, e.g. iOS Safari).
function voterToken() {
  let t = localStorage.getItem('igl_voter_token');
  if (!t || !/^[a-f0-9]{32}$/.test(t)) {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    t = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('igl_voter_token', t);
  }
  return t;
}
const API_HEADERS = { 'ngrok-skip-browser-warning': 'true', 'x-igl-voter': voterToken() };
const API = {
  get: (u) => fetch(API_BASE + u, { credentials: 'include', headers: API_HEADERS }).then(r => r.json()),
  post: (u, body, extra = {}) => fetch(API_BASE + u, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...API_HEADERS, ...extra }, body: JSON.stringify(body),
  }).then(r => r.json()),
};

// ---- Turnstile proof-of-human -> signed session (attached to votes) ----
// Solve Turnstile once (invisible/managed), exchange it for a short-lived signed
// session from the Worker, then carry that session on every vote. A scripted
// outsider has no valid session and (once ENFORCE_SESSION is on) can't vote.
const TURNSTILE_SITEKEY = '0x4AAAAAADz7iDpkaXrOP7NA';
let _tsWidget = null, _tsResolver = null;
function _whenTurnstile() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    let n = 0;
    const iv = setInterval(() => {
      if (window.turnstile) { clearInterval(iv); resolve(); }
      else if (++n > 100) { clearInterval(iv); reject(new Error('turnstile load timeout')); }
    }, 100);
  });
}
function _tsSettle(token) {
  const box = document.getElementById('tsBox'); if (box) box.style.display = 'none';
  const r = _tsResolver; _tsResolver = null; if (r) r(token);
}
async function freshTurnstileToken() {
  await _whenTurnstile();
  const box = document.getElementById('tsBox'); if (!box) throw new Error('no widget container');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { _tsResolver = null; box.style.display = 'none'; reject(new Error('turnstile timeout')); }, 25000);
    _tsResolver = (t) => { clearTimeout(timer); resolve(t); };
    box.style.display = 'block';
    try {
      if (_tsWidget === null) {
        _tsWidget = window.turnstile.render('#tsBox', {
          sitekey: TURNSTILE_SITEKEY, callback: _tsSettle,
          'error-callback': () => {}, 'expired-callback': () => {},
        });
      } else {
        window.turnstile.reset(_tsWidget);
      }
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}
let _session = localStorage.getItem('igl_session') || null;
let _sessionExp = +(localStorage.getItem('igl_session_exp') || 0);
let _sessionInflight = null;
async function ensureSession() {
  if (_session && Date.now() < _sessionExp - 60000) return _session;   // still fresh (>1 min left)
  if (_sessionInflight) return _sessionInflight;
  _sessionInflight = (async () => {
    const token = await freshTurnstileToken();
    const res = await API.post('/api/session', { token });
    if (!res || !res.session) throw new Error('session mint failed');
    _session = res.session; _sessionExp = res.exp * 1000;
    localStorage.setItem('igl_session', _session);
    localStorage.setItem('igl_session_exp', String(_sessionExp));
    return _session;
  })();
  try { return await _sessionInflight; } finally { _sessionInflight = null; }
}
// Post a vote with a valid session; if the server says the session lapsed, re-verify once.
async function submitVote(winnerId, loserId) {
  let s = null;
  try { s = await ensureSession(); } catch {}
  let res = await API.post('/api/faceoff', { winnerId, loserId }, s ? { 'x-igl-session': s } : {});
  if (res && res.needSession) {
    _session = null; _sessionExp = 0;
    localStorage.removeItem('igl_session'); localStorage.removeItem('igl_session_exp');
    try { s = await ensureSession(); } catch { s = null; }
    if (s) res = await API.post('/api/faceoff', { winnerId, loserId }, { 'x-igl-session': s });
  }
  return res;
}

// deterministic gradient per person for fallback tiles
function hueOf(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function initials(name) {
  return name.split(/[\s&]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// Photo resolution order:
//   1. /photos/<id>.jpg (drop your own images in the photos/ folder)
//   2. Wikipedia thumbnail (if the person has a wiki page title in data.js)
//   3. Styled fallback tile: initials + name + what they did in the episode
const photoCache = {};
async function resolvePhoto(p) {
  if (p.photo) return p.photo.replace(/^\//, '');   // relative so it works under a Pages subpath
  if (!p.wiki) return null;
  if (p.id in photoCache) return photoCache[p.id];
  const ls = localStorage.getItem('igl_wiki_' + p.id);
  if (ls !== null) return (photoCache[p.id] = ls === 'none' ? null : ls);
  let url = null;
  let definitive = true;
  try {
    const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' +
      encodeURIComponent(p.wiki.replace(/ /g, '_')));
    if (r.ok) {
      const j = await r.json();
      url = (j.thumbnail && j.thumbnail.source) ? j.thumbnail.source.replace(/\/\d+px-/, '/480px-') : null;
    } else if (r.status !== 404) definitive = false;
  } catch { definitive = false; }
  if (url || definitive) localStorage.setItem('igl_wiki_' + p.id, url || 'none');
  return (photoCache[p.id] = url);
}

function photoEl(p) {
  const wrap = document.createElement('div');
  wrap.className = 'photo';
  const hue = hueOf(p.id);
  wrap.innerHTML = `
    <div class="fallback">
      <div class="initials" style="background:linear-gradient(135deg,hsl(${hue},85%,60%),hsl(${(hue + 60) % 360},85%,55%))">${initials(p.name)}</div>
      <div style="font-weight:800">${p.name}</div>
      <div class="fbBlurb">${p.blurb}</div>
    </div>`;
  resolvePhoto(p).then(url => {
    if (!url) return;
    const img = new Image();
    img.onload = () => { wrap.innerHTML = ''; wrap.appendChild(img); };
    img.src = url;
    img.alt = p.name;
  });
  return wrap;
}

function personCard(p, { clickable = false } = {}) {
  const card = document.createElement('div');
  card.className = 'card' + (clickable ? ' clickable' : '');
  card.dataset.id = p.id;
  card.appendChild(photoEl(p));
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `
    <div class="name">${p.name}</div>
    <span class="role ${p.type}">${p.type === 'panel' ? 'Panel' : 'Contestant'}</span>
    <div class="panelchips">${p.panels.map(x => `<span>${x}</span>`).join('')}</div>
    <div class="blurb">${p.blurb}</div>
    ${p.joke ? `<div class="joke">“${p.joke}”${p.jokeBy ? `<span class="jokeBy">— ${p.jokeBy}</span>` : ''}</div>` : ''}
    ${p.insta ? `<a class="ig" href="https://instagram.com/${p.insta}" target="_blank" rel="noopener" onclick="event.stopPropagation()">@${p.insta}</a>` : ''}`;
  card.appendChild(meta);
  return card;
}

function miniPerson(p) {
  const hue = hueOf(p.id);
  const holder = document.createElement('div');
  holder.className = 'mini';
  holder.innerHTML = `
    <span class="dot" style="background:linear-gradient(135deg,hsl(${hue},85%,60%),hsl(${(hue + 60) % 360},85%,55%))">${initials(p.name)}</span>
    <span>${p.name}</span>`;
  resolvePhoto(p).then(url => {
    if (!url) return;
    const img = new Image();
    img.onload = () => holder.querySelector('.dot').replaceWith(img);
    img.src = url;
    img.alt = p.name;
  });
  return holder;
}

function markActiveNav() {
  const here = (location.pathname.split('/').pop() || 'index.html');
  document.querySelectorAll('nav .links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === here || (here === 'index.html' && href === 'index.html')) a.classList.add('active');
  });
}
document.addEventListener('DOMContentLoaded', markActiveNav);

// ---- person detail modal ----
function showPersonModal(p) {
  const ov = document.createElement('div');
  ov.className = 'modalOverlay';
  const seasons = p.panels.map(x => `<span>${x}</span>`).join('');
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <button class="mClose" aria-label="close">✕</button>
    <div class="mPhoto"></div>
    <div class="mBody">
      <div class="mName">${p.name}</div>
      <span class="role ${p.type}">${p.type === 'panel' ? 'Panel' : 'Contestant'}</span>
      <div class="panelchips" style="margin-top:10px">${seasons}</div>
      <div class="mStats">
        <div class="mStat"><b>${p.elo}</b><span>Elo</span></div>
        <div class="mStat"><b>${p.wins}–${p.losses}</b><span>W–L</span></div>
        ${p.avgScore !== null ? `<div class="mStat"><b>${p.avgScore}/10</b><span>Audience avg</span></div>` : ''}
        ${p.showScore !== null && p.showScore !== undefined ? `<div class="mStat"><b>${p.showScore}/10</b><span>Show score</span></div>` : ''}
      </div>
      <div class="mBlurb">${p.blurb}</div>
      ${p.joke ? `<div class="joke" style="margin-top:14px">“${p.joke}”${p.jokeBy ? `<span class="jokeBy">— ${p.jokeBy}</span>` : ''}</div>` : ''}
      ${p.insta ? `<a class="ig" href="https://instagram.com/${p.insta}" target="_blank" rel="noopener">@${p.insta}</a>` : ''}
    </div>`;
  modal.querySelector('.mPhoto').appendChild(photoEl(p));
  ov.appendChild(modal);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  modal.querySelector('.mClose').onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}

// ---- leaderboard gate: unlocks after 10 face-off votes ----
const LEADERBOARD_UNLOCK = 10;
async function myVotes() {
  try { return (await API.get('/api/me')).myVotes || 0; } catch { return 0; }
}
function paintLeaderboardLink(votes) {
  document.querySelectorAll('nav .links a[href="leaderboard.html"]').forEach(link => {
    if (votes >= LEADERBOARD_UNLOCK) {
      link.classList.remove('lockedLink');
      link.innerHTML = '🏆 <span class="navword">Leaderboard</span>';
      link.removeAttribute('data-tip');
      link.onclick = null;
    } else {
      link.classList.add('lockedLink');
      link.innerHTML = `🔒 <span class="navword">Leaderboard </span>${votes}/${LEADERBOARD_UNLOCK}`;
      const left = LEADERBOARD_UNLOCK - votes;
      link.setAttribute('data-tip',
        `Rankings unlock after ${LEADERBOARD_UNLOCK} face-off votes. ${left} to go, no shortcuts, no VIP list.`);
      link.onclick = e => e.preventDefault();
    }
  });
}
document.addEventListener('DOMContentLoaded', async () => {
  paintLeaderboardLink(await myVotes());
});

// ---- analytics beacons (privacy-light: only the anonymous voter id + event name) ----
function track(event) {
  try {
    const body = JSON.stringify({ event });
    if (!API_BASE && navigator.sendBeacon) {
      navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' }));
    } else {
      fetch(API_BASE + '/api/event', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...API_HEADERS }, body, keepalive: true }).catch(() => {});
    }
  } catch {}
}
document.addEventListener('DOMContentLoaded', () => track('visit'));

// ---- leaderboard-unlock celebration (fired from the face-off page on the 10th vote) ----
function showUnlockModal() {
  const ov = document.createElement('div');
  ov.className = 'modalOverlay';
  ov.innerHTML = `
    <div class="unlockCard">
      <div class="unlockEmoji">🏆</div>
      <h2>Leaderboard unlocked!</h2>
      <p>You've judged 10 matchups. Go see how the internet ranks everyone, and where your picks landed.</p>
      <div class="unlockBtns">
        <button class="btn primary" id="uGo">See the leaderboard →</button>
        <button class="btn" id="uStay">Keep voting</button>
      </div>
    </div>`;
  const close = () => ov.remove();
  document.body.appendChild(ov);
  ov.querySelector('#uGo').onclick = () => { location.href = 'leaderboard.html'; };
  ov.querySelector('#uStay').onclick = close;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', function esc(e){ if (e.key === 'Escape'){ close(); document.removeEventListener('keydown', esc);} });
}
