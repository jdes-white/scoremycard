// Builds a compact id -> name/pos/team lookup so it fits through size-limited fetch tools.
// One line per player: id|Name|POS|TEAM   (fantasy-relevant, currently on a team)
const fs = require('fs');
const path = require('path');

(async () => {
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error('players fetch failed: ' + res.status);
  const players = await res.json();
  const keep = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
  const lines = Object.entries(players)
    .filter(([, p]) => p && p.team && (p.fantasy_positions || []).some(x => keep.has(x)))
    .map(([id, p]) => {
      const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
      return `${id}|${name}|${p.position}|${p.team}`;
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out = ['# id|name|pos|team  (generated ' + new Date().toISOString() + ')', ...lines].join('\n') + '\n';
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'players-lite.txt'), out);
  console.log(`Wrote ${lines.length} players, ${out.length} bytes`);
})().catch(e => { console.error(e); process.exit(1); });
