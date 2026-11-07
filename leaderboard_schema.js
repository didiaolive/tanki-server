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

const HIDDEN_E_DEFAULT = 1000;
const HIDDEN_E_MIN = 200;
const HIDDEN_E_MAX = 2000;
const HIDDEN_E_DELTA = 20;

function defaultPlayerStats() {
  return {
    displayName: "",
    bestStreak: 0,
    currentStreak: 0,
    wins: 0,
    losses: 0,
    matches: 0,
    kills: 0,
    treasures: 0,
    hiddenE: HIDDEN_E_DEFAULT,
  };
}

/** Game UID：TK-XXXX-XXXX-XXXX */
function isPlayerUid(value) {
  const uid = String(value || "")
    .trim()
    .toUpperCase();
  return /^TK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(uid);
}

function normalizePlayerUid(value) {
  const uid = String(value || "")
    .trim()
    .toUpperCase();
  return isPlayerUid(uid) ? uid : "";
}

function extractPublicTag(displayName) {
  const text = String(displayName || "").trim();
  const m = text.match(/#([A-Z0-9]{4})\s*$/i);
  return m ? m[1].toUpperCase() : "";
}

function mergePlayerStatsObjects(a, b) {
  const left = ensurePlayerStats(a || {});
  const right = ensurePlayerStats(b || {});
  const displayName =
    String(right.displayName || "").trim() ||
    String(left.displayName || "").trim() ||
    "";
  return {
    displayName,
    bestStreak: Math.max(left.bestStreak, right.bestStreak),
    currentStreak: Math.max(left.currentStreak, right.currentStreak),
    wins: Math.max(left.wins, right.wins),
    losses: Math.max(left.losses, right.losses),
    matches: Math.max(left.matches, right.matches),
    kills: Math.max(left.kills, right.kills),
    treasures: Math.max(left.treasures, right.treasures),
    hiddenE: right.hiddenE != null ? right.hiddenE : left.hiddenE,
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

/** app＝正式榜（Google Play 等）；web＝試玩榜（互不合併） */
function normalizeLeaderboardPlatform(raw) {
  const p = String(raw || "")
    .trim()
    .toLowerCase();
  if (p === "web" || p === "html5" || p === "html") return "web";
  return "app";
}

function defaultPlatformBoard() {
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

function defaultLeaderboard() {
  return {
    app: defaultPlatformBoard(),
    web: defaultPlatformBoard(),
  };
}

function isLegacyFlatLeaderboard(raw) {
  return Boolean(
    raw &&
      typeof raw === "object" &&
      raw.random &&
      raw.ai &&
      !raw.app &&
      !raw.web
  );
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
  let hiddenE = Number(raw.hiddenE);
  if (!Number.isFinite(hiddenE)) hiddenE = HIDDEN_E_DEFAULT;
  hiddenE = Math.max(HIDDEN_E_MIN, Math.min(HIDDEN_E_MAX, hiddenE));
  return {
    displayName: String(raw.displayName || "").trim(),
    bestStreak: Number(raw.bestStreak || 0),
    currentStreak: Number(raw.currentStreak || 0),
    wins: Number(raw.wins || 0),
    losses: Number(raw.losses || 0),
    matches: Number(raw.matches || 0),
    kills: Number(raw.kills || 0),
    treasures: Number(raw.treasures || 0),
    hiddenE,
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

function ensurePlatformBoard(board) {
  const out = board && typeof board === "object" ? board : {};
  if (!out.random) {
    out.random = defaultPlatformBoard().random;
  }
  if (!out.random.players) out.random.players = {};
  for (const key of Object.keys(out.random.players)) {
    const stats = ensurePlayerStats(out.random.players[key]);
    if (!stats.displayName) {
      stats.displayName = isPlayerUid(key) ? "" : String(key);
    }
    out.random.players[key] = stats;
  }
  if (!Array.isArray(out.random.tanks) || out.random.tanks.length !== 4) {
    out.random.tanks = TANK_DISPLAY_NAMES.map(() => defaultTankStats());
  } else {
    out.random.tanks = out.random.tanks.map((t) => ensureTankStats(t));
  }
  out.random.matchups = ensureMatchupMatrix(out.random.matchups);
  if (!out.ai) {
    out.ai = defaultPlatformBoard().ai;
  }
  if (!out.ai.players) out.ai.players = {};
  for (const key of Object.keys(out.ai.players)) {
    const stats = ensurePlayerStats(out.ai.players[key]);
    if (!stats.displayName) {
      stats.displayName = isPlayerUid(key) ? "" : String(key);
    }
    out.ai.players[key] = stats;
  }
  if (!Array.isArray(out.ai.tanks) || out.ai.tanks.length !== 4) {
    out.ai.tanks = TANK_DISPLAY_NAMES.map(() => defaultTankStats());
  } else {
    out.ai.tanks = out.ai.tanks.map((t) => ensureTankStats(t));
  }
  out.ai.matchups = ensureMatchupMatrix(out.ai.matchups);
  return out;
}

function ensureLeaderboardShape(leaderboard) {
  if (!leaderboard || typeof leaderboard !== "object") {
    return defaultLeaderboard();
  }
  if (isLegacyFlatLeaderboard(leaderboard)) {
    const appBoard = ensurePlatformBoard({
      random: leaderboard.random,
      ai: leaderboard.ai,
    });
    delete leaderboard.random;
    delete leaderboard.ai;
    leaderboard.app = appBoard;
    leaderboard.web = defaultPlatformBoard();
    return leaderboard;
  }
  leaderboard.app = ensurePlatformBoard(leaderboard.app || {});
  leaderboard.web = ensurePlatformBoard(leaderboard.web || {});
  return leaderboard;
}

function getPlatformBoard(root, platform) {
  const lb = ensureLeaderboardShape(root || {});
  return lb[normalizeLeaderboardPlatform(platform)];
}

function hasPlatformStats(board) {
  const randomPlayers = Object.keys(board?.random?.players || {}).length;
  const aiPlayers = Object.keys(board?.ai?.players || {}).length;
  const randomTanks = (board?.random?.tanks || []).some(
    (t) =>
      Number(t.wins || 0) +
        Number(t.losses || 0) +
        Number(t.appearances || 0) +
        Number(t.kills || 0) +
        Number(t.treasures || 0) >
      0
  );
  const aiTanks = (board?.ai?.tanks || []).some(
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

function hasLeaderboardStats(leaderboard) {
  const lb = ensureLeaderboardShape(leaderboard || {});
  return hasPlatformStats(lb.app) || hasPlatformStats(lb.web);
}

module.exports = {
  TANK_DISPLAY_NAMES,
  PLAYER_RATE_MIN_GAMES,
  PLAYER_AVG_MIN_GAMES,
  TANK_AVG_MIN_APPEARANCES,
  POPULARITY_WINDOW_MS,
  HIDDEN_E_DEFAULT,
  HIDDEN_E_MIN,
  HIDDEN_E_MAX,
  HIDDEN_E_DELTA,
  defaultLeaderboard,
  defaultPlatformBoard,
  defaultPlayerStats,
  defaultTankStats,
  ensureLeaderboardShape,
  ensurePlatformBoard,
  ensureMatchupMatrix,
  ensurePlayerStats,
  ensureTankStats,
  defaultMatchupMatrix,
  hasLeaderboardStats,
  hasPlatformStats,
  getPlatformBoard,
  normalizeLeaderboardPlatform,
  isPlayerUid,
  normalizePlayerUid,
  extractPublicTag,
  mergePlayerStatsObjects,
};
