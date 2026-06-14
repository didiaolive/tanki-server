const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const {
  TANK_DISPLAY_NAMES,
  defaultMatchupMatrix,
  ensureMatchupMatrix,
} = require("./leaderboard_schema");
const lbStore = require("./leaderboard_store");

const PORT = process.env.PORT || 8765;
const SERVER_VERSION = "v32";
const TANK_ROLE_NAMES = ["重型", "驅逐", "中型", "輕型"];
// 目標克制鏈：重>中>輕>驅逐>重（索引 0>2>3>1>0）
const IDEAL_ADVANTAGE_PAIRS = [
  [0, 2],
  [2, 3],
  [3, 1],
  [1, 0],
];

const DEFAULT_TANK_POSITIONS = [[6, 9], [3, 0]];
const TURN_BACKUP_FIRST_ROUND_MS = 50000;
const TURN_BACKUP_ROUND_MS = 35000;

/** @type {Map<string, any>} */
const rooms = new Map();
/** @type {Map<WebSocket, any>} */
const clients = new Map();
/** @type {WebSocket[]} */
const matchQueue = [];

let nextClientId = 1;

function makeRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  if (rooms.has(id)) return makeRoomId();
  return id;
}

function normalizePlayerName(raw) {
  const name = String(raw || "玩家").trim().slice(0, 12);
  return name || "玩家";
}

function normalizeTankIndex(raw) {
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index > 3) return 0;
  return index;
}

function loadLeaderboard() {
  return lbStore.loadLeaderboard();
}

function saveLeaderboard(data) {
  lbStore.saveLeaderboard(data);
}

// 僅在「正常戰鬥結束」時呼叫：同時更新連勝與車種勝敗（供戰力平衡參考）。
// 投降、中離等非正常結束不應呼叫此函式。
function recordModePlayerResult(bucket, playerName, tankIndex, won, isDraw) {
  const name = normalizePlayerName(playerName);
  if (!bucket.players[name]) {
    bucket.players[name] = { bestStreak: 0, currentStreak: 0 };
  }
  const player = bucket.players[name];
  if (isDraw) {
    player.currentStreak = 0;
  } else if (won) {
    player.currentStreak += 1;
    player.bestStreak = Math.max(player.bestStreak, player.currentStreak);
  } else {
    player.currentStreak = 0;
  }

  const tank = bucket.tanks[normalizeTankIndex(tankIndex)];
  if (!isDraw) {
    if (won) tank.wins += 1;
    else tank.losses += 1;
  }
}

function recordTankMatchup(bucket, tankA, tankB, aWon, isDraw) {
  const a = normalizeTankIndex(tankA);
  const b = normalizeTankIndex(tankB);
  if (a === b) return;
  if (!bucket.matchups) bucket.matchups = defaultMatchupMatrix();
  bucket.matchups = ensureMatchupMatrix(bucket.matchups);
  if (isDraw) {
    bucket.matchups[a][b].draws += 1;
    return;
  }
  if (aWon) {
    bucket.matchups[a][b].wins += 1;
    bucket.matchups[b][a].losses += 1;
  } else {
    bucket.matchups[b][a].wins += 1;
    bucket.matchups[a][b].losses += 1;
  }
}

function recordRandomPlayerResult(leaderboard, playerName, tankIndex, won, isDraw) {
  recordModePlayerResult(leaderboard.random, playerName, tankIndex, won, isDraw);
}

function recordAiPlayerResult(leaderboard, playerName, tankIndex, won, isDraw) {
  recordModePlayerResult(leaderboard.ai, playerName, tankIndex, won, isDraw);
}

function pruneDeadClients() {
  for (const [ws] of clients) {
    if (ws.readyState !== ws.OPEN) {
      removeFromQueue(ws);
      leaveRoom(ws);
      clients.delete(ws);
    }
  }
}

