const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8765;
const SERVER_VERSION = "v28";
const LEADERBOARD_FILE = path.join(__dirname, "leaderboard_data.json");
const TANK_DISPLAY_NAMES = ["虎式", "183", "T-34-85", "M41D"];

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

function defaultLeaderboard() {
  return {
    random: {
      players: {},
      tanks: TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 })),
    },
    ai: {
      players: {},
      tanks: TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 })),
    },
  };
}

function ensureLeaderboardShape(leaderboard) {
  if (!leaderboard.random) {
    leaderboard.random = defaultLeaderboard().random;
  }
  if (!leaderboard.random.players) leaderboard.random.players = {};
  if (!Array.isArray(leaderboard.random.tanks) || leaderboard.random.tanks.length !== 4) {
    leaderboard.random.tanks = TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 }));
  }
  if (!leaderboard.ai) {
    leaderboard.ai = defaultLeaderboard().ai;
  }
  if (!leaderboard.ai.players) leaderboard.ai.players = {};
  if (!Array.isArray(leaderboard.ai.tanks) || leaderboard.ai.tanks.length !== 4) {
    leaderboard.ai.tanks = TANK_DISPLAY_NAMES.map(() => ({ wins: 0, losses: 0 }));
  }
  return leaderboard;
}

function loadLeaderboard() {
  try {
    const raw = fs.readFileSync(LEADERBOARD_FILE, "utf8");
    return ensureLeaderboardShape(JSON.parse(raw));
  } catch {
    return defaultLeaderboard();
  }
}

function saveLeaderboard(data) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2), "utf8");
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

function recordRandomPlayerResult(leaderboard, playerName, tankIndex, won, isDraw) {
  recordModePlayerResult(leaderboard.random, playerName, tankIndex, won, isDraw);
}

function recordAiPlayerResult(leaderboard, playerName, tankIndex, won, isDraw) {
  recordModePlayerResult(leaderboard.ai, playerName, tankIndex, won, isDraw);
}

function isNameTakenByOther(name, clientId) {
  const normalized = normalizePlayerName(name);
  for (const [, client] of clients) {
    if (client.id === clientId) continue;
    if (normalizePlayerName(client.displayName) === normalized) {
      return true;
    }
  }
  return false;
}

function trySetClientName(client, rawName) {
  const name = normalizePlayerName(rawName);
  if (isNameTakenByOther(name, client.id)) {
    return { ok: false, message: `名稱「${name}」已被使用，請換一個` };
  }
  client.displayName = name;
  return { ok: true, name };
}

function handleReservePlayerName(ws, data) {
  const client = clients.get(ws);
  if (!client) return;

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
    recordAiPlayerResult(
      leaderboard,
      client.displayName,
      data.tank_index != null ? data.tank_index : client.tankIndex,
      Boolean(data.won),
      isDraw
    );
    saveLeaderboard(leaderboard);
    return;
  }

  const room = client.roomId ? rooms.get(client.roomId) : null;

  if (room && room.isRandom && room.state === "playing" && Number.isInteger(winnerIndex)) {
    recordRandomRoomResult(room, winnerIndex, isDraw);
    return;
  }

  const leaderboard = loadLeaderboard();
  recordRandomPlayerResult(
    leaderboard,
    client.displayName,
    data.tank_index != null ? data.tank_index : client.tankIndex,
    Boolean(data.won),
    isDraw
  );
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

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`坦棋 Tanki server is running.\n版本: ${SERVER_VERSION}\n`);
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

server.listen(PORT, () => {
  console.log(`Tanki server listening on port ${PORT}`);
});
