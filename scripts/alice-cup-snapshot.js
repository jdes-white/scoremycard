const fs = require('fs');
const path = require('path');

const LEAGUE_ID = "1387685374553251840";

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

function displayName(p) {
  if (!p) return null;
  return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
}

function isRelevantPosition(p) {
  const fp = p.fantasy_positions || [];
  return fp.includes('QB') || fp.includes('RB') || fp.includes('WR') ||
         fp.includes('TE') || fp.includes('K')  || fp.includes('DEF');
}

async function main() {
  const [players, rosters, users] = await Promise.all([
    fetchJSON('https://api.sleeper.app/v1/players/nfl'),
    fetchJSON(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`),
    fetchJSON(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`)
  ]);

  const usersById = {};
  users.forEach(u => { usersById[u.user_id] = u; });

  const rosteredIds = new Set();
  rosters.forEach(r => (r.players || []).forEach(pid => rosteredIds.add(pid)));

  const freeAgents = Object.keys(players)
    .filter(pid => !rosteredIds.has(pid))
    .map(pid => players[pid])
    .filter(p => p && p.team && isRelevantPosition(p))
    .map(p => ({
      name: displayName(p),
      position: p.position,
      team: p.team,
      injury_status: p.injury_status || null
    }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const rosterSummaries = rosters.map(r => {
    const owner = usersById[r.owner_id];
    const teamName = (owner && owner.metadata && owner.metadata.team_name) || (owner && owner.display_name) || `Roster ${r.roster_id}`;
    const rosterPlayers = (r.players || [])
      .map(pid => players[pid])
      .filter(Boolean)
      .map(p => ({ name: displayName(p), position: p.position, team: p.team }));
    return {
      roster_id: r.roster_id,
      team_name: teamName,
      owner: owner ? owner.display_name : null,
      players: rosterPlayers
    };
  });

  const snapshot = {
    league_id: LEAGUE_ID,
    generated_at: new Date().toISOString(),
    free_agent_count: freeAgents.length,
    free_agents: freeAgents,
    rosters: rosterSummaries
  };

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'alice-cup-pool.json'), JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${freeAgents.length} free agents and ${rosterSummaries.length} rosters.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
