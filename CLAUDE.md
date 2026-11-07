# Baton 接棒：給 Claude 的專案說明

普拉提／健身工作室的客服系統：WhatsApp、Instagram、Facebook Messenger、Threads 集中在一個收件匣，AI 根據知識庫自動回覆，答不到就轉交同事。另有試堂跟進、群發、留言自動私訊、每週報告、導師糧單（Vibefam 匯出報表）。

使用者是香港的工作室老闆。**介面文字和回覆一律用繁體中文（香港用語）。**

## 常用指令

```bash
npm install
npm run build                    # 建立前端（web/dist）
npm run typecheck                # server + web 型別檢查（改完一定要跑）
npm start                        # http://localhost:4000
npm run dev                      # 前端熱重載 http://localhost:5173
npm run seed --workspace server  # 示範資料（只在空資料庫）：karen@baton.demo / baton-demo
```

測試時用另一個資料夾，不要動真實資料：`BATON_DATA_DIR=/tmp/baton-test npm run seed --workspace server`

## 結構

- `server/src/`：Node 22 + TypeScript（tsx 直接執行）、Express 5、Socket.IO、`node:sqlite`
  - `routes.ts` 所有 API；`db.ts` 資料表及遷移（用 `ALTER TABLE` 加欄位，不要刪資料）
  - `meta.ts` WhatsApp Cloud API／Instagram／Messenger 及 webhook `/webhooks/meta`；`threads.ts` Threads 留言輪詢
  - `ai.ts` 提示詞及知識庫；`llm.ts` Claude／Gemini／Grok；`autoreply.ts` 自動回覆及轉交
  - `brands.ts` 兩品牌目錄（分店、試堂價、套票、收款資料）；`flows.ts` 試堂引導及購買流程（決定性，不經 AI）；`payments.ts` FPS／PayMe 付款狀態機；`backoffice.ts` 預約後台輔助（Playwright，階段二）；`identity.ts` WhatsApp LID／電話對齊；`routes-studio.ts` 以上功能的 API
  - `automation.ts` 試堂跟進、試堂提醒、等待提醒；`campaigns.ts` 群發；`comments.ts` 留言自動私訊；`payroll.ts` 糧單；`report.ts` 每週報告；`home.ts` 今日頁
- `web/src/`：React 19 + Vite，純 CSS（`styles.css` 頂部是設計 tokens）
  - 七個地方：`Today`、`Inbox`、`Customers`、`Payments`（付款核實）、`Marketing`、`Payroll`（導師）、`Settings`（渠道、品牌及收款、預約後台輔助、AI、自動化、團隊）
- `server/test/`：`npm test`（node:test，臨時資料庫及示範號碼）
- `docs/SETUP.md`：給使用者的完整設定指南；`docs/BRAND.md`：品牌及顏色規則

## 規則

- 顏色：紫色（iris）只代表 AI；珊瑚紅只用於需要行動的地方；黃色只用於內部備註。見 `docs/BRAND.md`。
- 秘密只放 `.env`（不入 git）。存取權杖不可以傳到前端。
- 所有對話及客人資料在 `data/`（`BATON_DATA_DIR`），不要提交、不要刪除。
- 發訊息給真實客人／導師前，一定先問使用者。用示範號碼（demo）測試。
- 兩品牌（Fitness／Pilates）的價目、連結、收款資料絕不混用；價錢只引價目表，折扣交同事報價。
- 未經同事按「核實」，系統不得向客人發「已生效」。退款、投訴、扣堂爭議、健康、個人餘額查詢一律轉真人。
- 預約後台輔助只做到階段二（停在確認畫面），不要加自動按確認的程式碼；Vibefam 帳戶只放 `.env`。
- 付款截圖及客人資料只留在本機 `data/`，不要上載到 Drive／Notion 等共享空間。
- 改完：`npm test`、`npm run typecheck`、`npm run build`，用 Playwright 截圖檢查畫面（電腦及 390px 手機闊度）。

## 目前狀態及下一步

已完成功能，但**未在真實帳戶測試**（之前在雲端環境，連不到 Meta 及 AI）：

1. 填 `.env`（AI 金鑰、`META_VERIFY_TOKEN`、`META_APP_SECRET`），啟動後看「設定 → 渠道」的設定清單。
2. 用 Cloudflare Tunnel 給本機一個 HTTPS 網址，在 Meta App 設定 webhook（見 `docs/SETUP.md` 第 3、5–9 節）。
3. 逐個渠道實測：WhatsApp Cloud API → Instagram → Messenger → Threads。Threads 的 API 欄位（`/conversation`、`reply_to_id`）是按文件寫的，要實測確認。
4. **Vibefam**：沒有公開 API。糧單用匯出的 CSV；用使用者提供的真實報表檢查欄位自動偵測（`payroll.ts` 的 `GUESS`）。如果使用者授權用 Chrome 查看 Vibefam，可以了解報表格式、試堂預約連結、會員名單匯出方式，但不要在 Vibefam 做任何更改。
5. 知識庫：用 `docs/knowledge-template.csv` 填入工作室真實資料（價錢、時間表、政策）。
6. TASK-3 待 Sum 提供：兩品牌預約深連結、FPS／PayMe 收款資料及 QR、試堂步驟截圖、截圖保留期限，全部在「設定 → 品牌及收款」填寫；預約後台的「畫面設定」要用真實後台調整（`docs/SETUP.md` 第 15A 節）。