function trySetClientName(client, rawName) {
  pruneDeadClients();
  const name = normalizePlayerName(rawName);

  if (client.ownerToken) {
    for (const [, other] of clients) {
      if (other.id === client.id) continue;
      if (other.ownerToken === client.ownerToken) {
        other.displayName = "玩家";
      }
    }
  }

  for (const [ws, other] of clients) {
    if (other.id === client.id) continue;
    if (ws.readyState !== ws.OPEN) continue;
    if (normalizePlayerName(other.displayName) !== name) continue;
    return { ok: false, message: `名稱「${name}」已被其他玩家使用，請換一個` };
  }

  client.displayName = name;
  return { ok: true, name };
}

function handleReservePlayerName(ws, data) {
  const client = clients.get(ws);
  if (!client) return;

  if (data.client_token != null) {
    const token = String(data.client_token).trim().slice(0, 64);
    client.ownerToken = token || null;
  }

  const result = trySetClientName(client, data.player_name);
  if (!result.ok) {
    send(ws, { type: "name_reserved", ok: false, message: result.message });
    return;
  }

  send(ws, {
    type: "name_reserved",
    ok: true,
    player_name: result.name,
  });
}

function recordRandomRoomResult(room, winnerIndex, isDraw = false) {
  if (!room || !room.isRandom || room.leaderboardRecorded) return;
  room.leaderboardRecorded = true;
  const leaderboard = loadLeaderboard();
  for (const player of room.players) {
    const won = !isDraw && player.playerIndex === winnerIndex;
    recordRandomPlayerResult(
      leaderboard,
      player.displayName,
      player.tankIndex,
      won,
      isDraw
    );
  }
  if (room.players.length === 2) {
    const p0 = room.players.find((p) => p.playerIndex === 0);
    const p1 = room.players.find((p) => p.playerIndex === 1);
    if (p0 && p1) {
      recordTankMatchup(
        leaderboard.random,
        p0.tankIndex,
        p1.tankIndex,
        !isDraw && winnerIndex === p0.playerIndex,
        isDraw
      );
    }
  }
  saveLeaderboard(leaderboard);
}

