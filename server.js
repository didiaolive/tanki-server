const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8765;

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
  const leavingIndex = client.playerIndex;

  room.players = room.players.filter((p) => p.ws !== ws);

  if (wasPlaying && room.players.length === 1) {
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

function tryStartGame(room) {
  if (room.players.length < 2 || room.state !== "waiting") return;
  room.state = "playing";
  room.turns = [{}, {}];
  const firstAttacker = Math.floor(Math.random() * 2);
  const playerNames = getSortedPlayerNames(room);
  for (const player of room.players) {
    send(player.ws, {
      type: "game_start",
      room_id: room.id,
      players: room.players.length,
      player_index: player.playerIndex,
      first_attacker: firstAttacker,
      player_names: playerNames,
    });
  }
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
  room.players.push({ ws, playerIndex, displayName });
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

  return true;
}

function applyPlayerName(ws, data) {
  const client = clients.get(ws);
  if (!client) return;
  if (data.player_name != null) {
    client.displayName = normalizePlayerName(data.player_name);
  }
}

function handleCreateRoom(ws, data) {
  applyPlayerName(ws, data);
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
  applyPlayerName(ws, data);
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
  applyPlayerName(ws, data);
  removeFromQueue(ws);
  leaveRoom(ws);
  if (!matchQueue.includes(ws)) {
    matchQueue.push(ws);
  }
  send(ws, { type: "match_queued" });
  tryMatchRandom();
}

function handleAnnouncePlayerName(ws, data) {
  applyPlayerName(ws, data);
  const client = clients.get(ws);
  if (!client || !client.roomId) return;

  const room = rooms.get(client.roomId);
  if (!room) return;

  const player = room.players.find((entry) => entry.ws === ws);
  if (player) {
    player.displayName = normalizePlayerName(client.displayName);
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
  broadcastAll(room, {
    type: "surrender",
    player_index: client.playerIndex,
  });
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

  const move = data.move;
  const shoot = data.shoot;
  if (!Array.isArray(move) || move.length !== 2 || !Array.isArray(shoot) || shoot.length !== 2) {
    sendError(ws, "回合資料格式錯誤");
    return;
  }

  const index = client.playerIndex;
  room.turns[index] = {
    move: [Number(move[0]), Number(move[1])],
    shoot: [Number(shoot[0]), Number(shoot[1])],
  };

  const submitted = room.turns.filter((turn) => turn.move && turn.shoot).length;
  broadcastAll(room, {
    type: "turn_status",
    submitted,
    total: 2,
  });

  if (submitted < 2) return;

  broadcastAll(room, {
    type: "round_execute",
    turns: room.turns.map((turn) => ({
      move: turn.move,
      shoot: turn.shoot,
    })),
  });

  room.turns = [{}, {}];
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("坦棋 Tanki server is running.\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const clientId = nextClientId++;
  clients.set(ws, {
    id: clientId,
    roomId: null,
    playerIndex: -1,
    displayName: "玩家",
  });

  send(ws, { type: "connected", client_id: clientId });

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
      case "submit_turn":
        handleSubmitTurn(ws, data);
        break;
      case "surrender":
        handleSurrender(ws);
        break;
      case "announce_player_name":
        handleAnnouncePlayerName(ws, data);
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
