const TANK_DISPLAY_NAMES = ["虎式", "183", "T-34-85", "M41D"];

function defaultMatchupMatrix() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => ({ wins: 0, losses: 0, draws: 0 }))
  );
}

function defaultLeaderboard() {
  return {
    random: {
      players: {},
      tanks: TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 })),
      matchups: defaultMatchupMatrix(),
    },
    ai: {
      players: {},
      tanks: TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 })),
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

function ensureLeaderboardShape(leaderboard) {
  if (!leaderboard.random) {
    leaderboard.random = defaultLeaderboard().random;
  }
  if (!leaderboard.random.players) leaderboard.random.players = {};
  if (!Array.isArray(leaderboard.random.tanks) || leaderboard.random.tanks.length !== 4) {
    leaderboard.random.tanks = TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 }));
  }
  leaderboard.random.matchups = ensureMatchupMatrix(leaderboard.random.matchups);
  if (!leaderboard.ai) {
    leaderboard.ai = defaultLeaderboard().ai;
  }
  if (!leaderboard.ai.players) leaderboard.ai.players = {};
  if (!Array.isArray(leaderboard.ai.tanks) || leaderboard.ai.tanks.length !== 4) {
    leaderboard.ai.tanks = TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 }));
  }
  leaderboard.ai.matchups = ensureMatchupMatrix(leaderboard.ai.matchups);
  return leaderboard;
}

function hasLeaderboardStats(leaderboard) {
  const randomPlayers = Object.keys(leaderboard.random?.players || {}).length;
  const aiPlayers = Object.keys(leaderboard.ai?.players || {}).length;
  const randomTanks = (leaderboard.random?.tanks || []).some(
    (t) => Number(t.wins || 0) + Number(t.losses || 0) > 0
  );
  const aiTanks = (leaderboard.ai?.tanks || []).some(
    (t) => Number(t.wins || 0) + Number(t.losses || 0) > 0
  );
  return randomPlayers > 0 || aiPlayers > 0 || randomTanks || aiTanks;
}

module.exports = {
  TANK_DISPLAY_NAMES,
  defaultLeaderboard,
  ensureLeaderboardShape,
  ensureMatchupMatrix,
  defaultMatchupMatrix,
  hasLeaderboardStats,
};
