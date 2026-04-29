import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3019;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_PASS = '0000';

app.use(express.json());
// This automatically serves index.html from the 'public' folder
app.use(express.static('public'));

// --- In-memory fallback ---
let mem = { 
  teams: [], 
  players: [],
  matches: [],
  teamIdSeq: 1, 
  playerIdSeq: 1,
  matchIdSeq: 1
};

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: sslOption(DATABASE_URL) });
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS teams (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          group_name VARCHAR(50) DEFAULT 'A',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS players (
          id SERIAL PRIMARY KEY,
          team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          jersey_number INTEGER NOT NULL,
          goals INTEGER DEFAULT 0,
          yellow_cards INTEGER DEFAULT 0,
          red_cards INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS matches (
          id SERIAL PRIMARY KEY,
          team1_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
          team2_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
          team1_score INTEGER DEFAULT 0,
          team2_score INTEGER DEFAULT 0,
          status VARCHAR(50) DEFAULT 'live',
          stage VARCHAR(50) DEFAULT 'group',
          created_at TIMESTAMP DEFAULT NOW()
        );
        
        -- Patch existing tables if upgrading from previous version
        ALTER TABLE matches ADD COLUMN IF NOT EXISTS stage VARCHAR(50) DEFAULT 'group';
        ALTER TABLE teams ADD COLUMN IF NOT EXISTS group_name VARCHAR(50) DEFAULT 'A';
      `);
      console.log('Postgres DB ready for Futsal App (with Multi-Group Support)');
    } catch (e) {
      console.error('DB init error:', e.message);
      pool = null; 
    }
  })();
}

function sslOption(cs) {
  return /amazonaws|render|railway|supabase|azure|gcp|neon|timescale|heroku/i.test(cs)
    ? { rejectUnauthorized: false }
    : undefined;
}

function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-pass'];
  if (pass === ADMIN_PASS) next();
  else res.status(401).json({ ok: false, error: 'Unauthorized. Invalid Admin PIN.' });
}

// Calculate Standings Helper (Groups by group_name)
function calculateStandings(teams, matches) {
  let flatStandings = teams.map(t => ({ 
    id: t.id, 
    name: t.name, 
    group_name: t.group_name || 'A', 
    played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 
  }));
  
  const completedGroupMatches = matches.filter(m => m.status === 'completed' && m.stage === 'group');
  
  completedGroupMatches.forEach(m => {
    let t1 = flatStandings.find(s => s.id === m.team1_id);
    let t2 = flatStandings.find(s => s.id === m.team2_id);
    if(!t1 || !t2) return;

    t1.played++; t2.played++;
    t1.gf += m.team1_score; t1.ga += m.team2_score;
    t2.gf += m.team2_score; t2.ga += m.team1_score;

    if (m.team1_score > m.team2_score) {
      t1.won++; t1.pts += 3; t2.lost++;
    } else if (m.team2_score > m.team1_score) {
      t2.won++; t2.pts += 3; t1.lost++;
    } else {
      t1.drawn++; t2.drawn++; t1.pts += 1; t2.pts += 1;
    }
  });

  flatStandings.forEach(s => s.gd = s.gf - s.ga);

  // Group teams by their group_name
  const groupedStandings = {};
  flatStandings.forEach(s => {
    if (!groupedStandings[s.group_name]) groupedStandings[s.group_name] = [];
    groupedStandings[s.group_name].push(s);
  });

  // Sort each group by Points, then Goal Difference, then Goals For
  for (const group in groupedStandings) {
    groupedStandings[group].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
  }

  return groupedStandings;
}

// GET: Dashboard Data
app.get('/api/dashboard', async (_req, res) => {
  try {
    let teams, players, matches;
    if (pool) {
      teams = (await pool.query('SELECT * FROM teams ORDER BY id ASC;')).rows;
      players = (await pool.query('SELECT * FROM players ORDER BY id ASC;')).rows;
      matches = (await pool.query('SELECT * FROM matches ORDER BY created_at DESC;')).rows;
    } else {
      teams = mem.teams; players = mem.players; matches = mem.matches;
    }
    const standings = calculateStandings(teams, matches);
    res.json({ ok: true, teams, players, matches, standings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST: Create Team (Accepts group_name)
app.post('/api/teams', requireAdmin, async (req, res) => {
  const { name, group_name } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Team name required' });
  const group = group_name || 'A';
  
  try {
    if (pool) {
      const r = await pool.query('INSERT INTO teams (name, group_name) VALUES ($1, $2) RETURNING *;', [name, group]);
      res.json({ ok: true, team: r.rows[0] });
    } else {
      const team = { id: mem.teamIdSeq++, name, group_name: group };
      mem.teams.push(team);
      res.json({ ok: true, team });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT: Change Team Group
app.put('/api/teams/:id/group', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { group_name } = req.body;
  if (!group_name) return res.status(400).json({ ok: false, error: 'Group name required' });

  try {
    if (pool) {
      await pool.query('UPDATE teams SET group_name = $1 WHERE id = $2;', [group_name, id]);
    } else {
      const team = mem.teams.find(t => t.id === id);
      if (team) team.group_name = group_name;
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE: Delete Team
app.delete('/api/teams/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (pool) {
      await pool.query('DELETE FROM teams WHERE id = $1;', [id]); 
    } else {
      mem.teams = mem.teams.filter(t => t.id !== id);
      mem.players = mem.players.filter(p => p.team_id !== id);
      mem.matches = mem.matches.filter(m => m.team1_id !== id && m.team2_id !== id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST: Create Individual Player
app.post('/api/players', requireAdmin, async (req, res) => {
  const { team_id, name, jersey_number } = req.body;
  if (!team_id || !name) return res.status(400).json({ ok: false, error: 'Missing fields' });
  const jNum = parseInt(jersey_number) || 0;
  
  try {
    if (pool) {
      const r = await pool.query(
        'INSERT INTO players (team_id, name, jersey_number) VALUES ($1, $2, $3) RETURNING *;',
        [team_id, name, jNum]
      );
      res.json({ ok: true, player: r.rows[0] });
    } else {
      const player = { id: mem.playerIdSeq++, team_id: parseInt(team_id), name, jersey_number: jNum, goals: 0, yellow_cards: 0, red_cards: 0 };
      mem.players.push(player);
      res.json({ ok: true, player });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT: Fully Update Individual Player (Edit details/stats)
app.put('/api/players/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, jersey_number, goals, yellow_cards, red_cards } = req.body;
  
  const jNum = parseInt(jersey_number) || 0;
  const g = parseInt(goals) || 0;
  const y = parseInt(yellow_cards) || 0;
  const r = parseInt(red_cards) || 0;

  try {
    if (pool) {
      await pool.query(
        'UPDATE players SET name=$1, jersey_number=$2, goals=$3, yellow_cards=$4, red_cards=$5 WHERE id=$6;',
        [name, jNum, g, y, r, id]
      );
    } else {
      const p = mem.players.find(p => p.id === id);
      if (p) {
        p.name = name; p.jersey_number = jNum;
        p.goals = g; p.yellow_cards = y; p.red_cards = r;
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST: Batch Create Players
app.post('/api/players/batch', requireAdmin, async (req, res) => {
  const { team_id, playersText } = req.body;
  if (!team_id || !playersText) return res.status(400).json({ ok: false, error: 'Missing fields' });
  
  const lines = playersText.split('\n').filter(l => l.trim().length > 0);
  try {
    let inserted = [];
    for (let line of lines) {
      const parts = line.split(',');
      const name = parts[0].trim();
      const jersey_number = parts[1] ? parseInt(parts[1].trim()) : 0;
      
      if (pool) {
        const r = await pool.query(
          'INSERT INTO players (team_id, name, jersey_number) VALUES ($1, $2, $3) RETURNING *;',
          [team_id, name, jersey_number]
        );
        inserted.push(r.rows[0]);
      } else {
        const player = { id: mem.playerIdSeq++, team_id: parseInt(team_id), name, jersey_number, goals: 0, yellow_cards: 0, red_cards: 0 };
        mem.players.push(player);
        inserted.push(player);
      }
    }
    res.json({ ok: true, players: inserted });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/players/:id', requireAdmin, async (req, res) => {
  try {
    if (pool) await pool.query('DELETE FROM players WHERE id = $1;', [parseInt(req.params.id)]);
    else mem.players = mem.players.filter(p => p.id !== parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/players/:id/stats', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { action } = req.body;
  try {
    let q = '';
    if (action === 'goal') q = 'goals = goals + 1';
    else if (action === 'undo_goal') q = 'goals = GREATEST(goals - 1, 0)';
    else if (action === 'yellow') q = 'yellow_cards = yellow_cards + 1';
    else if (action === 'undo_yellow') q = 'yellow_cards = GREATEST(yellow_cards - 1, 0)';
    else if (action === 'red') q = 'red_cards = red_cards + 1';
    else if (action === 'undo_red') q = 'red_cards = GREATEST(red_cards - 1, 0)';

    if (pool) await pool.query(`UPDATE players SET ${q} WHERE id = $1;`, [id]);
    else {
      const p = mem.players.find(p => p.id === id);
      if (p) {
        if(action.includes('undo')) p[action.split('_')[1]+'s'] = Math.max(0, p[action.split('_')[1]+'s'] - 1);
        else p[action+'s']++; 
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST: Create Match
app.post('/api/matches', requireAdmin, async (req, res) => {
  const { team1_id, team2_id, stage } = req.body;
  if (!team1_id || !team2_id || team1_id === team2_id) return res.status(400).json({ ok: false, error: 'Invalid teams' });
  
  try {
    if (pool) {
      const r = await pool.query(
        'INSERT INTO matches (team1_id, team2_id, status, stage) VALUES ($1, $2, $3, $4) RETURNING *;',
        [team1_id, team2_id, 'live', stage || 'group']
      );
      res.json({ ok: true, match: r.rows[0] });
    } else {
      const match = { id: mem.matchIdSeq++, team1_id: parseInt(team1_id), team2_id: parseInt(team2_id), team1_score: 0, team2_score: 0, status: 'live', stage: stage||'group', created_at: new Date() };
      mem.matches.push(match);
      res.json({ ok: true, match });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST: Update Match State & Advanced Auto-Advance Logic
app.post('/api/matches/:id/action', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { action } = req.body; 
  
  try {
    let q = '';
    if (action === 't1_add') q = 'team1_score = team1_score + 1';
    else if (action === 't1_sub') q = 'team1_score = GREATEST(team1_score - 1, 0)';
    else if (action === 't2_add') q = 'team2_score = team2_score + 1';
    else if (action === 't2_sub') q = 'team2_score = GREATEST(team2_score - 1, 0)';
    else if (action === 'complete') q = "status = 'completed'";

    if (pool) await pool.query(`UPDATE matches SET ${q} WHERE id = $1;`, [id]);
    else {
      const m = mem.matches.find(m => m.id === id);
      if (m) {
        if (action === 't1_add') m.team1_score++;
        if (action === 't1_sub') m.team1_score = Math.max(0, m.team1_score - 1);
        if (action === 't2_add') m.team2_score++;
        if (action === 't2_sub') m.team2_score = Math.max(0, m.team2_score - 1);
        if (action === 'complete') m.status = 'completed';
      }
    }

    // --- AUTO-ADVANCE LOGIC (Multi-Group Support) ---
    if (action === 'complete') {
      let allMatches, allTeams;
      if (pool) {
        allMatches = (await pool.query("SELECT * FROM matches WHERE stage='group'")).rows;
        allTeams = (await pool.query("SELECT * FROM teams")).rows;
      } else {
        allMatches = mem.matches.filter(m => m.stage === 'group');
        allTeams = mem.teams;
      }
      
      const liveGroupMatches = allMatches.filter(m => m.status === 'live');
      
      // Trigger Semi-Finals if all group matches are done
      if (allMatches.length > 0 && liveGroupMatches.length === 0) {
        let existingSemis;
        if (pool) existingSemis = (await pool.query("SELECT * FROM matches WHERE stage='semi'")).rows;
        else existingSemis = mem.matches.filter(m => m.stage === 'semi');

        if (existingSemis.length === 0 && allTeams.length >= 4) {
          const standingsByGroup = calculateStandings(allTeams, allMatches);
          const groupNames = Object.keys(standingsByGroup).sort();
          
          let semi1_team1, semi1_team2, semi2_team1, semi2_team2;

          if (groupNames.length >= 2) {
            // Multi-Group Logic: A1 vs B2, B1 vs A2
            const g1 = groupNames[0]; const g2 = groupNames[1];
            if (standingsByGroup[g1].length >= 2 && standingsByGroup[g2].length >= 2) {
              semi1_team1 = standingsByGroup[g1][0].id;
              semi1_team2 = standingsByGroup[g2][1].id;
              semi2_team1 = standingsByGroup[g2][0].id;
              semi2_team2 = standingsByGroup[g1][1].id;
            }
          } else if (groupNames.length === 1) {
            // Single-Group Logic: 1st vs 4th, 2nd vs 3rd
            const g = groupNames[0];
            if (standingsByGroup[g].length >= 4) {
              const top4 = standingsByGroup[g].slice(0, 4);
              semi1_team1 = top4[0].id;
              semi1_team2 = top4[3].id;
              semi2_team1 = top4[1].id;
              semi2_team2 = top4[2].id;
            }
          }
          
          if (semi1_team1 && semi1_team2 && semi2_team1 && semi2_team2) {
            if (pool) {
              await pool.query('INSERT INTO matches (team1_id, team2_id, status, stage) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8);', 
                [semi1_team1, semi1_team2, 'live', 'semi', semi2_team1, semi2_team2, 'live', 'semi']);
            } else {
              mem.matches.push({ id: mem.matchIdSeq++, team1_id: semi1_team1, team2_id: semi1_team2, team1_score: 0, team2_score: 0, status: 'live', stage: 'semi', created_at: new Date() });
              mem.matches.push({ id: mem.matchIdSeq++, team1_id: semi2_team1, team2_id: semi2_team2, team1_score: 0, team2_score: 0, status: 'live', stage: 'semi', created_at: new Date() });
            }
            console.log("Auto-generated Semi-Finals based on Group Standings.");
          }
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/matches/:id', requireAdmin, async (req, res) => {
  try {
    if (pool) await pool.query('DELETE FROM matches WHERE id = $1;', [parseInt(req.params.id)]);
    else mem.matches = mem.matches.filter(m => m.id !== parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