function getTop3Streak(players) {
  return Object.entries(players)
    .map(([name, stats]) => ({
      name,
      value: Number(stats.bestStreak || 0),
      wins: 0,
      losses: 0,
    }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, 3);
}

function getTop3TankWinrate(tanks) {
  return tanks
    .map((tank, index) => {
      const wins = Number(tank.wins || 0);
      const losses = Number(tank.losses || 0);
      const total = wins + losses;
      return {
        name: TANK_DISPLAY_NAMES[index] || `戰車${index + 1}`,
        value: total > 0 ? Math.round((wins * 100) / total) : 0,
        wins,
        losses,
      };
    })
    .filter((entry) => entry.wins + entry.losses > 0)
    .sort((a, b) => b.value - a.value || b.wins - a.wins || a.name.localeCompare(b.name))
    .slice(0, 3);
}

function padTop3(entries) {
  const result = entries.slice(0, 3);
  while (result.length < 3) {
    result.push({ name: "---", value: 0, wins: 0, losses: 0 });
  }
  return result;
}

function buildLeaderboardPayload() {
  const leaderboard = loadLeaderboard();
  return {
    type: "leaderboard",
    random_streak_top3: padTop3(getTop3Streak(leaderboard.random.players)),
    random_tank_top3: padTop3(getTop3TankWinrate(leaderboard.random.tanks)),
    ai_streak_top3: padTop3(getTop3Streak(leaderboard.ai.players)),
    ai_tank_top3: padTop3(getTop3TankWinrate(leaderboard.ai.tanks)),
  };
}

function handleGetLeaderboard(ws) {
  send(ws, buildLeaderboardPayload());
}

function handleReportMatchResult(ws, data) {
  const client = clients.get(ws);
  if (!client) return;
  if (!data.normal_end) return;

  const mode = String(data.mode || "random");
  const isDraw = Boolean(data.is_draw);
  const winnerIndex = Number(data.winner_index);

  if (mode === "ai") {
    const leaderboard = loadLeaderboard();
    const playerTank = normalizeTankIndex(
      data.tank_index != null ? data.tank_index : client.tankIndex
    );
    recordAiPlayerResult(
      leaderboard,
      client.displayName,
      playerTank,
      Boolean(data.won),
      isDraw
    );
    if (data.opponent_tank_index != null) {
      recordTankMatchup(
        leaderboard.ai,
        playerTank,
        data.opponent_tank_index,
        Boolean(data.won),
        isDraw
      );
    }
    saveLeaderboard(leaderboard);
    return;
  }

  const room = client.roomId ? rooms.get(client.roomId) : null;

  if (room && room.isRandom && room.state === "playing" && Number.isInteger(winnerIndex)) {
    recordRandomRoomResult(room, winnerIndex, isDraw);
    return;
  }

  const leaderboard = loadLeaderboard();
  const playerTank = normalizeTankIndex(
    data.tank_index != null ? data.tank_index : client.tankIndex
  );
  recordRandomPlayerResult(
    leaderboard,
    client.displayName,
    playerTank,
    Boolean(data.won),
    isDraw
  );
  if (data.opponent_tank_index != null) {
    recordTankMatchup(
      leaderboard.random,
      playerTank,
      data.opponent_tank_index,
      Boolean(data.won),
      isDraw
    );
  }
  saveLeaderboard(leaderboard);
}

function applyPlayerLoadout(ws, data) {
  const client = clients.get(ws);
  if (!client) return false;
  if (data.player_name != null) {
    const result = trySetClientName(client, data.player_name);
    if (!result.ok) {
      sendError(ws, result.message);
      return false;
    }
  }
  if (data.tank_index != null) {
    client.tankIndex = normalizeTankIndex(data.tank_index);
  }
  return true;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, message) {
  send(ws, { type: "error", message });
}

function getPublicRoomList() {
  return Array.from(rooms.values())
    .filter((room) => room.state === "waiting")
    .map((room) => ({
      id: room.id,
      name: room.name,
      has_password: Boolean(room.password),
      players: room.players.length,
    }));
}

function removeFromQueue(ws) {
  const index = matchQueue.indexOf(ws);
  if (index >= 0) matchQueue.splice(index, 1);
}

function leaveRoom(ws) {
  const client = clients.get(ws);
  if (!client || !client.roomId) return;

  const room = rooms.get(client.roomId);
  if (!room) return;

  const wasPlaying = room.state === "playing";
  const wasFinished = room.state === "finished";
  const leavingIndex = client.playerIndex;

  room.players = room.players.filter((p) => p.ws !== ws);

  if ((wasPlaying || wasFinished) && room.players.length === 1) {
    const winner = room.players[0];
    room.state = "finished";
    send(winner.ws, {
      type: "match_end",
      reason: "opponent_left",
      winner_index: winner.playerIndex,
      left_player_index: leavingIndex,
    });
  } else if (room.players.length > 0) {
    broadcastRoom(room, {
      type: "player_left",
      room_id: room.id,
      players: room.players.length,
      left_player_index: leavingIndex,
    });
    room.state = "waiting";
    room.turns = [{}, {}];
  }

  if (room.players.length === 0) {
    clearTurnTimer(room);
    rooms.delete(room.id);
  }

  client.roomId = null;
  client.playerIndex = -1;
}

function broadcastRoom(room, payload, exceptWs = null) {
  for (const player of room.players) {
    if (player.ws !== exceptWs) {
      send(player.ws, payload);
    }
  }
}

function broadcastAll(room, payload) {
  for (const player of room.players) {
    send(player.ws, payload);
  }
}

function getSortedPlayerNames(room) {
  return room.players
    .slice()
    .sort((a, b) => a.playerIndex - b.playerIndex)
    .map((player) => player.displayName);
}

function getSortedTankIndices(room) {
  return room.players
    .slice()
    .sort((a, b) => a.playerIndex - b.playerIndex)
    .map((player) => normalizeTankIndex(player.tankIndex));
}

function normalizeTurnCells(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (typeof raw[0] === "number") {
    return [[Number(raw[0]), Number(raw[1])]];
  }
  const cells = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2) return null;
    cells.push([Number(point[0]), Number(point[1])]);
  }
  return cells.length > 0 ? cells : null;
}

function finalMovePoint(moveCells) {
  return moveCells[moveCells.length - 1];
}

function clearTurnTimer(room) {
  if (!room || !room.turnTimer) return;
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
}

