# India's Got Latent, Hot or Not

Public voting app for IGL Season 1 & 2 panel members and contestants. Zero dependencies, just Node 18+.

```bash
npm start          # → http://localhost:3000
```

## Pages

| URL | What |
|---|---|
| `/` | **Face-Off**, two cards, click the hotter one. Elo ranking, one vote per matchup per voter. |
| `/judge` | **Judge Mode**, score contestants 0–10 like the panel. Reveals the audience average after each score, episode recap at the end. |
| `/leaderboard` | **Leaderboard**, Elo hotness ranking, contestant score averages, and the Audience Winners section. |

## How voting works

- Voter identity = SHA-256 of (IP + a cookie UUID). One face-off vote per pair, one (updatable) score per contestant per voter.
- Votes live in SQLite (`votes.sqlite`, WAL mode) via Node's built-in `node:sqlite` (Node 22.5+). Set `DB_PATH` to a persistent volume path in production. The DB is snapshotted into `backups/` on every boot, and any legacy `db.json` is migrated automatically on first run.
- **Audience Winners**: a contestant appears there when the rounded audience average equals `showScore`, the score they actually got on the show.

## Maintaining the data (`data.js`)

- `showScore`, mostly `null` because scores aren't documented anywhere; fill them in as you rewatch episodes to power the Audience Winners section. (DDSRY's 7 is already in.)
- Names tagged `[verify]` came from episode listings that only had partial names, fix if you know better.
- `panels`, which panels each person sat on (guests like Aashish Solanki have several).

## Photos

Resolution order per person:
1. `public/photos/<id>.jpg`, drop your own screenshots/episode stills here (best option for contestants)
2. Wikipedia thumbnail (auto-fetched for people with a `wiki` field)
3. Fallback tile with initials + name + what they did in the episode

Google Images can't be scraped reliably (and legally it's murky), so manual stills in `photos/` is the intended path for contestants.
