// Live, on-demand Sleeper fantasy football proxy.
//
// Design goal: NO staleness bugs, ever. There is no cron job, no committed
// snapshot file, and no CDN in front of this. Every request to /hog-market,
// /alice-cup, or /chopped triggers a fresh call to Sleeper's API right then,
// and the response is computed and returned in the same request. The only
// thing cached is Sleeper's giant (~5MB) players/nfl dictionary, which
// changes rarely (new signings/waivers to the master list, not live stats),
// and even that cache is capped at 1 hour. Rosters and users — the things
// that actually change week to week — are NEVER cached; they're fetched
// live on every single request.
//
// Cache-Control: no-store is set on every response so nothing between here
// and the requester can cache it either.

const http = require('http');

const LEAGUES = {
  'hog-market': {
    id: '1311306094580080640',
    label: 'Hog Market',
    includeKD: true, // K/DEF included in free agent pool
  },
  'alice-cup': {
    id: '1387685374553251840',
    label: 'Alice Cup',
    includeKD: true,
  },
  'chopped': {
    id: '1390614263638265856',
    label: 'Chopped',
    includeKD: false, // QB/RB/WR/TE only
  },
};

const PLAYERS_CACHE_MS = 60 * 60 * 1000; // 1 hour
let playersCache = { data: null, fetchedAt: 0 };

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
  return res.json();
}

async function getPlayers() {
  const now = Date.now();
  if (playersCache.data && (now - playersCache.fetchedAt) < PLAYERS_CACHE_MS) {
    return playersCache.data;
  }
  const data = await fetchJSON('https://api.sleeper.app/v1/players/nfl');
  playersCache = { data, fetchedAt: now };
  return data;
}

function displayName(p) {
  if (!p) return null;
  return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
}

function isRelevantPosition(p, includeKD) {
  const fp = p.fantasy_positions || [];
  const core = fp.includes('QB') || fp.includes('RB') || fp.includes('WR') || fp.includes('TE');
  if (includeKD) return core || fp.includes('K') || fp.includes('DEF');
  return core;
}

async function buildSnapshot(leagueKey) {
  const league = LEAGUES[leagueKey];
  if (!league) throw new Error(`Unknown league: ${leagueKey}`);

  const [players, rosters, users] = await Promise.all([
    getPlayers(),
    fetchJSON(`https://api.sleeper.app/v1/league/${league.id}/rosters`),
    fetchJSON(`https://api.sleeper.app/v1/league/${league.id}/users`),
  ]);

  const usersById = {};
  users.forEach(u => { usersById[u.user_id] = u; });

  const rosteredIds = new Set();
  rosters.forEach(r => (r.players || []).forEach(pid => rosteredIds.add(pid)));

  const freeAgents = Object.keys(players)
    .filter(pid => !rosteredIds.has(pid))
    .map(pid => players[pid])
    .filter(p => p && p.team && isRelevantPosition(p, league.includeKD))
    .map(p => ({
      name: displayName(p),
      position: p.position,
      team: p.team,
      injury_status: p.injury_status || null,
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
      players: rosterPlayers,
    };
  });

  return {
    league: league.label,
    league_id: league.id,
    generated_at: new Date().toISOString(),
    note: 'Computed fresh at request time. No caching of rosters/free agents — this is always current as of generated_at.',
    free_agent_count: freeAgents.length,
    free_agents: freeAgents,
    rosters: rosterSummaries,
  };
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routePath = url.pathname.replace(/^\/+|\/+$/g, ''); // strip slashes

  try {
    if (routePath === '' ) {
      sendJSON(res, 200, {
        service: 'sleeper-live-proxy',
        description: 'On-demand live Sleeper league data. Every request below is computed fresh, right now — nothing is served from a cache or a committed file.',
        endpoints: Object.keys(LEAGUES).map(k => `/${k}`),
        health: '/health',
      });
      return;
    }

    if (routePath === 'health') {
      sendJSON(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    if (LEAGUES[routePath]) {
      const snapshot = await buildSnapshot(routePath);
      sendJSON(res, 200, snapshot);
      return;
    }

    sendJSON(res, 404, { error: 'Not found', endpoints: Object.keys(LEAGUES).map(k => `/${k}`) });
  } catch (err) {
    sendJSON(res, 502, { error: String(err && err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`sleeper-live-proxy listening on ${PORT}`);
});