function startTurnBackupTimer(room, isFirstRound) {
  clearTurnTimer(room);
  if (!room.isRandom || room.state !== "playing") return;
  const delay = isFirstRound ? TURN_BACKUP_FIRST_ROUND_MS : TURN_BACKUP_ROUND_MS;
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), delay);
}

function handleTurnTimeout(room) {
  room.turnTimer = null;
  if (!room || room.state !== "playing") return;

  let changed = false;
  for (let i = 0; i < 2; i++) {
    const turn = room.turns[i] || {};
    if (!turn.move || !turn.shoot) {
      const pos = room.tankPositions[i];
      room.turns[i] = {
        move: [[pos[0], pos[1]]],
        shoot: [[pos[0], pos[1]]],
      };
      changed = true;
    }
  }

  if (!changed) return;

  const submitted = room.turns.filter((turn) => turn.move && turn.shoot).length;
  broadcastAll(room, {
    type: "turn_status",
    submitted,
    total: 2,
  });
  tryExecuteRound(room);
}

function tryExecuteRound(room) {
  const submitted = room.turns.filter((turn) => turn.move && turn.shoot).length;
  if (submitted < 2) return;

  for (let i = 0; i < 2; i++) {
    const moveCells = normalizeTurnCells(room.turns[i].move);
    if (moveCells) {
      room.tankPositions[i] = [...finalMovePoint(moveCells)];
    }
  }

  broadcastAll(room, {
    type: "round_execute",
    turns: room.turns.map((turn) => ({
      move: turn.move,
      shoot: turn.shoot,
    })),
  });

  room.turns = [{}, {}];
  startTurnBackupTimer(room, false);
}

function tryStartGame(room) {
  if (room.players.length < 2 || room.state !== "waiting") return;
  room.state = "playing";
  room.turns = [{}, {}];
  room.tankPositions = DEFAULT_TANK_POSITIONS.map((pos) => [...pos]);
  room.leaderboardRecorded = false;
  const firstAttacker = Math.floor(Math.random() * 2);
  const playerNames = getSortedPlayerNames(room);
  const tankIndices = getSortedTankIndices(room);
  for (const player of room.players) {
    send(player.ws, {
      type: "game_start",
      room_id: room.id,
      players: room.players.length,
      player_index: player.playerIndex,
      first_attacker: firstAttacker,
      player_names: playerNames,
      tank_indices: tankIndices,
      is_random: Boolean(room.isRandom),
    });
  }
  startTurnBackupTimer(room, true);
}

function tryMatchRandom() {
  while (matchQueue.length >= 2) {
    const wsA = matchQueue.shift();
    const wsB = matchQueue.shift();
    const roomId = makeRoomId();
    const room = {
      id: roomId,
      name: `隨機對戰 ${roomId}`,
      password: "",
      state: "waiting",
      turns: [{}, {}],
      players: [],
      isRandom: true,
    };
    rooms.set(roomId, room);
    joinPlayerToRoom(wsA, room, 0);
    joinPlayerToRoom(wsB, room, 1);
    tryStartGame(room);
  }
}

function joinPlayerToRoom(ws, room, playerIndex) {
  const client = clients.get(ws);
  if (!client) return false;

  if (room.players.length >= 2) return false;

  if (playerIndex < 0) {
    playerIndex = room.players.length;
  }

  const displayName = normalizePlayerName(client.displayName);
  const tankIndex = normalizeTankIndex(client.tankIndex);
  room.players.push({ ws, playerIndex, displayName, tankIndex });
  client.roomId = room.id;
  client.playerIndex = playerIndex;

  send(ws, {
    type: "joined_room",
    room_id: room.id,
    room_name: room.name,
    player_index: playerIndex,
    players: room.players.length,
    player_names: getSortedPlayerNames(room),
  });

  broadcastRoom(
    room,
    {
      type: "player_joined",
      room_id: room.id,
      players: room.players.length,
    },
    ws
  );

  if (room.players.length >= 2) {
    broadcastAll(room, {
      type: "player_names_sync",
      player_names: getSortedPlayerNames(room),
    });
  }

  return true;
}

function applyPlayerName(ws, data) {
  return applyPlayerLoadout(ws, data);
}

