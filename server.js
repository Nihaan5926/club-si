import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3019;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_PASS = '0000';

app.use(express.json());
app.use(express.static('public'));

// --- In-memory fallback (if no DB yet) ---
let mem = { 
  teams: [], 
  players: [],
  matches: [],
  teamIdSeq: 1, 
  playerIdSeq: 1,
  matchIdSeq: 1
};

// --- Postgres Setup ---
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: sslOption(DATABASE_URL) });
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS teams (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
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
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('Postgres DB ready for Futsal App (with Matches)');
    } catch (e) {
      console.error('DB init error:', e.message);
      pool = null; // Fall back to memory
    }
  })();
}

function sslOption(cs) {
  return /amazonaws|render|railway|supabase|azure|gcp|neon|timescale|heroku/i.test(cs)
    ? { rejectUnauthorized: false }
    : undefined;
}

// --- Middleware for Admin Auth ---
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-pass'];
  if (pass === ADMIN_PASS) {
    next();
  } else {
    res.status(401).json({ ok: false, error: 'Unauthorized. Invalid Admin Password.' });
  }
}

// --- API Endpoints ---

// GET: Fetch all dashboard data
app.get('/api/dashboard', async (_req, res) => {
  try {
    if (pool) {
      const teamsRes = await pool.query('SELECT * FROM teams ORDER BY id ASC;');
      const playersRes = await pool.query('SELECT * FROM players ORDER BY id ASC;');
      const matchesRes = await pool.query('SELECT * FROM matches ORDER BY created_at DESC;');
      res.json({ ok: true, teams: teamsRes.rows, players: playersRes.rows, matches: matchesRes.rows });
    } else {
      res.json({ ok: true, teams: mem.teams, players: mem.players, matches: mem.matches });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST: Create Team
app.post('/api/teams', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Team name required' });
  try {
    if (pool) {
      const r = await pool.query('INSERT INTO teams (name) VALUES ($1) RETURNING *;', [name]);
      res.json({ ok: true, team: r.rows[0] });
    } else {
      const team = { id: mem.teamIdSeq++, name };
      mem.teams.push(team);
      res.json({ ok: true, team });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST: Create Player
app.post('/api/players', requireAdmin, async (req, res) => {
  const { team_id, name, jersey_number } = req.body;
  if (!team_id || !name) return res.status(400).json({ ok: false, error: 'Missing fields' });
  try {
    if (pool) {
      const r = await pool.query(
        'INSERT INTO players (team_id, name, jersey_number) VALUES ($1, $2, $3) RETURNING *;',
        [team_id, name, jersey_number || 0]
      );
      res.json({ ok: true, player: r.rows[0] });
    } else {
      const player = { id: mem.playerIdSeq++, team_id: parseInt(team_id), name, jersey_number: parseInt(jersey_number||0), goals: 0, yellow_cards: 0, red_cards: 0 };
      mem.players.push(player);
      res.json({ ok: true, player });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE: Delete Player
app.delete('/api/players/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (pool) {
      await pool.query('DELETE FROM players WHERE id = $1;', [id]);
    } else {
      mem.players = mem.players.filter(p => p.id !== id);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST: Update Player Stats
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
    else return res.status(400).json({ ok: false, error: 'Invalid action' });

    if (pool) {
      await pool.query(`UPDATE players SET ${q} WHERE id = $1;`, [id]);
    } else {
      const p = mem.players.find(p => p.id === id);
      if (p) {
        if (action === 'goal') p.goals++;
        if (action === 'undo_goal') p.goals = Math.max(0, p.goals - 1);
        if (action === 'yellow') p.yellow_cards++;
        if (action === 'undo_yellow') p.yellow_cards = Math.max(0, p.yellow_cards - 1);
        if (action === 'red') p.red_cards++;
        if (action === 'undo_red') p.red_cards = Math.max(0, p.red_cards - 1);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Match Endpoints ---

// POST: Create Match
app.post('/api/matches', requireAdmin, async (req, res) => {
  const { team1_id, team2_id } = req.body;
  if (!team1_id || !team2_id || team1_id === team2_id) {
    return res.status(400).json({ ok: false, error: 'Invalid teams selected' });
  }
  try {
    if (pool) {
      const r = await pool.query(
        'INSERT INTO matches (team1_id, team2_id, status) VALUES ($1, $2, $3) RETURNING *;',
        [team1_id, team2_id, 'live']
      );
      res.json({ ok: true, match: r.rows[0] });
    } else {
      const match = { id: mem.matchIdSeq++, team1_id: parseInt(team1_id), team2_id: parseInt(team2_id), team1_score: 0, team2_score: 0, status: 'live', created_at: new Date() };
      mem.matches.push(match);
      res.json({ ok: true, match });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST: Update Match State (Scores / Status)
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
    else return res.status(400).json({ ok: false, error: 'Invalid action' });

    if (pool) {
      await pool.query(`UPDATE matches SET ${q} WHERE id = $1;`, [id]);
    } else {
      const m = mem.matches.find(m => m.id === id);
      if (m) {
        if (action === 't1_add') m.team1_score++;
        if (action === 't1_sub') m.team1_score = Math.max(0, m.team1_score - 1);
        if (action === 't2_add') m.team2_score++;
        if (action === 't2_sub') m.team2_score = Math.max(0, m.team2_score - 1);
        if (action === 'complete') m.status = 'completed';
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE: Delete Match
app.delete('/api/matches/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (pool) {
      await pool.query('DELETE FROM matches WHERE id = $1;', [id]);
    } else {
      mem.matches = mem.matches.filter(m => m.id !== id);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
