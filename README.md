# 坦棋 Tanki — WebSocket 伺服器

Node.js 房間伺服器，供 Godot Web / 桌面版線上對戰使用。

## 本機測試

```bash
cd server
npm install
npm start
```

預設監聽 `8765`。Godot **除錯版**會連 `ws://localhost:8765`（見 `network_manager.gd`）。

## 為什麼網頁/手機連不上本機 server？

| 環境 | 連哪裡 |
|------|--------|
| Godot 編輯器 F5 | `ws://127.0.0.1:8765`（本機 npm start） |
| itch.io 網頁 / 手機 | **必須**用雲端 `wss://` 網址 |

瀏覽器與手機**無法**連你電腦上的 localhost，所以一定要部署雲端伺服器。

## 部署到 Render（免費，約 10 分鐘）

1. 將整個專案推到 **GitHub**（需含 `server` 資料夾）。
2. 到 [render.com](https://render.com) 註冊 → **New → Blueprint** 或 **Web Service**。
3. 若用手動建立 Web Service，設定：
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. 部署完成後打開 Render 給的網址，應看到：
   ```
   坦棋 Tanki server is running.
   ```
5. 在 Godot 開啟 **`network_manager.gd`**，修改第 16 行：

   ```gdscript
   @export var production_server_url: String = "wss://你的服務名稱.onrender.com"
   ```

   把 `https://` 改成 `wss://`，**不要**加路徑。

6. **重新匯出 Web 版**（專案 → 匯出 → HTML5）到 `Tanki 坦棋/初版/`。
7. 用 Butler 重新上傳 itch.io。

> 免費 Render 休眠後，第一次連線可能要等 **30～60 秒** 才會成功。

## 部署到 Railway

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub。
2. 設定 **Root Directory** 為 `server`，啟動指令 `npm start`。
3. 在 Settings 產生公開網域，將 `production_server_url` 改為對應的 `wss://...`。

## API 訊息格式

### 客戶端 → 伺服器

| type | 欄位 |
|------|------|
| `list_rooms` | — |
| `create_room` | `name`, `password`（可空） |
| `join_room` | `room_id`, `password`（可空） |
| `join_random` | — |
| `submit_turn` | `move: [x,y]`, `shoot: [x,y]` |

### 伺服器 → 客戶端

| type | 說明 |
|------|------|
| `room_list` | 等候中的房間列表 |
| `room_created` | 房主建立成功 |
| `joined_room` | 加入房間 |
| `match_queued` | 已進入隨機配對佇列 |
| `game_start` | 雙方到齊，開始對戰 |
| `turn_status` | 本回合提交進度 |
| `round_execute` | 雙方都提交，執行回合 |
| `error` | 錯誤訊息 |

## 注意事項

- 免費主機休眠後，第一次連線可能需等 30–60 秒喚醒。
- 目前為**權威僅同步回合指令**；勝負、寶藏等由雙方客戶端各自計算（需保持版本一致）。
- 生產環境建議加上連線數限制與日誌監控。

## 排行榜持久化（Supabase，建議設定）

Render 免費版 **Deploy 會清空本機檔案**。v31 起支援把戰績同步到 **Supabase 免費雲端資料庫**，Deploy 後資料會保留。

### 1. 建立 Supabase 專案（免費）

1. 到 [supabase.com](https://supabase.com) 註冊並 **New Project**
2. 記下 **Project URL**（例如 `https://xxxxx.supabase.co`）
3. 到 **Project Settings → API**，複製 **`service_role` secret**（僅放伺服器，勿公開）

### 2. 建立資料表

在 Supabase **SQL Editor** 貼上並執行 `server/supabase_setup.sql` 的內容。

### 3. Render 環境變數

在 Render → 你的 Web Service → **Environment** 新增：

| 變數名稱 | 值 |
|----------|-----|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` 那串金鑰 |

儲存後 **Deploy latest commit**。

### 4. 確認成功

打開伺服器首頁，應看到類似：

```
排行榜持久化: Supabase 已啟用
載入來源: cloud
```

若顯示 `僅本機檔案`，代表環境變數尚未設定或打錯。

### 運作方式

- **啟動時**：優先從 Supabase 載入；若雲端空、本機有舊檔，會自動上傳到雲端
- **每場對戰結束**：同時寫入本機快取 + Supabase
- **Deploy 之後**：從 Supabase 還原，排行榜不會整批消失

### 未設定 Supabase 時

行為與以前相同（只寫 `leaderboard_data.json`），Deploy 仍可能清空。

## 排行榜資料會不會被刪除？

戰績寫在伺服器本機的 `leaderboard_data.json`，**程式不會自動清空**，只會一直累加。

| 情況 | 資料會不會不見 |
|------|----------------|
| 伺服器正常運作、檔案還在 | ✅ 持續累積 |
| 投降、中離、非正常結束 | ❌ 不會寫入（不是刪除） |
| **Render 免費版重新部署**（未設 Supabase） | ⚠️ 可能整個清空 |
| **Render 重新部署**（**已設 Supabase**） | ✅ 從雲端還原，持續累積 |
| 手動刪除 `leaderboard_data.json` | ❌ 會重置 |

若要長期保留，建議：

1. **設定 Supabase 持久化（推薦，見上方章節）**
2. 或定期手動備份 `leaderboard_data.json`

## 車種平衡報表（後台）

v30 起會記錄**車種 vs 車種**對戰勝率（僅正常結束的對戰），用來調整能力。

目標克制鏈：**重坦 → 中坦 → 輕坦 → 驅逐 → 重坦**

### 線上查看（伺服器部署後）

瀏覽器開啟：

```
https://你的服務.onrender.com/balance-report
```

若設定了環境變數 `BALANCE_REPORT_KEY`，需加上：

```
https://你的服務.onrender.com/balance-report?key=你的密鑰
```

### 本機查看

```bash
cd server
npm run balance-report
```

報表含：4×4 對戰矩陣、克制鏈達成度、各模式分項統計。