function handleCreateRoom(ws, data) {
  if (!applyPlayerLoadout(ws, data)) return;
  const name = (data.name || "未命名房間").trim().slice(0, 32);
  const password = (data.password || "").trim();
  const roomId = makeRoomId();
  const room = {
    id: roomId,
    name,
    password,
    state: "waiting",
    turns: [{}, {}],
    players: [],
    isRandom: false,
  };
  rooms.set(roomId, room);
  leaveRoom(ws);
  joinPlayerToRoom(ws, room, 0);
  send(ws, {
    type: "room_created",
    room_id: roomId,
    room_name: name,
    player_index: 0,
  });
}

function handleJoinRoom(ws, data) {
  if (!applyPlayerLoadout(ws, data)) return;
  const roomId = String(data.room_id || "").trim().toUpperCase();
  const password = String(data.password || "").trim();
  const room = rooms.get(roomId);

  if (!room) {
    sendError(ws, "找不到房間");
    return;
  }
  if (room.password && room.password !== password) {
    sendError(ws, "房間密碼錯誤");
    return;
  }
  if (room.players.length >= 2) {
    sendError(ws, "房間已滿");
    return;
  }

  leaveRoom(ws);
  joinPlayerToRoom(ws, room, room.players.length);
  tryStartGame(room);
}

function handleJoinRandom(ws, data) {
  if (!applyPlayerLoadout(ws, data)) return;
  removeFromQueue(ws);
  leaveRoom(ws);
  if (!matchQueue.includes(ws)) {
    matchQueue.push(ws);
  }
  send(ws, { type: "match_queued" });
  tryMatchRandom();
}

function handleAnnouncePlayerName(ws, data) {
  const client = clients.get(ws);
  if (!client || !client.roomId) return;

  if (!applyPlayerLoadout(ws, data)) return;

  const room = rooms.get(client.roomId);
  if (!room) return;

  const player = room.players.find((entry) => entry.ws === ws);
  if (player) {
    player.displayName = normalizePlayerName(client.displayName);
    player.tankIndex = normalizeTankIndex(client.tankIndex);
  }

  broadcastAll(room, {
    type: "player_names_sync",
    player_names: getSortedPlayerNames(room),
  });
}

function handleSurrender(ws) {
  const client = clients.get(ws);
  if (!client || !client.roomId) {
    sendError(ws, "尚未加入房間");
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room || room.state !== "playing") {
    sendError(ws, "對戰尚未開始");
    return;
  }

  room.state = "finished";
  const surrenderIndex = client.playerIndex;
  const winnerIndex = room.players.find((p) => p.playerIndex !== surrenderIndex)?.playerIndex ?? -1;
  const payload = {
    type: "match_end",
    reason: "surrender",
    winner_index: winnerIndex,
    surrender_player_index: surrenderIndex,
  };
  for (const player of room.players) {
    send(player.ws, payload);
    send(player.ws, {
      type: "surrender",
      player_index: surrenderIndex,
    });
  }
}

function handleSubmitTurn(ws, data) {
  const client = clients.get(ws);
  if (!client || !client.roomId) {
    sendError(ws, "尚未加入房間");
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room || room.state !== "playing") {
    sendError(ws, "對戰尚未開始");
    return;
  }

  const move = normalizeTurnCells(data.move);
  const shoot = normalizeTurnCells(data.shoot);
  if (!move || !shoot) {
    sendError(ws, "回合資料格式錯誤");
    return;
  }

  const index = client.playerIndex;
  if (room.turns[index].move && room.turns[index].shoot) {
    return;
  }

  room.turns[index] = { move, shoot };

  const submitted = room.turns.filter((turn) => turn.move && turn.shoot).length;
  broadcastAll(room, {
    type: "turn_status",
    submitted,
    total: 2,
  });

  tryExecuteRound(room);
}

