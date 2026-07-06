#!/usr/bin/env node
// Voter breakdown for the IGL votes DB. Read-only, safe to run while the server is live.
//
// Usage:
//   node scripts/voters.js          print the table once
//   node scripts/voters.js -w       live view, refresh every 5s
//   node scripts/voters.js -w 10    live view, refresh every 10s
//   DB_PATH=/path/votes.sqlite node scripts/voters.js   point at another DB

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const DB = process.env.DB_PATH || path.join(__dirname, '..', 'votes.sqlite');

function snapshot() {
  const db = new DatabaseSync(DB);           // WAL allows concurrent reads with the server
  const rows = db.prepare(
    `SELECT voter_id, COUNT(*) AS v, MIN(created_at) AS f, MAX(created_at) AS l
       FROM faceoffs GROUP BY voter_id ORDER BY v DESC`).all();
  const scores = db.prepare(`SELECT COUNT(*) AS n FROM ratings`).get().n;
  db.close();
  const totalVotes = rows.reduce((a, r) => a + r.v, 0);
  const unlocked = rows.filter(r => r.v >= 10).length;
  return { rows, totalVotes, unlocked, scores };
}

function render() {
  const { rows, totalVotes, unlocked, scores } = snapshot();
  const hm = t => (t || '').slice(11, 16);
  const out = [];
  out.push(`IGL voters  ·  ${new Date().toLocaleString()}`);
  out.push('');
  out.push('   #  voter (anon id)             votes   active window');
  out.push('  ' + '-'.repeat(66));
  rows.forEach((r, i) => {
    const win = hm(r.f) === hm(r.l) ? hm(r.f) : `${hm(r.f)}-${hm(r.l)}`;
    out.push(
      '  ' + String(i + 1).padStart(2) + '  ' +
      r.voter_id.padEnd(26) + ' ' + String(r.v).padStart(5) + '    ' + win);
  });
  out.push('  ' + '-'.repeat(66));
  const avg = rows.length ? (totalVotes / rows.length).toFixed(1) : '0';
  out.push(`  ${rows.length} voters · ${totalVotes} votes · avg ${avg} · ` +
           `${unlocked} unlocked the leaderboard (>=10)` +
           (scores ? ` · ${scores} judge scores` : ''));
  return out.join('\n');
}

const args = process.argv.slice(2);
const watch = args.includes('-w') || args.includes('--watch');
const secs = parseInt(args.find(a => /^\d+$/.test(a)), 10) || 5;

if (!watch) {
  console.log(render());
} else {
  const tick = () => { process.stdout.write('\x1b[2J\x1b[H'); console.log(render()); };
  tick();
  setInterval(tick, secs * 1000);
  console.log(`\n(refreshing every ${secs}s — Ctrl+C to stop)`);
}
