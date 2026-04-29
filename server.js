import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3019;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_PASS = '0000';

app.use(express.json());
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

// Calculate Standings Helper (Now groups by group_name)
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

// POST: Create Team (Now accepts group_name)
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

// Catch-all route handler for index.html if needed in production
app.get('/', (req, res) => res.send(indexHTML));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));


// ==========================================
// FRONTEND HTML / UI
// ==========================================
const indexHTML = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>3v3 Futsal Live Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --surface: rgba(30, 41, 59, 0.85);
      --surface-hover: rgba(51, 65, 85, 0.9);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #10b981;
      --primary-hover: #059669;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #3b82f6;
      --border: rgba(255, 255, 255, 0.1);
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      color: var(--text); 
      line-height: 1.5; 
      padding-bottom: 2rem;
      background: radial-gradient(circle at 50% 0%, #1e293b, #020617);
      background-size: cover;
      background-attachment: fixed;
      position: relative;
    }
    
    body::before {
      content: "";
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image: repeating-linear-gradient(0deg, transparent, transparent 50px, rgba(255,255,255,0.03) 50px, rgba(255,255,255,0.03) 100px);
      z-index: -1;
      pointer-events: none;
    }

    header { 
      background: rgba(15, 23, 42, 0.9); 
      backdrop-filter: blur(10px);
      padding: 1rem 2rem; 
      border-bottom: 1px solid var(--primary); 
      display: flex; justify-content: space-between; align-items: center; 
      position: sticky; top: 0; z-index: 10; 
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.2);
    }
    
    .container { max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
    
    button { background: var(--primary); color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 600; transition: all 0.2s; }
    button:hover { background: var(--primary-hover); transform: translateY(-1px); }
    button.btn-danger { background: var(--danger); }
    button.btn-warning { background: var(--warning); color: #000; }
    button.btn-success { background: var(--success); }
    button.btn-outline { background: transparent; border: 1px solid var(--text-muted); color: var(--text); }
    button.btn-outline:hover { background: var(--surface-hover); border-color: var(--text); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    input, select, textarea { background: rgba(0,0,0,0.5); color: var(--text); border: 1px solid var(--border); padding: 0.5rem; border-radius: 6px; outline: none; }
    input:focus, select:focus, textarea:focus { border-color: var(--primary); }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.5rem; }
    .card { background: var(--surface); backdrop-filter: blur(8px); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; box-shadow: 0 8px 16px rgba(0,0,0,0.2); }
    
    /* Matches Styling */
    .match-card { text-align: center; position: relative; border-top: 3px solid var(--border); }
    .match-card[data-stage="semi"] { border-top-color: var(--warning); }
    .match-card[data-stage="final"] { border-top-color: var(--danger); }
    
    .match-status { position: absolute; top: 10px; right: 10px; font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: bold; text-transform: uppercase; }
    .status-live { background: rgba(16, 185, 129, 0.2); color: var(--primary); border: 1px solid var(--primary); animation: pulse 2s infinite; }
    .status-completed { background: rgba(255,255,255,0.1); color: var(--text-muted); }
    
    .stage-badge { position: absolute; top: 10px; left: 10px; font-size: 0.75rem; color: var(--warning); font-weight: bold; text-transform: uppercase; }

    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }

    .scoreboard { display: flex; align-items: center; justify-content: center; gap: 1rem; margin: 1.5rem 0; }
    .score-team { flex: 1; font-size: 1.2rem; font-weight: bold; }
    .score-number { font-size: 3rem; font-weight: 900; background: rgba(0,0,0,0.4); padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid var(--border); width: 80px; }
    .score-vs { font-size: 1rem; color: var(--text-muted); font-weight: bold; }
    
    /* Standings Table */
    .standings-wrapper { margin-bottom: 2rem; }
    .group-header { font-size: 1.2rem; color: var(--warning); margin-bottom: 0.5rem; border-bottom: 1px dashed var(--border); padding-bottom: 0.3rem;}
    table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: var(--radius); overflow: hidden; }
    th, td { padding: 0.75rem 1rem; text-align: center; border-bottom: 1px solid var(--border); }
    th { background: rgba(0,0,0,0.3); font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; }
    td:first-child, th:first-child { text-align: left; }
    tr:last-child td { border-bottom: none; }
    .pts-col { font-weight: bold; color: var(--primary); font-size: 1.1rem; }

    /* Admin Panel */
    .admin-controls { display: flex; gap: 0.25rem; }
    .admin-controls button { padding: 0.25rem 0.5rem; font-size: 0.8rem; }
    .admin-section { background: rgba(0,0,0,0.3); padding: 1.5rem; border-radius: var(--radius); border: 1px solid var(--primary); }
    .form-group { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; margin-top: 1rem; }
    
    .hidden { display: none !important; }
    .flex { display: flex; } .justify-between { justify-content: space-between; } .items-center { align-items: center; }
    .section-title { font-size: 1.5rem; margin-top: 2rem; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--border); display: flex; justify-content: space-between; align-items: center;}

    /* Modal */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 50; }
    .modal { background: var(--surface); padding: 2rem; border-radius: var(--radius); width: 100%; max-width: 400px; border: 1px solid var(--primary); }
  </style>