function handleTreasureSpawn(ws, data) {
  const client = clients.get(ws);
  if (!client || !client.roomId) {
    sendError(ws, "尚未加入房間");
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room || room.state !== "playing") {
    sendError(ws, "對戰尚未開始");
    return;
  }

  if (client.playerIndex !== 0) {
    sendError(ws, "僅 0 號玩家可同步寶藏位置");
    return;
  }

  const kind = String(data.kind || "");
  if (kind !== "bonus" && kind !== "respawn") {
    sendError(ws, "寶藏類型無效");
    return;
  }

  const round = Number(data.round);
  if (!Number.isInteger(round) || round < 0) {
    sendError(ws, "回合編號無效");
    return;
  }

  const x = Number(data.x);
  const y = Number(data.y);
  const hasCell = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0;

  broadcastAll(room, {
    type: "treasure_spawn",
    kind,
    round,
    x: hasCell ? x : -1,
    y: hasCell ? y : -1,
  });
}

function mergeMatchupMatrices(a, b) {
  const result = defaultMatchupMatrix();
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      result[i][j].wins = Number(a[i][j].wins || 0) + Number(b[i][j].wins || 0);
      result[i][j].losses = Number(a[i][j].losses || 0) + Number(b[i][j].losses || 0);
      result[i][j].draws = Number(a[i][j].draws || 0) + Number(b[i][j].draws || 0);
    }
  }
  return result;
}

function matchupWinRate(cell) {
  const wins = Number(cell.wins || 0);
  const losses = Number(cell.losses || 0);
  const total = wins + losses;
  if (total <= 0) return null;
  return Math.round((wins * 100) / total);
}

function formatTankLabel(index) {
  return `${TANK_DISPLAY_NAMES[index]}（${TANK_ROLE_NAMES[index]}）`;
}

function buildMatchupSection(title, matrix) {
  const lines = [title, ""];
  lines.push("（列=我方車種，欄=對手車種，數字=我方勝率% / 樣本場次）");
  lines.push("");
  const header = ["我方＼對手", ...TANK_DISPLAY_NAMES].join("\t");
  lines.push(header);
  for (let mine = 0; mine < 4; mine++) {
    const cells = [TANK_DISPLAY_NAMES[mine]];
    for (let opp = 0; opp < 4; opp++) {
      if (mine === opp) {
        cells.push("—");
        continue;
      }
      const cell = matrix[mine][opp];
      const wins = Number(cell.wins || 0);
      const losses = Number(cell.losses || 0);
      const draws = Number(cell.draws || 0);
      const total = wins + losses + draws;
      const rate = matchupWinRate(cell);
      if (rate == null) {
        cells.push("---");
      } else {
        cells.push(`${rate}% (${total})`);
      }
    }
    lines.push(cells.join("\t"));
  }
  return lines;
}

function buildIdealChainSection(matrix) {
  const lines = ["【目標克制鏈達成度】", "重坦>中坦>輕坦>驅逐>重坦", ""];
  for (const [attacker, defender] of IDEAL_ADVANTAGE_PAIRS) {
    const cell = matrix[attacker][defender];
    const rate = matchupWinRate(cell);
    const wins = Number(cell.wins || 0);
    const losses = Number(cell.losses || 0);
    const total = wins + losses;
    const label = `${formatTankLabel(attacker)} → ${formatTankLabel(defender)}`;
    if (rate == null) {
      lines.push(`${label}：尚無資料`);
      continue;
    }
    const status = rate >= 55 ? "✓ 達標傾向" : rate >= 50 ? "≈ 接近平衡" : "✗ 未達標";
    lines.push(`${label}：${rate}%（${wins}勝/${losses}敗） ${status}`);
  }
  return lines;
}

