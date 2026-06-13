const fs = require("fs");
const path = require("path");
const {
  defaultLeaderboard,
  ensureLeaderboardShape,
  hasLeaderboardStats,
} = require("./leaderboard_schema");

const LEADERBOARD_FILE = path.join(__dirname, "leaderboard_data.json");
const CLOUD_ROW_ID = 1;

let cache = null;
let initStatus = {
  source: "default",
  cloudEnabled: false,
  lastCloudError: null,
};

function isCloudConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function readLocalFile() {
  try {
    const raw = fs.readFileSync(LEADERBOARD_FILE, "utf8");
    return ensureLeaderboardShape(JSON.parse(raw));
  } catch {
    return defaultLeaderboard();
  }
}

function writeLocalFile(data) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2), "utf8");
}

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function fetchFromCloud() {
  const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
  const res = await fetch(
    `${baseUrl}/rest/v1/leaderboard?select=data&id=eq.${CLOUD_ROW_ID}&limit=1`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) {
    throw new Error(`Supabase read failed (${res.status})`);
  }
  const rows = await res.json();
  if (!rows.length || !rows[0].data) return null;
  return ensureLeaderboardShape(rows[0].data);
}

async function saveToCloud(data) {
  const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/rest/v1/leaderboard`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      id: CLOUD_ROW_ID,
      data,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase write failed (${res.status}): ${text}`);
  }
  initStatus.lastCloudError = null;
}

async function initLeaderboardStore() {
  const local = readLocalFile();

  if (!isCloudConfigured()) {
    cache = local;
    initStatus = { source: "local", cloudEnabled: false, lastCloudError: null };
    return initStatus;
  }

  initStatus.cloudEnabled = true;

  try {
    const cloud = await fetchFromCloud();
    if (cloud && hasLeaderboardStats(cloud)) {
      cache = cloud;
      writeLocalFile(cache);
      initStatus = { source: "cloud", cloudEnabled: true, lastCloudError: null };
      return initStatus;
    }

    if (hasLeaderboardStats(local)) {
      cache = local;
      await saveToCloud(local);
      initStatus = {
        source: "local-migrated-to-cloud",
        cloudEnabled: true,
        lastCloudError: null,
      };
      return initStatus;
    }

    cache = cloud || local;
    if (hasLeaderboardStats(cache)) {
      await saveToCloud(cache);
    }
    initStatus = {
      source: cloud ? "cloud-empty" : "default",
      cloudEnabled: true,
      lastCloudError: null,
    };
    return initStatus;
  } catch (err) {
    cache = local;
    initStatus = {
      source: "local-fallback",
      cloudEnabled: true,
      lastCloudError: String(err.message || err),
    };
    console.warn("[Leaderboard] 雲端載入失敗，改用本機檔案:", initStatus.lastCloudError);
    return initStatus;
  }
}

function loadLeaderboard() {
  if (!cache) return defaultLeaderboard();
  return cache;
}

function saveLeaderboard(data) {
  cache = ensureLeaderboardShape(JSON.parse(JSON.stringify(data)));
  writeLocalFile(cache);

  if (!isCloudConfigured()) return;

  saveToCloud(cache).catch((err) => {
    initStatus.lastCloudError = String(err.message || err);
    console.error("[Leaderboard] 雲端儲存失敗:", initStatus.lastCloudError);
  });
}

function getPersistenceStatus() {
  return {
    file: LEADERBOARD_FILE,
    cloudEnabled: initStatus.cloudEnabled,
    source: initStatus.source,
    lastCloudError: initStatus.lastCloudError,
    hasStats: cache ? hasLeaderboardStats(cache) : false,
  };
}

module.exports = {
  LEADERBOARD_FILE,
  initLeaderboardStore,
  loadLeaderboard,
  saveLeaderboard,
  getPersistenceStatus,
  isCloudConfigured,
};
