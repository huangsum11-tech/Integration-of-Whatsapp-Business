# Baton 完整設定指南（官方 API 版）

**介面一覽**：左邊選單只有六項：
- **今日**：需要你處理的客人、今日時間表（試堂、自動跟進、排程群發）、渠道狀態、數據分析
- **收件匣**：所有渠道的對話，可以按渠道篩選
- **客人**：聯絡簿、試堂名單、標籤及匯入
- **推廣**：群發、留言自動私訊
- **導師**：糧單、通知導師
- **設定**：渠道、AI 及知識庫、自動化、團隊

右下角頭像可以登出。

這份指南帶你由零開始，建立一套 **WhatsApp、Instagram、Facebook Messenger、Threads 的 AI 自動回覆系統**。按次序做，每一步完成後，可以在 Baton「**設定 → 渠道**」頁頂部的「**設定清單**」看到打勾。

**目錄**

- 第一部分：準備及安裝
  1. [整套系統怎樣運作](#1-整套系統怎樣運作)
  2. [準備清單](#2-準備清單)
  3. [選擇在哪裡運行：本機或雲端](#3-選擇在哪裡運行本機或雲端)
  4. [安裝及第一次啟動](#4-安裝及第一次啟動)
- 第二部分：連接渠道
  5. [建立 Meta App（四個渠道共用）](#5-建立-meta-app四個渠道共用)
  6. [WhatsApp 官方 Cloud API](#6-whatsapp-官方-cloud-api)
  7. [Instagram](#7-instagram)
  8. [Facebook Messenger](#8-facebook-messenger)
  9. [Threads](#9-threads)
  10. [Meta App 審查及上線](#10-meta-app-審查及上線)
- 第三部分：AI 設定及上線
  11. [連接 AI、轉換 AI 和模型](#11-連接-ai轉換-ai-和模型)
  12. [提供資料給 AI：範本及存放位置](#12-提供資料給-ai範本及存放位置)
  13. [AI 回覆方式及建議上線次序](#13-ai-回覆方式及建議上線次序)
  14. [轉用人工時，在哪裡回覆客人](#14-轉用人工時在哪裡回覆客人)
- 第四部分：其他功能
  15. [試堂流程](#15-試堂流程預約連結記錄自動跟進)
  16. [不漏客：等待提醒、快速回覆、語音轉文字](#16-不漏客等待提醒快速回覆語音轉文字)
  17. [推廣：群發、客人標籤、留言自動私訊](#17-推廣群發客人標籤留言自動私訊)
  18. [每週報告、Google 評價、通知導師](#18-每週報告google-評價通知導師)
  19. [每月導師糧單（Vibefam）](#19-每月導師糧單vibefam)
- 第五部分：維護
  20. [資料備份及安全](#20-資料備份及安全)
  21. [疑難排解](#21-疑難排解)

---

# 第一部分：準備及安裝

## 1. 整套系統怎樣運作

```
客人 WhatsApp ──┐
客人 Instagram ─┼─ Meta 官方 API ─ webhook ─>  ┌─────────── Baton 伺服器 ───────────┐
客人 Messenger ─┘                              │ 收件匣（data/baton.db）              │
客人 Threads 留言 ── Baton 每 3 分鐘讀取 ────>   │   ① 常見問題關鍵字 → 直接用你的答案    │
                                               │   ② AI（Claude／Gemini／Grok）       │
                                               │      ＋ 知識庫 ＋ 預約連結 → 回覆      │
                                               │   ③ 答不到 → 轉交同事「待人工」       │
                                               └──────────────────────────────────────┘
                                                              │
                                     同事用瀏覽器（電腦或手機）打開 Baton 回覆
```

| 渠道 | 可以做甚麼 | 限制 |
| --- | --- | --- |
| WhatsApp Cloud API | 私訊自動回覆、群發、試堂跟進、糧單 | 客人最後一次傳訊息 24 小時後，要用 Meta 已審批模板；每條模板訊息收費 |
| Instagram | 私訊自動回覆、留言關鍵字自動私訊 | 只可在客人傳訊息後 24 小時內回覆；不能群發 |
| Facebook Messenger | 專頁私訊自動回覆、留言關鍵字自動私訊 | 同上 |
| Threads | 讀取你帖子下的留言，AI／同事**公開**回覆 | Threads 沒有私訊 API；回覆所有人都看到；每條最多 500 字 |

## 2. 準備清單

| 項目 | 用途 | 去哪裡 |
| --- | --- | --- |
| Meta 商業管理帳戶（Business Portfolio） | 管理 WhatsApp、專頁、IG；建立永久權杖 | business.facebook.com |
| Meta 開發者帳戶 | 建立 Meta App | developers.facebook.com |
| 一個 WhatsApp 號碼 | Cloud API 用；一般不能同時在手機 WhatsApp App 使用，建議新號碼 | 任何可以收 SMS／電話的號碼 |
| Facebook 專頁 | Messenger；IG 和 WhatsApp 也建議連結 | |
| Instagram 專業帳戶 | IG 私訊、留言 | IG App → 設定 → 帳戶類型 |
| Threads 帳戶 | Threads 留言 | 用 IG 帳戶登入 Threads |
| AI 金鑰 | Claude（建議）、Gemini 或 Grok | console.anthropic.com 等 |
| 一部長開的電腦或雲端伺服器 + HTTPS 網址 | Meta 要把訊息傳到你的伺服器 | 見第 3 節 |
| 信用卡 | WhatsApp 模板訊息收費、AI 用量、雲端伺服器 | |

## 3. 選擇在哪裡運行：本機或雲端

Meta 只會把訊息傳到**公開的 HTTPS 網址**，所以伺服器要 24 小時開著，而且外面連得到。

| 方式 | 適合 | 做法 |
| --- | --- | --- |
| **A. 本機 + Cloudflare Tunnel** | 先試用、小型工作室、有一部長開的電腦（例如 Mac mini） | 在自己電腦執行 Baton，用 Cloudflare Tunnel 給它一個固定 HTTPS 網址。電腦關機或休眠，AI 就停止回覆 |
| **B. 雲端伺服器（建議正式使用）** | 正式營運 | 租一部 VPS（例如 DigitalOcean、Linode、AWS Lightsail，約 US$6–12／月），用 Docker 執行，配一個網域 |

**A. 本機（Local）**

1. 安裝 [Node.js 22](https://nodejs.org/)（22.5 或以上）。
2. 下載專案，然後執行：
   ```bash
   npm install
   npm run build
   cp .env.example .env
   npm start
   ```
3. 打開 http://localhost:4000 確認可以登入。
4. 安裝 Cloudflare Tunnel（cloudflared），用你自己的網域建立固定網址，例如 `https://baton.你的網域.com` → `http://localhost:4000`。只是短暫測試的話，可以用 `ngrok http 4000`，但免費版網址每次會變，Meta 的 webhook 設定要跟著改。
5. 電腦設定為「不休眠」，並設定開機自動啟動 Baton（例如用 `pm2`）。

**B. 雲端（Docker）**

1. 租 VPS（Ubuntu），安裝 Docker。
2. 把專案放上伺服器，`cp .env.example .env` 並填好。
3. 執行：
   ```bash
   docker compose up -d
   ```
   資料存在 Docker volume `baton-data`。
4. 用 Caddy 或 Nginx 為網域加 HTTPS，反向代理到 `localhost:4000`。Caddy 最簡單，一行設定：`baton.你的網域.com { reverse_proxy localhost:4000 }`。
5. `.env` 加 `NODE_ENV=production`。

> 由本機轉到雲端：把整個 `data/` 資料夾（Docker 是 volume）和 `.env` 複製過去即可，對話、知識庫和設定都會保留。之後要更新 Meta webhook 網址。

## 4. 安裝及第一次啟動

1. 打開 `.env`，先填：
   - `META_VERIFY_TOKEN`：自己定一串密碼，例如 `baton-2026-abc`。
   - AI 金鑰（第 11 節）。
   - `META_APP_SECRET`：第 5 節建立 Meta App 後才填。
2. 啟動後打開網址，建立管理員帳戶（第一位用戶就是管理員）。
3. 「設定 → 團隊」頁加入同事。
4. 改了 `.env` 要重新啟動（`npm start` 或 `docker compose restart`）。

---

# 第二部分：連接渠道

## 5. 建立 Meta App（四個渠道共用）

1. developers.facebook.com →「我的應用程式」→「建立應用程式」。
2. 用途選「**其他**」，類型選「**商業**（Business）」，連結你的商業管理帳戶。
3. App 主控板 →「應用程式設定」→「基本資料」：
   - 複製「**應用程式密鑰**」→ 填入 `.env` 的 `META_APP_SECRET`，重新啟動 Baton。
   - 填好私隱政策網址（App 上線必須）。
4. 之後每個渠道都在這個 App 加入產品（WhatsApp、Instagram、Messenger、Threads）。

**Webhook 設定（WhatsApp、Instagram、Messenger 都一樣）**

| 欄位 | 填甚麼 |
| --- | --- |
| 回呼網址 | `https://你的網址/webhooks/meta` |
| 驗證權杖 | `.env` 裏 `META_VERIFY_TOKEN` 的值 |

按「驗證並儲存」。成功就代表 Meta 連得到你的 Baton。

> Meta 介面經常改名。如果找不到下面提到的按鈕，以 Meta 官方文件為準：WhatsApp Cloud API、Instagram API with Instagram Login、Messenger Platform、Threads API。

## 6. WhatsApp 官方 Cloud API

1. Meta App →「新增產品」→ **WhatsApp** →「設定」，選擇或建立 WhatsApp Business 帳戶（WABA）。
2. **加入電話號碼**：WhatsApp →「API 設定」→「新增電話號碼」，填顯示名稱（例如工作室名稱，要經 Meta 審批），用 SMS 或電話驗證。
3. **付款方式**：商業管理平台 → WhatsApp 帳戶 → 付款設定，加信用卡（模板訊息收費）。
4. **永久權杖**：
   - 商業設定 →「用戶」→「系統用戶」→ 新增（管理員角色）。
   - 「指派資產」：選你的 App 和 WhatsApp 帳戶（完全控制）。
   - 「產生權杖」：選你的 App，權限勾選 `whatsapp_business_messaging`、`whatsapp_business_management`，有效期選「永不過期」。
   - 複製權杖（只顯示一次）。
5. **電話號碼 ID**：WhatsApp →「API 設定」頁面上的「電話號碼 ID」（Phone number ID）。
6. **Webhook**：WhatsApp →「設定」→ Webhook，填回呼網址和驗證權杖，然後在欄位列表**訂閱 `messages`**。
7. **Baton**：「設定 → 渠道」→「連接新號碼或帳戶」→「WhatsApp 官方 Cloud API」，填名稱、電話號碼 ID、永久權杖 →「驗證並連接」。
8. 用另一部手機 WhatsApp 傳訊息給這個號碼。Baton 收件匣出現訊息，設定清單的「WhatsApp 官方 Cloud API」就會打勾。

**模板（Template）**：WhatsApp 管理工具 →「訊息範本」建立：
- 試堂跟進（Utility）：例如「{{1}} 你好！今日試堂感覺點呀？有咩問題隨時問我哋 😊」
- 糧單（Utility）：例如「{{1}} 你好，你 {{2}} 的糧單：上堂 {{3}} 堂，金額 ${{4}}。」
- 推廣（Marketing）：例如「{{1}} 你好！12 月 Reformer 套票 85 折…」

審批後，在 Baton 對應的設定填模板名稱。

## 7. Instagram

1. IG 帳戶轉為**專業帳戶**（商家）。建議連結到你的 Facebook 專頁。
2. Meta App →「新增產品」→ **Instagram** →「**Instagram API with Instagram Login**」（使用 Instagram 登入的 API）。
3. 「產生存取權杖」：加入你的 IG 帳戶並登入授權，複製**長期權杖**。需要權限：`instagram_business_basic`、`instagram_business_manage_messages`、`instagram_business_manage_comments`。
4. **Webhook**：Instagram 產品頁的 Webhooks，填回呼網址和驗證權杖，**訂閱 `messages` 和 `comments`**。如果 Instagram 頁面顯示另一個「Instagram 應用程式密鑰」，填入 `.env` 的 `INSTAGRAM_APP_SECRET`。
5. IG App → 設定 → 私訊 →「已連結的工具」：開啟「允許存取訊息」。
6. **Baton**：「設定 → 渠道」→「Instagram DM」，填名稱和權杖。Baton 會自動讀取帳戶，嘗試自動訂閱 webhook，之後每星期自動更新權杖（長期權杖 60 日過期）。
7. 用另一個 IG 帳戶傳私訊測試。

## 8. Facebook Messenger

1. Meta App →「新增產品」→ **Messenger**（Messenger API 設定）。
2. **專頁存取權杖**（建議用系統用戶，永不過期）：
   - 商業設定 → 系統用戶 →「指派資產」：加入你的 Facebook 專頁（完全控制）。
   - 「產生權杖」：權限勾選 `pages_messaging`、`pages_manage_metadata`、`pages_read_engagement`、`pages_manage_engagement`、`pages_show_list`。
   - 這是「用戶權杖」，要換成專頁權杖：在 Graph API Explorer 用這個權杖查詢 `me/accounts`，複製你專頁的 `access_token`，系統用戶產生的專頁權杖一樣不會過期。或者在 Messenger 設定頁直接為專頁「產生權杖」。
3. **專頁 ID**：Facebook 專頁 →「關於」→「專頁透明度」，或 Messenger 設定頁的專頁列表。
4. **Webhook**：Messenger 設定 → Webhooks，填回呼網址和驗證權杖，訂閱 `messages`、`message_echoes`、`feed`（`feed` 用於留言自動私訊）。
5. **Baton**：「設定 → 渠道」→「Facebook Messenger」，填名稱、專頁 ID、專頁權杖。Baton 會自動把專頁訂閱到你的 App；如果失敗會提示你在 Messenger 設定頁手動訂閱。
6. 用另一個 Facebook 帳戶傳私訊給專頁測試。

## 9. Threads

Threads **沒有私訊 API**，所以 Baton 處理的是你帖子下的**留言**：每 3 分鐘讀取最近 7 日帖子的留言，每位留言的人成為收件匣一個對話；回覆會**公開**貼在他的留言下面。

1. Meta App 加入「**Threads API**」用途（Access the Threads API）。
2. 權限：`threads_basic`、`threads_content_publish`、`threads_read_replies`、`threads_manage_replies`。
3. 在 Threads API 設定加入你的 Threads 帳戶為測試者，並在 Threads App 接受邀請（設定 → 帳戶 → 網站權限）。
4. 產生**長期權杖**（long-lived token），可以用 Meta 的 User Token Generator，或者 OAuth 換取。
5. **Baton**：「設定 → 渠道」→「Threads 留言」，填名稱和權杖。Baton 每星期自動更新權杖。
6. **建議這個帳戶用「AI 建議」模式**：公開回覆所有人都看到，同事確認後才發較安全。AI 在 Threads 只會簡短回覆，並邀請客人轉用 WhatsApp／IG 私訊查詢預約或價錢。

## 10. Meta App 審查及上線

開發模式（Development）下，**只有 App 的管理員、開發者和測試者**傳的訊息會送到 Baton。要接收所有客人的訊息：

1. **商業驗證**：商業設定 →「安全中心」→ 商業驗證（需要商業登記證等文件）。
2. **App 審查**：App 主控板 →「App 審查」→ 為以下權限申請「進階存取」（Advanced Access）：
   - Instagram：`instagram_business_basic`、`instagram_business_manage_messages`、`instagram_business_manage_comments`
   - Messenger：`pages_messaging`、`pages_manage_metadata`、`pages_read_engagement`、`pages_manage_engagement`
   - Threads：`threads_basic`、`threads_content_publish`、`threads_read_replies`、`threads_manage_replies`
   - WhatsApp 用自己商業帳戶的號碼，一般不需要為訊息權限另外申請審查。
3. 審查要錄影示範用途。可以錄 Baton 收到訊息、AI 回覆、同事接手的過程，說明是「客戶服務回覆」。
4. 通過後，把 App 切換為「**上線**」（Live）模式。

> 審查一般要幾日至幾星期。期間可以先用 WhatsApp Cloud API，並把同事加為 IG／FB／Threads 的測試者來測試。

---

# 第三部分：AI 設定及上線

## 11. 連接 AI、轉換 AI 和模型

**取得 API 金鑰，填入 `.env`**

| AI | 申請金鑰 | `.env` 變數 |
| --- | --- | --- |
| Claude（Anthropic，建議） | console.anthropic.com → API Keys | `ANTHROPIC_API_KEY` |
| Gemini（Google） | aistudio.google.com → Get API key | `GEMINI_API_KEY`（填了也會啟用語音轉文字） |
| Grok（xAI） | console.x.ai → API Keys | `XAI_API_KEY` |

填完重新啟動。金鑰只放在 `.env`，不會存進資料庫，也不會傳到網頁。

**轉換 AI 或模型**：「**設定 → AI 及知識庫**」→「**AI 模型**」，選 Claude、Gemini 或 Grok，在「模型」欄填名稱，按儲存即時生效。

| AI | 模型例子 | 特點 |
| --- | --- | --- |
| Claude | `claude-opus-5-5`（預設） | 質素最好 |
| Claude | `claude-sonnet-5-5` | 質素和價錢平衡，適合大部分客服 |
| Claude | `claude-haiku-5-5` | 最便宜、最快 |
| Gemini | `gemini-3.6-flash`（預設） | |
| Grok | `grok-4.6`（預設） | |

> 模型名稱會隨各公司推出新版本改變。AI 回覆失敗並顯示模型錯誤時，到官方文件查最新名稱再填。用「**試問 AI**」可以即時測試。

## 12. 提供資料給 AI：範本及存放位置

### 5.1 AI 會讀甚麼

AI 每次回覆客人，會讀三樣東西：

1. **公司資料**（「設定 → AI 及知識庫」→「公司資料」）：公司名稱、簡介、地址、營業時間。
2. **知識庫**（「設定 → AI 及知識庫」→「知識庫」）：分四類：

| 分類 | 放甚麼 | AI 怎樣用 |
| --- | --- | --- |
| **常見問題** | 標準問題及答案，加關鍵字 | 客人訊息有關鍵字，**直接原文回覆，不經 AI**（最快、最準、免費） |
| **公司政策** | 取消、改期、退款、遲到、套票、付款 | AI 只按這裏的內容回答，不會自己作 |
| **課程資料** | 課程種類、程度、時間表、價錢、導師 | 同上 |
| **其他** | 地址、交通、要帶甚麼、注意事項 | 同上 |

3. **同事過往的回覆**：AI 會模仿你們團隊的語氣。

一般健身／普拉提知識（例如「腰痛可以做普拉提嗎？」「Reformer 和墊上有甚麼分別？」）AI 本身已懂，不用寫進知識庫。但有傷患、懷孕等情況，AI 只會給一般提醒，並建議問醫生及通知導師。

### 5.2 範本：用 Excel／Google Sheets 填寫

範本檔案：[`docs/knowledge-template.csv`](knowledge-template.csv)（也可以在「設定 → AI 及知識庫」→「知識庫」按「**下載範本 CSV**」）

格式是四欄：

| 分類 | 標題 | 內容 | 關鍵字 |
| --- | --- | --- | --- |
| 常見問題 | 有冇試堂？ | 有呀！首次體驗堂 $[價錢]，WhatsApp 話我知想上邊日… | 試堂, 體驗, trial, 第一次 |
| 課程資料 | 價錢及套票 | 單堂 $[價錢]；10 堂套票 $[價錢]（有效期 [月數] 個月）… | |
| 公司政策 | 取消及改期 | 上堂前 [24] 小時或之前可免費改期… | |
| 其他 | 第一次上堂要準備 | 請穿貼身舒適運動服，必須著防滑襪… | |

填寫規則：

- **分類**只可以填：`常見問題`、`公司政策`、`課程資料`、`其他`。
- **關鍵字**只對「常見問題」有用，用逗號分隔。客人訊息包含任何一個關鍵字，就直接發「內容」給客人。關鍵字要具體，避免太短太普遍（例如不要只寫「堂」）。
- 把所有 **`[方括號]`** 改成你們的真實資料。仍有方括號的項目，AI 會當作「未知」並轉交同事，不會把方括號發給客人。
- 一格內可以換行（Excel 按 Alt+Enter）。
- 寫得越具體越好：價錢、日子、條件都寫清楚。AI 只會說知識庫有的事實。

步驟：

1. 下載範本，用 Excel 或 Google Sheets 打開。
2. 修改、加行、刪行。儲存為 **CSV（UTF-8）**。Google Sheets：檔案 → 下載 → 逗號分隔值。
3. 「設定 → AI 及知識庫」→「知識庫」→「**匯入 CSV**」選檔案。
   - 「分類＋標題」相同的項目會**更新**，新的會**新增**，所以同一個檔案可以改完再匯入。
   - 匯入時選「取代」，檔案以外的舊資料會被刪除。
4. 用「**試問 AI**」測試幾條常見問題。

也可以不用 Excel，直接在網頁按「新增」或點擊項目編輯。

### 5.3 資料存放在哪裡

| 資料 | 存放位置 |
| --- | --- |
| 知識庫、公司資料、AI 設定 | 伺服器的 `data/baton.db`（SQLite 資料庫）`knowledge` 和 `settings` 表 |
| 所有客人對話、聯絡人、交接紀錄 | 同一個 `data/baton.db` |
| 相片、語音、文件 | `data/media/` |
| QR 連接的 WhatsApp 登入資料 | `data/auth/` |
| API 金鑰（AI、Meta） | 伺服器的 `.env` 檔案 |
| 官方 API 的存取權杖 | `data/baton.db` `numbers` 表（不會傳到網頁） |

`data/` 預設在 `server/data/`，可以用 `.env` 的 `BATON_DATA_DIR` 改位置。

**建議**：知識庫以 Excel／Google Sheets 檔案為「正本」，改完就匯入；或者隨時在網頁按「**匯出 CSV**」備份。

## 13. AI 回覆方式及建議上線次序

在「設定 → 渠道」頁，每個號碼／IG 帳戶可以分開設定：

| 模式 | 客人傳訊息後 | 建議用法 |
| --- | --- | --- |
| **關閉** | 不會自動做任何事；同事可以隨時按「AI 草擬」 | 人手處理 |
| **AI 建議** | AI 預先寫好回覆，在收件匣顯示「AI 建議回覆」；同事按「使用並修改」再發送 | **剛開始用、測試知識庫** |
| **全自動** | AI 直接回覆客人；答不到就轉交同事 | 知識庫完整後 |

全自動時會轉交同事的情況：

- 知識庫沒有答案
- 客人要預約、改期、取消、付款、退款等需要人手處理的事
- 客人投訴、不滿、要求找真人
- 客人傳相片、語音、文件（AI 暫時只讀文字）
- 同一對話一小時內自動回覆超過 15 次（防止與其他機械人互相回覆）

轉交時，可以自動發一句「收到！我已經通知同事…」給客人（在「設定 → AI 及知識庫」→「公司資料」設定；留空就不發）。

AI 只回答公司及健身相關問題；問其他話題（例如功課、新聞）會禮貌婉拒。Meta 不容許在 WhatsApp Business API 上提供通用 AI 聊天機械人。

**建議上線次序**

1. **第 1 星期**：所有帳戶用「**AI 建議**」。同事每次看 AI 寫的回覆，覺得不準就修改，並把缺少的資料加入知識庫。
2. **第 2 星期**：WhatsApp、Instagram、Messenger 改為「**全自動**」，Threads 保持「AI 建議」。開啟「客人等待提醒」。
3. 之後每星期看每週報告的「轉交同事」次數。次數多的話，多數是知識庫缺資料，補上即可。

## 14. 轉用人工時，在哪裡回覆客人

**全部在 Baton 網頁的「收件匣」回覆**，電腦和手機瀏覽器都可以用。不用打開 WhatsApp 或 IG App。

1. AI 轉交時，對話會出現在收件匣的「**待人工**」分頁，並顯示紅色「待人工」標籤。對話中會顯示 AI 轉交的原因，例如「AI 轉交同事處理：客人想改期」。
2. 點開對話，頂部有紅色提示列。在下面「**回覆客戶**」輸入訊息，按 Enter 發送。
   - 訊息會經原本的渠道（WhatsApp 或 Instagram）發給客人，客人看到的是同一個對話。
   - 可以按「AI 草擬」，讓 AI 先寫草稿再修改。
   - 「內部備註」只有同事看到，客人看不到。
3. 同事一回覆：
   - 對話離開「待人工」，留在該同事的「我的」分頁（回覆未分配的對話會自動分配給自己）。
   - 這個對話的 AI 自動暫停，避免 AI 和同事同時回覆。
4. 處理完：
   - 按右上「**完成**」：對話完結，客人下次再問時 AI 會重新接手。
   - 或按「**恢復 AI**」：讓 AI 繼續在這個對話自動回覆。
   - 需要另一位同事跟進：按「分配」，選同事並寫交接備註。
5. 同事也可以隨時在全自動的對話按「**AI 自動回覆中**」暫停 AI，親自回覆。

收件匣會即時更新：任何同事回覆、AI 轉交，所有人的畫面都會同步。

---

# 第四部分：其他功能

## 15. 試堂流程：預約連結、記錄、自動跟進

1. **預約連結**：「設定 → AI 及知識庫」→「公司資料」填寫：
   - **首次試堂預約連結**：AI 只會給第一次上堂的新客人。
   - **一般預約連結**：已上過堂的學生想約堂，AI 會給這個連結讓他們自己預約，不用轉交同事。
2. **記錄試堂**：客人預約後告訴 AI 日期和時間（例如「我約咗聽日7點 Reformer」），AI 會自動記錄試堂。同事也可以在收件匣對話右邊「**試堂**」手動加入、取消，或按暫停鍵表示不需要跟進。
3. **自動跟進**：「設定 → 自動化」→「試堂跟進」設定試堂開始後幾耐發送（預設 2 小時，即 1 小時課堂完結後約 1 小時）和跟進訊息。客人回覆後，AI 會按知識庫介紹套票；想報名的會轉交同事。
4. 「設定 → 自動化」頁的「**試堂名單**」列出即將上堂和最近兩星期的試堂及跟進狀態。

> 用官方 Cloud API 號碼時，如果客人上次傳訊息已超過 24 小時，跟進訊息要用 Meta 已審批的模板（變數 `{{1}}` = 客人名稱），在「試堂跟進」填寫模板名稱。

## 16. 不漏客：等待提醒、快速回覆、語音轉文字

**客人等待提醒**（「設定 → 自動化」）
- 客人等同事回覆超過設定時間（例如 15 分鐘），Baton 用 WhatsApp 提醒：已分配的對話提醒負責同事，未分配的提醒負責人。
- 要先填：「通知用號碼」（用哪個 WhatsApp 號碼發提醒）、「負責人 WhatsApp」、各同事的 WhatsApp。
- 只在設定的時段提醒（例如 09:00–22:00）。全自動模式下 AI 仍在處理的對話不會提醒。

**快速回覆**（「設定 → 自動化」→「快速回覆」）
- 例如新增捷徑「價錢」。同事回覆時輸入 `/價錢`，按 Enter 就會填入內容，`{名稱}` 自動換成客人名稱。

**語音轉文字**
- 在 `.env` 填 `GEMINI_API_KEY` 就會自動啟用。客人的語音訊息會轉成文字，顯示在語音下面，AI 也會根據內容回覆。不論你用哪個 AI 回覆客人，轉文字都用 Gemini。

## 17. 推廣：群發、客人標籤、留言自動私訊

左邊選單「**推廣**」（只有管理員看到）。

**客人標籤**
- 在收件匣對話右邊「標籤」為客人加標籤，例如「會員」「產前」「早班」。
- 「推廣」→「客人名單」可以匯入 CSV，例如 Vibefam 會員名單：要有「電話」欄，可以有「姓名」「標籤」欄。

**WhatsApp 群發**
1. 「推廣」→「WhatsApp 群發」→「新增群發」。
2. 選擇發送號碼和對象：
   - 分組：全部客人、上過試堂但未成交、30 日內有對話、超過 60 日沒有對話、30 日內新客人
   - 可以再加標籤篩選
   - 會即時顯示人數；用 Cloud API 號碼時會顯示預計費用（每條費用可以自己改，以 Meta 價目表為準）
3. 寫訊息，`{名稱}` 會換成客人名稱。
4. 填「**AI 需要知道的優惠內容**」和使用期限：客人回覆查詢時，AI 會根據這些內容解答。
5. 先按「**先發給自己測試**」，再按「即時發送」或「排程發送」。
6. 發送後可以看到已發送、已送達、已讀（只有 Cloud API 有）、有回覆、失敗的人數，以及每位客人的狀態。失敗的可以重發。

> **重要**：建議用官方 Cloud API 號碼，並在 Meta 建立「**Marketing**」類別的模板；Cloud API 主動發訊息一定要用已審批模板。**QR 連接的號碼群發有封號風險**：Baton 會每條相隔約 10 秒慢慢發，但仍建議只發給少量熟客，不要用主要生意號碼大量發送。導師和同事的號碼不會收到群發。

**IG／Facebook 留言自動私訊**
1. 「推廣」→「IG／FB 留言自動私訊」→「新增規則」：填關鍵字（例如 `PILATES, 試堂`）、自動私訊內容（例如試堂優惠及預約連結）、公開回覆（例如「已私訊你 😊」）。
2. 在 IG 或 Facebook 專頁出帖子，寫明「留言 PILATES 取得試堂優惠」。
3. 客人留言包含關鍵字，就會自動收到私訊；客人回覆私訊後會進入收件匣，由 AI 或同事跟進。
4. 需要在 Meta App 的 Instagram Webhook **另外訂閱 `comments`**，並有 `instagram_business_manage_comments` 權限。Meta 規定每個留言只可以私訊一次，而且要在留言後 7 日內。
5. Facebook 專頁留言同樣適用：Messenger webhook 要訂閱 `feed`，並有 `pages_manage_engagement` 權限。

## 18. 每週報告、Google 評價、通知導師

**每週報告**（「設定 → 自動化」→「每週報告」）
- 每星期指定時間用 WhatsApp 發給你（可以多個號碼）。
- 內容：新查詢數、AI 自動回覆佔幾成、轉交同事次數、同事回覆速度、試堂（預約、已上堂、已跟進）、成交、群發及 IG 私訊數、仍在等待的客人。
- 可以先按「預覽」，或「立即發送一次」。

**Google 評價邀請**
- 在「設定 → 自動化」→「Google 評價邀請」填 Google 評價連結（Google 商家檔案 →「取得更多評論」→ 分享連結）和訊息。
- 在收件匣對話右邊按「**邀請 Google 評價**」就會發給該客人。

**通知導師**（「導師」頁 →「通知導師」）
- 選擇導師（或全部），寫訊息（`{導師}` 會換成導師名稱），例如代課、請假、時間表更改，一次發出。

## 19. 每月導師糧單（Vibefam）

左邊選單「**導師**」（只有管理員看到）。

Vibefam 暫時沒有公開的 API，Baton 不能自動登入 Vibefam 讀資料，所以流程是：**月底 Baton 用 WhatsApp 提醒你 → 你從 Vibefam 匯出報表 → 上載到 Baton → 預覽 → 一按發送（或排程）**。如果日後 Vibefam 提供 API，可以改成全自動讀取。

### 第一次設定

1. 「導師」→「**發送設定**」：
   - 選擇用哪個 WhatsApp 號碼發送。
   - 修改訊息範本。可以用 `{導師}`、`{月份}`、`{堂數}`、`{金額}`、`{明細}`，以及報表上任何欄名，例如 `{Class}`。
   - 月底提醒：填你自己的 WhatsApp 號碼和時間。每月最後一日，Baton 會發 WhatsApp 提醒你匯出報表。
2. 「**導師名單**」：填每位導師的 WhatsApp 號碼。名稱要和 Vibefam 報表上的導師名稱一樣。上載報表時，新出現的名稱會自動加入名單，只要補上電話就可以。

### 每月步驟

1. 在 Vibefam 匯出該月的導師糧單／Payroll 報表，存成 **CSV**。Excel 檔可以「另存新檔 → CSV UTF-8」。
2. 「導師」→「新一期糧單」：選月份、選檔案。
3. 確認欄位：哪一欄是**導師名稱**、哪一欄是**金額**。Baton 會自動估計，可以自己改。
   - 報表每行是一堂課：堂數按行數計算，金額自動加總，`{明細}` 列出每一堂。
   - 報表每行是一位導師：選「堂數欄」，Baton 會直接用該欄的數字。
4. 按「**產生預覽**」，逐一檢查每位導師的訊息。可以「修改訊息」或「略過」某位導師。
5. 按「**即時發送**」，或選日期時間後按「**排程發送**」。訊息會逐一發出，每份之間相隔幾秒。
6. 發送失敗的會標示原因（例如未有電話）。修正後再按發送，只會補發未成功的。

### 注意

- **用 QR Code 連接的號碼**：可以直接發送。
- **用官方 Cloud API 號碼**：WhatsApp 規定主動發訊息必須用 Meta 已審批的**模板**。在 Meta「WhatsApp 管理工具 → 訊息範本」建立一個類別為「Utility」的模板，內文用 `{{1}}`、`{{2}}`… 作變數。例如：「{{1}} 你好，你 {{2}} 的糧單：上堂 {{3}} 堂，金額 ${{4}}。」然後在 Baton 發送設定填寫模板名稱、語言代碼（例如 `zh_HK`），以及變數對應（例如 `導師,月份,堂數,金額`）。模板內容由 Meta 審批，所以 Cloud API 發出的是模板內容，不是 Baton 的訊息範本。
- 月底提醒是普通訊息。用官方 Cloud API 號碼時，只有你在之前 24 小時內傳過訊息給該號碼才能收到；建議用 QR 號碼發提醒。
- 糧單對話只有**管理員**在收件匣和搜尋看到，一般同事看不到。
- 時間以香港時間計算（可以用 `.env` 的 `BATON_TZ` 改時區）。伺服器要一直開著，排程和提醒才會運作。

---

# 第五部分：維護

## 20. 資料備份及安全

- **定期備份 `data/` 資料夾**：所有對話、知識庫、設定都在裏面。
- **不要把 `.env` 上傳到 GitHub**（已列入 `.gitignore`）。
- 正式使用一定要設定 `META_APP_SECRET`：Baton 用它確認 webhook 真的是 Meta 發出的。
- 正式部署用 HTTPS，並在 `.env` 設 `NODE_ENV=production`。
- 同事離職：「設定 → 團隊」頁按「離職交接」，登入即時停用，客人和對話轉交其他同事。
- Instagram 和 Threads 權杖由 Baton 每星期自動更新。如果在「設定 → 渠道」頁中斷連接後重新連接，要重新輸入權杖。

## 21. 疑難排解

| 問題 | 原因及解決 |
| --- | --- |
| Meta「驗證並儲存」webhook 失敗 | 網址不是 HTTPS、Baton 沒有啟動、或驗證權杖與 `.env` 的 `META_VERIFY_TOKEN` 不同 |
| 設定清單顯示「已連接，但未收過 Meta 的 webhook」 | 沒有訂閱 `messages` 欄位；或 App 仍在開發模式，而傳訊息的人不是測試者 |
| Baton 收到 webhook 但沒有反應 | `.env` 的 `META_APP_SECRET` 不對（簽名驗證失敗）；Instagram 可能要填 `INSTAGRAM_APP_SECRET` |
| 發送失敗：「已超過 24 小時客服窗口」 | 客人超過 24 小時沒有傳訊息。WhatsApp 要用模板；IG／FB 等客人再傳訊息 |
| AI 沒有回覆 | 該帳戶的回覆方式是「關閉」；或對話已被同事接手（AI 已暫停），按「恢復 AI」或「完成」；或 AI 金鑰未設定（設定清單） |
| AI 回覆失敗：模型錯誤 | 「設定 → AI 及知識庫」→「AI 模型」換成最新的模型名稱 |
| IG／FB 留言沒有自動私訊 | 沒有訂閱 `comments`（IG）或 `feed`（FB）；缺少留言權限；同一個留言只可以私訊一次，而且要在 7 日內 |
| Threads 沒有讀到留言 | 權杖缺少 `threads_read_replies`；帖子超過 7 日；App 未有進階存取 |
| 群發失敗 | Cloud API 號碼沒有填模板名稱，或模板未審批；付款方式未設定 |
| 提醒、報告收不到 | 「設定 → 自動化」→「通知用號碼」未選；用 Cloud API 號碼發提醒，要收的人 24 小時內傳過訊息給該號碼 |