function buildBalanceReportText() {
  const leaderboard = loadLeaderboard();
  const persistence = lbStore.getPersistenceStatus();
  const randomMatrix = ensureMatchupMatrix(leaderboard.random.matchups);
  const aiMatrix = ensureMatchupMatrix(leaderboard.ai.matchups);
  const allMatrix = mergeMatchupMatrices(randomMatrix, aiMatrix);

  const lines = [
    "坦棋 Tanki — 車種對戰平衡報表",
    `伺服器版本: ${SERVER_VERSION}`,
    `本機快取: ${persistence.file}`,
    `雲端持久化: ${persistence.cloudEnabled ? "已啟用" : "未設定"}`,
    `載入來源: ${persistence.source}`,
    "",
    "※ 僅統計「正常戰鬥結束」的對戰；投降、中離不列入。",
    "",
    ...buildMatchupSection("【全部模式合計｜車種對戰勝率】", allMatrix),
    "",
    ...buildIdealChainSection(allMatrix),
    "",
    ...buildMatchupSection("【隨機戰鬥｜車種對戰勝率】", randomMatrix),
    "",
    ...buildMatchupSection("【與電腦對戰｜車種對戰勝率】", aiMatrix),
    "",
    "各車種總勝率（隨機）：",
  ];

  for (const entry of getTop3TankWinrate(leaderboard.random.tanks)) {
    if (entry.wins + entry.losses <= 0) continue;
    lines.push(`  ${entry.name}：${entry.value}%（${entry.wins}勝/${entry.losses}敗）`);
  }

  lines.push("", "各車種總勝率（電腦）：");
  for (const entry of getTop3TankWinrate(leaderboard.ai.tanks)) {
    if (entry.wins + entry.losses <= 0) continue;
    lines.push(`  ${entry.name}：${entry.value}%（${entry.wins}勝/${entry.losses}敗）`);
  }

  return lines.join("\n");
}

function handleBalanceReport(req, res) {
  const requiredKey = process.env.BALANCE_REPORT_KEY || "";
  if (requiredKey) {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.searchParams.get("key") !== requiredKey) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(buildBalanceReportText());
}

const server = http.createServer((req, res) => {
  const pathOnly = String(req.url || "").split("?")[0];
  if (pathOnly === "/balance-report") {
    handleBalanceReport(req, res);
    return;
  }
  const persistence = lbStore.getPersistenceStatus();
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    `坦棋 Tanki server is running.\n版本: ${SERVER_VERSION}\n` +
      `排行榜持久化: ${persistence.cloudEnabled ? "Supabase 已啟用" : "僅本機檔案"}\n` +
      `載入來源: ${persistence.source}\n` +
      `平衡報表: /balance-report\n`
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const clientId = nextClientId++;
  clients.set(ws, {
    id: clientId,
    roomId: null,
    playerIndex: -1,
    displayName: "玩家",
    tankIndex: 0,
    ownerToken: null,
  });

  send(ws, { type: "connected", client_id: clientId, server_version: SERVER_VERSION });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      sendError(ws, "無效的 JSON");
      return;
    }

    switch (data.type) {
      case "list_rooms":
        send(ws, { type: "room_list", rooms: getPublicRoomList() });
        break;
      case "create_room":
        handleCreateRoom(ws, data);
        break;
      case "join_room":
        handleJoinRoom(ws, data);
        break;
      case "join_random":
        handleJoinRandom(ws, data);
        break;
      case "cancel_matchmaking":
        removeFromQueue(ws);
        leaveRoom(ws);
        send(ws, { type: "match_cancelled" });
        break;
      case "leave_match":
        leaveRoom(ws);
        break;
      case "submit_turn":
        handleSubmitTurn(ws, data);
        break;
      case "treasure_spawn":
        handleTreasureSpawn(ws, data);
        break;
      case "surrender":
        handleSurrender(ws);
        break;
      case "announce_player_name":
        handleAnnouncePlayerName(ws, data);
        break;
      case "reserve_player_name":
        handleReservePlayerName(ws, data);
        break;
      case "get_leaderboard":
        handleGetLeaderboard(ws);
        break;
      case "report_match_result":
        handleReportMatchResult(ws, data);
        break;
      default:
        sendError(ws, `未知指令: ${data.type}`);
    }
  });

  ws.on("close", () => {
    removeFromQueue(ws);
    leaveRoom(ws);
    clients.delete(ws);
  });
});

if (require.main === module) {
  lbStore
    .initLeaderboardStore()
    .then((status) => {
      console.log(
        `[Leaderboard] 載入完成 source=${status.source} cloud=${status.cloudEnabled}`
      );
      if (status.lastCloudError) {
        console.warn(`[Leaderboard] 雲端警告: ${status.lastCloudError}`);
      }
      server.listen(PORT, () => {
        console.log(`Tanki server listening on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("[Leaderboard] 初始化失敗:", err);
      process.exit(1);
    });
}

module.exports = { buildBalanceReportText };
