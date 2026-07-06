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

const API = {
  get: (u) => fetch(u).then(r => r.json()),
  post: (u, body) => fetch(u, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()),
};

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
  if (p.photo) return p.photo;               // server-verified local photo
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
    ${p.joke ? `<div class="joke">“${p.joke}”</div>` : ''}
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
  const here = location.pathname === '/' ? '/' : location.pathname.replace(/\/$/, '');
  document.querySelectorAll('nav .links a').forEach(a => {
    if (a.getAttribute('href') === here) a.classList.add('active');
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
      ${p.joke ? `<div class="joke" style="margin-top:14px">“${p.joke}”</div>` : ''}
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
  document.querySelectorAll('nav .links a[href="/leaderboard"]').forEach(link => {
    if (votes >= LEADERBOARD_UNLOCK) {
      link.classList.remove('lockedLink');
      link.textContent = '🏆 Leaderboard';
      link.title = '';
      link.onclick = null;
    } else {
      link.classList.add('lockedLink');
      link.textContent = `🔒 Leaderboard ${votes}/${LEADERBOARD_UNLOCK}`;
      link.title = `Decide ${LEADERBOARD_UNLOCK - votes} more face-offs to unlock the leaderboard`;
      link.onclick = e => e.preventDefault();
    }
  });
}
document.addEventListener('DOMContentLoaded', async () => {
  paintLeaderboardLink(await myVotes());
});
