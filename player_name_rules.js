const fs = require("fs");
const path = require("path");

const RULES_PATH = path.join(__dirname, "..", "data", "player_name_rules.json");

let cached = null;

function loadRules() {
  if (cached) return cached;
  const fallback = {
    min_len: 1,
    max_len: 12,
    allow_spaces: true,
    blacklist: [],
  };
  try {
    const raw = fs.readFileSync(RULES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cached = {
      min_len: Math.max(1, Number(parsed.min_len || fallback.min_len)),
      max_len: Math.max(1, Number(parsed.max_len || fallback.max_len)),
      allow_spaces: parsed.allow_spaces !== false,
      blacklist: Array.isArray(parsed.blacklist)
        ? parsed.blacklist
            .map((w) => normalizeForMatch(String(w || "")))
            .filter((w) => w.length > 0)
        : [],
    };
    if (cached.max_len < cached.min_len) cached.max_len = cached.min_len;
  } catch (err) {
    console.warn(`[NameRules] 無法載入 ${RULES_PATH}: ${err.message}`);
    cached = fallback;
  }
  return cached;
}

function normalizeForMatch(text) {
  let out = String(text || "")
    .trim()
    .toLowerCase();
  for (const ch of [" ", "_", "-", ".", "·", "・", "*", "|", "/", "\\", "'", '"', "`"]) {
    out = out.split(ch).join("");
  }
  let converted = "";
  for (const ch of out) {
    const code = ch.codePointAt(0);
    if (code >= 0xff10 && code <= 0xff19) {
      converted += String.fromCodePoint(code - 0xff10 + 48);
    } else if (code >= 0xff21 && code <= 0xff3a) {
      converted += String.fromCodePoint(code - 0xff21 + 97);
    } else if (code >= 0xff41 && code <= 0xff5a) {
      converted += String.fromCodePoint(code - 0xff41 + 97);
    } else {
      converted += ch;
    }
  }
  return converted;
}

function sanitizePlayerNamePart(raw) {
  const rules = loadRules();
  let text = String(raw || "").trim();
  let cleaned = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) continue;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    cleaned += ch;
  }
  text = cleaned.trim().replace(/ {2,}/g, " ");
  if (!rules.allow_spaces) text = text.replace(/ /g, "");
  if (text.length > rules.max_len) text = text.slice(0, rules.max_len);
  return text.trim();
}

function isCharsetAllowed(text, allowSpaces) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 32) {
      if (!allowSpaces) return false;
      continue;
    }
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    ) {
      continue;
    }
    if (code >= 0xff10 && code <= 0xff19) continue;
    if (code >= 0xff21 && code <= 0xff3a) continue;
    if (code >= 0xff41 && code <= 0xff5a) continue;
    if (code >= 0x3400 && code <= 0x4dbf) continue;
    if (code >= 0x4e00 && code <= 0x9fff) continue;
    if (code >= 0xf900 && code <= 0xfaff) continue;
    if (code === 0x00b7 || code === 0x30fb) continue;
    return false;
  }
  return true;
}

function containsBlacklist(text) {
  const rules = loadRules();
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  return rules.blacklist.some((word) => word && normalized.includes(word));
}

/** 從可能含 #代號 的顯示名取出名稱本體 */
function extractNamePart(raw) {
  const text = String(raw || "").trim();
  const idx = text.lastIndexOf(" #");
  if (idx >= 0) return text.slice(0, idx).trim();
  const hash = text.lastIndexOf("#");
  if (hash > 0) return text.slice(0, hash).trim();
  return text;
}

/**
 * @returns {{ ok: boolean, message: string, sanitized: string }}
 */
function validatePlayerName(raw) {
  const rules = loadRules();
  const namePart = extractNamePart(raw).trim();
  if (!rules.allow_spaces && namePart.includes(" ")) {
    return {
      ok: false,
      message: "名稱不可包含空格",
      sanitized: namePart.replace(/ /g, ""),
    };
  }
  const sanitized = sanitizePlayerNamePart(namePart);
  if (!sanitized) {
    return { ok: false, message: "玩家名稱不可為空", sanitized: "" };
  }
  if (sanitized.length < rules.min_len) {
    return {
      ok: false,
      message: `名稱至少需要 ${rules.min_len} 個字`,
      sanitized,
    };
  }
  if (sanitized.length > rules.max_len) {
    return {
      ok: false,
      message: `名稱最多 ${rules.max_len} 個字`,
      sanitized: sanitized.slice(0, rules.max_len),
    };
  }
  if (!isCharsetAllowed(sanitized, rules.allow_spaces)) {
    return {
      ok: false,
      message: rules.allow_spaces
        ? "僅可使用中英文、數字與空格"
        : "僅可使用中英文與數字",
      sanitized,
    };
  }
  if (containsBlacklist(sanitized)) {
    return {
      ok: false,
      message: "名稱含有不適當內容，請更換",
      sanitized,
    };
  }
  return { ok: true, message: "", sanitized };
}

module.exports = {
  loadRules,
  validatePlayerName,
  sanitizePlayerNamePart,
  extractNamePart,
};