</head>
<body>

  <header>
    <h2>⚽ Live Futsal 3v3</h2>
    <div>
      <button id="authBtn" class="btn-outline">Admin Login</button>
    </div>
  </header>

  <div class="container">
    <div id="adminPanel" class="hidden">
      <h2 style="color: var(--primary);">Admin Dashboard</h2>
      <p class="text-muted" style="margin-bottom: 1.5rem;">Manage tournament logic, groups, scores, and bulk imports.</p>
      
      <div class="grid">
        <div class="admin-section">
          <h3>Create Match</h3>
          <div class="form-group">
            <div style="flex:1;">
              <select id="matchStageSelect" style="width:100%; margin-bottom:0.5rem;">
                <option value="group">Group Stage</option>
                <option value="semi">Semi-Final</option>
                <option value="final">Final</option>
              </select>
              <select id="matchTeam1Select" style="width:100%;"><option value="">Team 1...</option></select>
            </div>
            <div style="padding-top: 2.2rem; font-weight: bold; color: var(--text-muted);">VS</div>
            <div style="flex:1;">
              <br>
              <select id="matchTeam2Select" style="width:100%;"><option value="">Team 2...</option></select>
            </div>
            <button style="margin-top:2rem; width:100%;" onclick="createMatch()">Start Match</button>
          </div>
        </div>

        <div class="admin-section">
          <h3>Team & Group Management</h3>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom:0.5rem;">Create teams and assign them to a group stage.</p>
          <div class="form-group" style="align-items: center; margin-top:0;">
            <input type="text" id="newTeamName" placeholder="e.g. Futsal Kings" style="flex:1; min-width:120px;" />
            <select id="newTeamGroup">
              <option value="A">Group A</option>
              <option value="B">Group B</option>
              <option value="C">Group C</option>
              <option value="D">Group D</option>
            </select>
            <button onclick="createTeam()">Add Team</button>
          </div>
          
          <hr style="border-color: var(--border); margin: 1rem 0;"/>
          
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom:0.5rem;">Move existing team to a different group.</p>
          <div class="form-group" style="align-items: center; margin-top:0;">
            <select id="moveTeamSelect" style="flex:1;"><option value="">Select Team...</option></select>
            <select id="moveTeamGroup">
              <option value="A">Group A</option>
              <option value="B">Group B</option>
              <option value="C">Group C</option>
              <option value="D">Group D</option>
            </select>
            <button onclick="moveTeamGroup()" class="btn-warning">Move</button>
          </div>
        </div>

        <div class="admin-section">
          <h3>Batch Register Players</h3>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom:0.5rem;">Format per line: Name, Jersey (e.g. John Doe, 10)</p>
          <div class="form-group" style="flex-direction: column; gap:0.5rem;">
            <select id="playerTeamSelect" style="width:100%;"><option value="">Select Team...</option></select>
            <textarea id="batchPlayersInput" rows="3" style="width:100%;" placeholder="John Doe, 10&#10;Jane Smith, 7"></textarea>
            <button onclick="batchCreatePlayers()" style="width:100%;">Import Players</button>
          </div>
        </div>
      </div>
      <hr style="border-color: var(--border); margin: 2rem 0;"/>
    </div>

    <h2 class="section-title">Tournament Standings</h2>
    <div id="standingsContainer">
      <div style="text-align: center; color: var(--text-muted);">Loading standings...</div>
    </div>

    <h2 class="section-title">Matches Board</h2>
    <div id="matchesGrid" class="grid" style="margin-bottom: 3rem;">
      <div style="text-align: center; width: 100%; color: var(--text-muted);">Loading matches...</div>
    </div>

    <h2 class="section-title">Team Rosters</h2>
    <div id="teamsGrid" class="grid">
      <div style="text-align: center; width: 100%; color: var(--text-muted);">Loading teams...</div>
    </div>
  </div>

  <div id="loginModal" class="modal-overlay hidden">
    <div class="modal">
      <h3 style="margin-bottom: 1rem;">Admin Access</h3>
      <input type="password" id="adminPassInput" placeholder="Enter PIN (0000)" style="width: 100%; margin-bottom: 1rem; font-size: 1.2rem; text-align: center;" />
      <div class="flex justify-between">
        <button class="btn-outline" onclick="toggleModal(false)">Cancel</button>
        <button onclick="attemptLogin()">Unlock</button>
      </div>
    </div>
  </div>

