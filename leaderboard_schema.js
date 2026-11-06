const TANK_DISPLAY_NAMES = ["虎式", "183", "T-34-85", "M41D"];

const PLAYER_RATE_MIN_GAMES = 10;
const PLAYER_AVG_MIN_GAMES = 10;
const TANK_AVG_MIN_APPEARANCES = 5;
const POPULARITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function defaultMatchupMatrix() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => ({ wins: 0, losses: 0, draws: 0 }))
  );
}

function defaultPlayerStats() {
  return {
    bestStreak: 0,
    currentStreak: 0,
    wins: 0,
    losses: 0,
    matches: 0,
    kills: 0,
    treasures: 0,
  };
}

function defaultTankStats() {
  return {
    wins: 0,
    losses: 0,
    appearances: 0,
    kills: 0,
    treasures: 0,
    appearanceLog: [],
  };
}

function defaultLeaderboard() {
  return {
    random: {
      players: {},
      tanks: TANK_DISPLAY_NAMES.map(() => defaultTankStats()),
      matchups: defaultMatchupMatrix(),
    },
    ai: {
      players: {},
      tanks: TANK_DISPLAY_NAMES.map(() => defaultTankStats()),
      matchups: defaultMatchupMatrix(),
    },
  };
}

function ensureMatchupMatrix(raw) {
  const matrix = defaultMatchupMatrix();
  if (!Array.isArray(raw) || raw.length !== 4) return matrix;
  for (let a = 0; a < 4; a++) {
    if (!Array.isArray(raw[a]) || raw[a].length !== 4) return matrix;
    for (let b = 0; b < 4; b++) {
      const cell = raw[a][b];
      if (cell && typeof cell === "object") {
        matrix[a][b] = {
          wins: Number(cell.wins || 0),
          losses: Number(cell.losses || 0),
          draws: Number(cell.draws || 0),
        };
      }
    }
  }
  return matrix;
}

function ensurePlayerStats(raw) {
  const base = defaultPlayerStats();
  if (!raw || typeof raw !== "object") return base;
  return {
    bestStreak: Number(raw.bestStreak || 0),
    currentStreak: Number(raw.currentStreak || 0),
    wins: Number(raw.wins || 0),
    losses: Number(raw.losses || 0),
    matches: Number(raw.matches || 0),
    kills: Number(raw.kills || 0),
    treasures: Number(raw.treasures || 0),
  };
}

function ensureTankStats(raw) {
  const base = defaultTankStats();
  if (!raw || typeof raw !== "object") return base;
  const log = Array.isArray(raw.appearanceLog)
    ? raw.appearanceLog.map((t) => Number(t)).filter((t) => Number.isFinite(t))
    : [];
  return {
    wins: Number(raw.wins || 0),
    losses: Number(raw.losses || 0),
    appearances: Number(raw.appearances || 0),
    kills: Number(raw.kills || 0),
    treasures: Number(raw.treasures || 0),
    appearanceLog: log,
  };
}

function ensureLeaderboardShape(leaderboard) {
  if (!leaderboard.random) {
    leaderboard.random = defaultLeaderboard().random;
  }
  if (!leaderboard.random.players) leaderboard.random.players = {};
  for (const name of Object.keys(leaderboard.random.players)) {
    leaderboard.random.players[name] = ensurePlayerStats(leaderboard.random.players[name]);
  }
  if (!Array.isArray(leaderboard.random.tanks) || leaderboard.random.tanks.length !== 4) {
    leaderboard.random.tanks = TANK_DISPLAY_NAMES.map(() => defaultTankStats());
  } else {
    leaderboard.random.tanks = leaderboard.random.tanks.map((t) => ensureTankStats(t));
  }
  leaderboard.random.matchups = ensureMatchupMatrix(leaderboard.random.matchups);
  if (!leaderboard.ai) {
    leaderboard.ai = defaultLeaderboard().ai;
  }
  if (!leaderboard.ai.players) leaderboard.ai.players = {};
  for (const name of Object.keys(leaderboard.ai.players)) {
    leaderboard.ai.players[name] = ensurePlayerStats(leaderboard.ai.players[name]);
  }
  if (!Array.isArray(leaderboard.ai.tanks) || leaderboard.ai.tanks.length !== 4) {
    leaderboard.ai.tanks = TANK_DISPLAY_NAMES.map(() => defaultTankStats());
  } else {
    leaderboard.ai.tanks = leaderboard.ai.tanks.map((t) => ensureTankStats(t));
  }
  leaderboard.ai.matchups = ensureMatchupMatrix(leaderboard.ai.matchups);
  return leaderboard;
}

function hasLeaderboardStats(leaderboard) {
  const randomPlayers = Object.keys(leaderboard.random?.players || {}).length;
  const aiPlayers = Object.keys(leaderboard.ai?.players || {}).length;
  const randomTanks = (leaderboard.random?.tanks || []).some(
    (t) =>
      Number(t.wins || 0) +
        Number(t.losses || 0) +
        Number(t.appearances || 0) +
        Number(t.kills || 0) +
        Number(t.treasures || 0) >
      0
  );
  const aiTanks = (leaderboard.ai?.tanks || []).some(
    (t) =>
      Number(t.wins || 0) +
        Number(t.losses || 0) +
        Number(t.appearances || 0) +
        Number(t.kills || 0) +
        Number(t.treasures || 0) >
      0
  );
  return randomPlayers > 0 || aiPlayers > 0 || randomTanks || aiTanks;
}

module.exports = {
  TANK_DISPLAY_NAMES,
  PLAYER_RATE_MIN_GAMES,
  PLAYER_AVG_MIN_GAMES,
  TANK_AVG_MIN_APPEARANCES,
  POPULARITY_WINDOW_MS,
  defaultLeaderboard,
  defaultPlayerStats,
  defaultTankStats,
  ensureLeaderboardShape,
  ensureMatchupMatrix,
  ensurePlayerStats,
  ensureTankStats,
  defaultMatchupMatrix,
  hasLeaderboardStats,
};
