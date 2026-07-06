# India's Got Latent · Funny or Not

A public voting site for the panelists of *India's Got Latent* (Seasons 1 & 2).
Two panelists face off, you pick the funnier one, and a shared Elo ranking builds
in real time. Comedy is subjective. We're settling it anyway.

**Live:** https://igl.loukik.dev

- **Face-off:** two cards, pick the funnier. Swipe (Tinder-style), tap, or use the arrow keys.
- **Leaderboard:** live Elo rankings, search, and a click-through profile for every
  panelist (photo, episodes, memorable line, Instagram, record). Unlocks after you
  vote in 10 face-offs.
- **Judge mode:** score contestants 0 to 10 like the panel does. Currently switched
  off in the UI (the `SHOW_CONTESTANTS` flag) while the roster is panelist-only.

## Stack

Deliberately minimal: one Node file plus plain HTML/CSS/JS. No build, no framework,
almost no dependencies.

- Backend: `server.js` serves the frontend and the `/api/*` endpoints. Votes are
  stored in **SQLite** via Node's built-in `node:sqlite` (needs **Node 22.5+**).
- Frontend: `public/` has `index.html` (face-off), `leaderboard.html`, `judge.html`,
  `stats.html`, plus shared `app.js` and `app.css`. Two themes (dark-black,
  light-white) via CSS variables.
- Data: `data.js` is the roster of ~97 people with episodes, blurbs, memorable
  lines, and Instagram links.

## Run locally

```bash
npm start          # http://localhost:3000 (serves frontend + API together)
```

Optional env vars: `PORT`, `DB_PATH` (SQLite file location), `ALLOWED_ORIGIN`
(enable CORS for a separate frontend origin), `STATS_KEY` (protect the analytics
dashboard at `/stats`).

## How voting works

- Each visitor gets an anonymous voter token (in `localStorage`, sent as a header)
  so votes persist across every browser, including iOS Safari, which blocks the
  cross-site cookies this originally relied on.
- One face-off vote per unordered pair per voter. Matchups are fairness-weighted:
  the least-voted person appears first, against a random opponent you haven't judged.
  Contestants and panelists never face each other.
- The leaderboard unlocks after 10 face-off votes, so everyone contributes before
  peeking.
- Everything lives in `votes.sqlite` (WAL mode), snapshotted to `backups/` on each
  boot. Never delete it to reset; run a SQL `DELETE` instead.

## Editing the roster (`data.js`)

Each entry looks like `{ id, name, type, panels, blurb, joke?, wiki?, insta?,
showScore? }`. Add a person by appending an object; the site picks it up on the
next backend start. Drop a `photos/<id>.jpg` for their picture (portrait, roughly
4:4.4, face near the top).

Episode facts (winners, scores, contestants, memorable lines) are mined from
transcribed episodes; see `scripts/transcribe_s1.py` and `transcripts/`. Jokes are
only added when confidently attributable. Nothing is fabricated.

## Deployment

Frontend on GitHub Pages (`igl.loukik.dev`); backend runs locally and is exposed via
ngrok. The full walkthrough (DNS, the Actions workflow, and pointing the frontend
at the backend through the `API_BASE` repo variable) is in **[DEPLOY.md](DEPLOY.md)**.

## Repo layout

```
server.js                     backend: static serving + /api + SQLite
data.js                       the roster (source of truth for people)
public/                       the deployed frontend
  index / leaderboard / judge / stats .html
  app.js  app.css  config.js
  photos/<id>.jpg
scripts/transcribe_s1.py      episode audio to mlx-whisper transcripts
transcripts/                  per-episode transcripts + video-id map
.github/workflows/            GitHub Pages deploy (injects config.js)
CLAUDE.md                     working notes and conventions
DEPLOY.md                     deployment guide
```

The data is the fun part to contribute to: better photos, confirmed Instagram
handles, and memorable episode quotes all live in `data.js` and `public/photos/`.
