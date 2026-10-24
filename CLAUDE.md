# Stock406

00406A（主動中信台灣收益）的盤勢儀表板與手機推播系統。這是公開 repo：**不要把使用者的持股、均價、預算、ntfy 主題寫進任何檔案或 commit**。這些資料只放在 GitHub Secrets，以及使用者電腦上的 `journal/`（已列入 .gitignore）。

## 架構

| 檔案 | 用途 | 執行位置 |
|---|---|---|
| `index.html` | 儀表板：K 線、MACD/KD/RSI、布林、關鍵價位、部位試算、ADR 溢價、EWT 跳空推估 | GitHub Pages（讀 `data/*.json`）或本機 `node server.js`（即時代理 Yahoo） |
| `server.js` | 本機伺服器，port 4060，`/api/chart` 代理 Yahoo chart API | 本機 |
| `scripts/fetch-data.mjs` | 抓 Yahoo 日線存成 `data/*.json`（`^` 換成 `_`） | Actions |
| `scripts/summary.mjs` | 把 data 濃縮成約 3 KB 文字摘要，給雲端 Claude 讀（不要讓 Claude 直接讀原始 JSON，約 325 KB） | 雲端排程 |
| `scripts/alert.mjs` | ntfy 推播：`MODE=premarket` 盤前推估（週一到週六；台股休市但昨晚美股有開時改推「美股收盤總結」）、`MODE=intraday` 盤中規則判斷、`MODE=evening` 晚間覆盤（美國夏令 22:00、冬令 22:45，依 `EVENING_SLOT` 自動擇一）（台股收盤、三大法人 BFI82U/T86、分批有沒有跌到、美股開盤後走勢與明天推估） | Actions |
| `.github/workflows/pages.yml` | 平日每 15 分鐘抓資料 → 部署 Pages，並把資料強制推到單一 commit 的 `data` 分支 | Actions |
| `.github/workflows/alerts.yml` | 08:30 盤前、09:00–13:55 每 5 分鐘盤中提醒、22:00 或 22:45 晚間覆盤；修改 `.github/alert-test.txt` 並 push 會觸發測試模式（第一行 `modes: premarket` 可指定只測哪幾種） | Actions |

雲端 Claude 排程（claude.ai routines）連不到 Yahoo 和 github.io，只能讀 repo：`git fetch origin data && git archive origin/data | tar -x -C data && node scripts/summary.mjs`。

## 推播規則（alert.mjs）

- Secrets：`NTFY_TOPIC`、`ALERT_CONFIG`（JSON，覆蓋 `DEFAULTS`）。
- 分批 `ladder`：固定價格或動態值 `prev` / `bbL` / `lo20` / `lo60` / `pct-3`，用「當日以前」的日 K 計算，相差 <0.5% 合併。
- 使用者的分批規則：每批要 **B 且 C**。B = 當日低點 `confirmMin`（15）分鐘未破，或站上 VWAP；C = 5 項環境（折溢價 ≤ 0（證交所 MIS `all_etf.txt`）、台幣 15 分未急貶、美期 15/60 分未急跌、台積電與大盤當日低 15 分未破）至少 `cMin`（3）項。
- **推播只講風險與買點，不要把數據全部列出來**（使用者明確要求）。盤前、晚間都是精簡卡片：標題放價格與風險等級；內文是「風險：🟢低/🟡中/🔴偏高 + 最多 2 個原因」「買點：🎯/⚪ 各批與還差幾 %」「⏸/✅ 結論：依使用者規則現在先不買（原因…）或第 N 批可以照計畫買」。風險由 `risk()` 固定規則計分（00406A 跌破布林下緣/月平均、大盤跌破季平均、美股科技股多數在月平均之下、科技股大跌、VIX、油價大漲、台幣急貶、美債利率大漲、溢價），`watch()` 在背景抓美股與國際指標只用來計分。盤中推：符合規則、到價未符合、跌破布林下緣、15 分急跌、每小時摘要。使用者說「不用通知」是指震動方式，不是不要推；不要自行拿掉推播。同時到價多批合併成一則。策略整理在 `notes/strategies-reference.md`，分析其他股票時可對照。
- 推播符號：✅ 符合、❌ 不符合、❔ 讀取失敗、🎯 會觸及分批價位、⚪ 不會；規則細項用「　└」縮排（手機上 ✔✘ 難辨識，不要改回）。
- 推播用語要讓不懂股市的人也看得懂：不用「折溢價、乖離、量比、VWAP、MA5、布林下軌、昨收」這類術語，改寫成「市價比淨值貴/便宜」「離 5 日平均價」「今天平均成交價」「布林下緣（近期正常波動的底部）」「上次收盤價」等；條件寫成「沒有急貶」這種白話句子。
- 推播分級：所有推播都用 priority 3（短震一下）。priority 4 以上震動太長，使用者不要。
- 盤中每個訊號每天只推一次（Actions cache 保存 `alert-state.json`）；測試模式不保存。

## Supabase（第一階段）

- `supabase/schema.sql` 建表（trades、budgets、ladder、rules、positions 檢視），全部開 RLS，匿名讀不到。
- `scripts/supabase.mjs` 共用連線；`scripts/db.mjs` 在本機記成交、改分批、標記已買（金鑰在 `journal/.env`，不進 git）。
- `alert.mjs` 有 `SUPABASE_URL` / `SUPABASE_SECRET_KEY` 時，從 `ladder`（status=active）與 `rules` 讀分批和規則，讀不到才用 `ALERT_CONFIG`。批次編號用資料庫的 seq，買完一批不會讓後面的編號往前移。
- 第二階段：`supabase/002_signals.sql` 建 `signals`（推播紀錄，**公開可讀**，不放張數金額）。`alert.mjs` 每次正式推播寫一筆（測試模式不寫），晚間覆盤回補 `ret_1d` / `ret_5d`。
- 儀表板：用 publishable key（可公開）讀 `signals` 顯示推播紀錄；email 登入後從 `positions` / `ladder` / `trades` 讀部位，張數改了會寫回 `ladder`。未登入時部位仍存在瀏覽器 localStorage。登入的帳號在 Supabase Auth 手動建立，已關閉自行註冊。
- 使用者回報成交：`node scripts/db.mjs trade buy 日期 價格 張數`，再 `fill 批次`；同時更新 journal。

## 修改後如何驗證

- 本機：`FORCE=1 STATE_FILE=/tmp/a.json node scripts/alert.mjs`（不設 `NTFY_TOPIC` 只印不推）、`MODE=premarket FORCE=1 node scripts/alert.mjs`。
- 雲端：修改 `.github/alert-test.txt` 後 push，會推送標題帶「[測試]」的通知。
- **盤中修改 `alert.mjs` 要特別小心**：push 後下一次排程就會用新程式碼，語法錯誤會讓當天的提醒全部停擺。push 前一定要先在本機用 FORCE 跑過。

## 原則

- 只提供數據、指標與「是否符合使用者自訂規則」，不給個人化的買賣建議。
- 價格一律從即時來源抓，標註時間，不用新聞裡的舊數字。