<script>
  let state = { teams: [], players: [], matches: [], standings: {}, isAdmin: false, adminToken: '' };

  async function loadData() {
    try {
      const res = await fetch('/api/dashboard');
      const data = await res.json();
      if (data.ok) {
        state.teams = data.teams;
        state.players = data.players;
        state.matches = data.matches;
        state.standings = data.standings; // Note: standings is now an object grouped by Group Name
        renderDashboard();
        if(state.isAdmin) updateAdminDropdowns();
      }
    } catch (e) { console.error('Failed to load data', e); }
  }

  document.getElementById('authBtn').onclick = () => {
    if (state.isAdmin) {
      state.isAdmin = false; state.adminToken = '';
      document.getElementById('authBtn').textContent = 'Admin Login';
      document.getElementById('adminPanel').classList.add('hidden');
      renderDashboard();
    } else {
      toggleModal(true);
    }
  };

  function toggleModal(show) {
    const m = document.getElementById('loginModal');
    show ? m.classList.remove('hidden') : m.classList.add('hidden');
    if (show) document.getElementById('adminPassInput').focus();
  }

  function attemptLogin() {
    const pass = document.getElementById('adminPassInput').value;
    if (pass === '0000') {
      state.isAdmin = true; state.adminToken = pass;
      document.getElementById('authBtn').textContent = 'Exit Admin';
      document.getElementById('adminPanel').classList.remove('hidden');
      document.getElementById('adminPassInput').value = '';
      toggleModal(false);
      updateAdminDropdowns(); renderDashboard();
    } else { alert('Invalid Password'); }
  }

  async function apiCall(url, method, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.isAdmin) headers['x-admin-pass'] = state.adminToken;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data;
  }

  async function createMatch() {
    const t1 = document.getElementById('matchTeam1Select').value;
    const t2 = document.getElementById('matchTeam2Select').value;
    const stage = document.getElementById('matchStageSelect').value;
    if (!t1 || !t2) return alert('Select both teams.');
    if (t1 === t2) return alert('Cannot match a team against itself.');
    try { await apiCall('/api/matches', 'POST', { team1_id: t1, team2_id: t2, stage }); loadData(); } 
    catch(e) { alert(e.message); }
  }

  async function matchAction(id, action) {
    try { await apiCall(\`/api/matches/\${id}/action\`, 'POST', { action }); loadData(); } 
    catch(e) { alert(e.message); }
  }

  async function deleteMatch(id) {
    if (!confirm('Delete this match completely?')) return;
    try { await apiCall(\`/api/matches/\${id}\`, 'DELETE'); loadData(); } 
    catch(e) { alert(e.message); }
  }

  async function createTeam() {
    const input = document.getElementById('newTeamName');
    const group = document.getElementById('newTeamGroup').value;
    if (!input.value) return;
    try { 
      await apiCall('/api/teams', 'POST', { name: input.value, group_name: group }); 
      input.value = ''; 
      loadData(); 
    } 
    catch(e) { alert(e.message); }
  }

  async function moveTeamGroup() {
    const tId = document.getElementById('moveTeamSelect').value;
    const group = document.getElementById('moveTeamGroup').value;
    if (!tId || !group) return alert('Select a team and target group.');
    try {
      await apiCall(\`/api/teams/\${tId}/group\`, 'PUT', { group_name: group });
      loadData();
    } catch(e) { alert(e.message); }
  }

  async function deleteTeam(id) {
    if (!confirm('Delete team, its players, AND related matches?')) return;
    try { await apiCall(\`/api/teams/\${id}\`, 'DELETE'); loadData(); } catch(e) { alert(e.message); }
  }

  async function batchCreatePlayers() {
    const tId = document.getElementById('playerTeamSelect').value;
    const text = document.getElementById('batchPlayersInput').value;
    if (!tId || !text.trim()) return alert('Select team and enter player info');
    try {
      await apiCall('/api/players/batch', 'POST', { team_id: tId, playersText: text });
      document.getElementById('batchPlayersInput').value = '';
      loadData();
    } catch(e) { alert(e.message); }
  }

  async function deletePlayer(id) {
    if (!confirm('Remove player?')) return;
    try { await apiCall(\`/api/players/\${id}\`, 'DELETE'); loadData(); } catch(e) { alert(e.message); }
  }

  async function updateStat(playerId, action) {
    try { await apiCall(\`/api/players/\${playerId}/stats\`, 'POST', { action }); loadData(); } 
    catch(e) { alert(e.message); }
  }

  function updateAdminDropdowns() {
    const options = '<option value="">Select...</option>' + state.teams.map(t => \`<option value="\${t.id}">\${t.name} (Grp \${t.group_name || 'A'})</option>\`).join('');
    document.getElementById('playerTeamSelect').innerHTML = options;
    document.getElementById('matchTeam1Select').innerHTML = options;
    document.getElementById('matchTeam2Select').innerHTML = options;
    document.getElementById('moveTeamSelect').innerHTML = options;
  }

  function getTeamName(id) {
    const t = state.teams.find(t => t.id === id); return t ? t.name : 'Unknown';
  }

  function renderDashboard() {
    renderStandings();
    renderMatches();
    renderTeams();
  }

  function renderStandings() {
    const container = document.getElementById('standingsContainer');
    const groupNames = Object.keys(state.standings).sort();
    
    if (groupNames.length === 0) {
      container.innerHTML = \`<div style="text-align: center; width: 100%; color: var(--text-muted); background:var(--surface); padding:2rem; border-radius:var(--radius);">No group data yet.</div>\`;
      return;
    }

    let html = '';
    // Generate a table for each Group
    groupNames.forEach(groupName => {
      const teams = state.standings[groupName];
      html += \`
        <div class="standings-wrapper">
          <h3 class="group-header">Group \${groupName}</h3>
          <div style="overflow-x:auto;">
            <table>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>P</th>
                  <th>W</th>
                  <th>D</th>
                  <th>L</th>
                  <th>GD</th>
                  <th>Pts</th>
                </tr>
              </thead>
              <tbody>
                \${teams.map((s, index) => {
                  // If multi-group, top 2 advance. If single group, top 4 advance. (Visual indicator only)
                  const advanceThreshold = groupNames.length > 1 ? 2 : 4;
                  const isAdvancing = index < advanceThreshold ? 'border-left: 3px solid var(--primary);' : '';
                  return \`
                    <tr>
                      <td style="font-weight:bold; \${isAdvancing}">
                        <span style="color:var(--text-muted); margin-right:8px;">\${index+1}.</span>\${s.name}
                      </td>
                      <td>\${s.played}</td>
                      <td>\${s.won}</td>
                      <td>\${s.drawn}</td>
                      <td>\${s.lost}</td>
                      <td>\${s.gd > 0 ? '+'+s.gd : s.gd}</td>
                      <td class="pts-col">\${s.pts}</td>
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      \`;
    });
    
    container.innerHTML = html;
  }

  function renderMatches() {
    const grid = document.getElementById('matchesGrid');
    if (state.matches.length === 0) {
      grid.innerHTML = \`<div style="text-align: center; width: 100%; color: var(--text-muted); background:var(--surface); padding:2rem; border-radius:var(--radius);">No matches scheduled.</div>\`;
      return;
    }

    grid.innerHTML = state.matches.map(match => {
      const isLive = match.status === 'live';
      const badgeClass = isLive ? 'status-live' : 'status-completed';
      const badgeText = isLive ? 'LIVE' : 'FINAL';
      const stageFormat = match.stage === 'semi' ? 'Semi-Final' : match.stage === 'final' ? 'Final' : 'Group Stage';

      let adminHTML = '';
      if (state.isAdmin) {
        adminHTML = \`
          <div style="margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem;">
            <div style="display:flex; justify-content:space-between; margin-bottom: 1rem;">
              <div class="admin-controls">
                <button class="btn-outline" onclick="matchAction(\${match.id}, 't1_sub')">-</button>
                <button onclick="matchAction(\${match.id}, 't1_add')">+ Goal</button>
              </div>
              <div class="admin-controls">
                <button onclick="matchAction(\${match.id}, 't2_add')">+ Goal</button>
                <button class="btn-outline" onclick="matchAction(\${match.id}, 't2_sub')">-</button>
              </div>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <button class="btn-danger btn-outline" style="font-size:0.8rem; padding:0.2rem 0.5rem;" onclick="deleteMatch(\${match.id})">Delete Match</button>
              \${isLive ? \`<button class="btn-success" style="font-size:0.8rem; padding:0.2rem 0.5rem;" onclick="matchAction(\${match.id}, 'complete')">End Match</button>\` : \`<span style="font-size: 0.8rem; color: var(--text-muted);">Match Ended</span>\`}
            </div>
          </div>
        \`;
      }

      return \`
        <div class="card match-card" data-stage="\${match.stage}">
          <div class="stage-badge">\${stageFormat}</div>
          <div class="match-status \${badgeClass}">\${badgeText}</div>
          <div class="scoreboard">
            <div class="score-team">\${getTeamName(match.team1_id)}</div>
            <div class="score-number">\${match.team1_score}</div>
            <div class="score-vs">VS</div>
            <div class="score-number">\${match.team2_score}</div>
            <div class="score-team">\${getTeamName(match.team2_id)}</div>
          </div>
          \${adminHTML}
        </div>
      \`;
    }).join('');
  }

  function renderTeams() {
    const grid = document.getElementById('teamsGrid');
    if (state.teams.length === 0) {
      grid.innerHTML = \`<div style="text-align: center; width: 100%; color: var(--text-muted); background:var(--surface); padding:2rem; border-radius:var(--radius);">No teams registered.</div>\`;
      return;
    }

    grid.innerHTML = state.teams.map(team => {
      const teamPlayers = state.players.filter(p => p.team_id === team.id);
      
      let html = \`
        <div class="card" style="padding:1rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:0.5rem; margin-bottom:0.5rem;">
            <div>
              <h3 style="font-size: 1.2rem; margin:0; display:inline-block;">\${team.name}</h3>
              <span style="font-size:0.75rem; color:var(--warning); margin-left:8px; border:1px solid var(--warning); padding:1px 4px; border-radius:4px;">Grp \${team.group_name || 'A'}</span>
            </div>
            \${state.isAdmin ? \`<button class="btn-danger btn-outline" style="padding:0.2rem 0.5rem; font-size:0.7rem;" onclick="deleteTeam(\${team.id})">Delete</button>\` : ''}
          </div>
          <div style="display:flex; flex-direction:column; gap:0.5rem;">
      \`;

      if (teamPlayers.length === 0) {
        html += \`<div class="text-muted" style="font-size:0.9rem;">No players assigned</div>\`;
      } else {
        teamPlayers.forEach(p => {
          html += \`
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:0.5rem; border-radius:6px;">
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <div style="background:var(--primary); color:#000; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:bold;">\${p.jersey_number}</div>
                <div>
                  <span style="font-weight:600; font-size:0.9rem;">\${p.name}</span>
                  \${state.isAdmin ? \`<a href="#" style="font-size:0.7rem; color:var(--danger); text-decoration:none; margin-left:8px;" onclick="deletePlayer(\${p.id})">X</a>\` : ''}
                </div>
              </div>
              <div style="display:flex; gap:4px; align-items:center;">
                \${state.isAdmin ? \`
                  <button style="font-size:0.7rem; padding:2px 4px; background:var(--surface);" onclick="updateStat(\${p.id}, 'goal')">⚽</button>
                  <button style="font-size:0.7rem; padding:2px 4px; background:var(--surface);" onclick="updateStat(\${p.id}, 'yellow')">🟨</button>
                  <button style="font-size:0.7rem; padding:2px 4px; background:var(--surface);" onclick="updateStat(\${p.id}, 'red')">🟥</button>
                \` : ''}
                <div style="display:flex; gap:4px; margin-left:8px;">
                  \${p.goals > 0 ? \`<span style="background:#e2e8f0; color:#000; font-size:0.7rem; padding:2px 6px; border-radius:4px; font-weight:bold;">\${p.goals} ⚽</span>\` : ''}
                  \${p.yellow_cards > 0 ? \`<span style="background:var(--warning); color:#000; font-size:0.7rem; padding:2px 6px; border-radius:4px; font-weight:bold;">\${p.yellow_cards} 🟨</span>\` : ''}
                  \${p.red_cards > 0 ? \`<span style="background:var(--danger); color:#fff; font-size:0.7rem; padding:2px 6px; border-radius:4px; font-weight:bold;">\${p.red_cards} 🟥</span>\` : ''}
                </div>
              </div>
            </div>
          \`;
        });
      }
      html += \`</div></div>\`;
      return html;
    }).join('');
  }

  loadData();
</script>
</body>
</html>
`;
