<p align="center">
  <img alt="μ" src="../../desktop/resources/app.png" width="112">
</p>

<h1 align="center">mu</h1>

<p align="center"><b>一個先思考、再行動的程式設計代理。</b><br>
例行的判斷交給一個小而快的判定器，大模型則把注意力留給真正的工作。</p>

<p align="center">
  <a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>繁體中文</b> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

> **狀態：早期開發中。** mu 已經能讓作者們日常使用，但這裡的一切都還沒有正式發布。名稱、設定和檔案格式都還可能變動。標示為*實驗性*的功能，尚未在真實帳號上試過，也還沒在每一類真實機器上試過；文件會明確說明哪些已經驗證、哪些還沒有。

---

## 為什麼是 mu

程式設計代理的模型呼叫與上下文視窗，有高得驚人的比例都花在小問題上。這則訊息是新任務還是更正？這條指令需要使用者許可嗎？一份 4,000 行的測試日誌裡，哪一段才重要？代理是不是在原地打轉？這項工作該交給哪個子代理、用哪個模型？瀏覽器下一步該點哪裡？

mu 把這些問題交給**判定器**：一個快速的模型，能在不到一秒內回答型別明確的是非題與選擇題。依據答案採取行動的是程式碼。主模型，也就是讀寫你程式碼的那個模型，只會看到它需要的內容。

- **每一項判定都看得見**。每一項判定都有一個模式：`off`、`shadow`（會詢問並記錄，但不據此行動）或 `active`。判定結果與耗時都會寫入帳本（`/ledger`、`mu ledger`）。
- **每一項判定都是失效開放（fail open）**。判定器若沒把握、太慢或無法連線，就由一條簡單規則決定，或照 pi 原本的行為執行。
- **判定器可以抽換**。mu 可以使用 [JeV](../../kyrn/docs/08-jev-retrospective.md)（託管服務，經由 Vercel AI Gateway）、*Laya*（macOS 上的本機判定器，使用 Core ML）、任何你已經在用的語言模型，或把其中幾個分層組合：後一層的判定器只接手前一層沒把握的問題。

mu 建構於 [pi](https://github.com/earendil-works/pi) 之上；pi 是一個精簡、可擴充的終端機程式設計代理。mu 幾乎不動 pi 的核心，以擴充套件（`packages/kyrn-judge`）的形式加上自己的判定層。桌面應用程式則建構於 [AionUi](https://github.com/iOfficeAI/AionUi) 之上。

## 目前能做什麼

**判定層**，在 32 項功能中設有 29 個判定點：

- **先讀過每一則訊息**。判定器會判斷這是哪一種回合（新任務、更正、新約束、題外提問）、需要多少推理，以及是否要先規劃。這段期間訊息會停在編輯器上方（按 `esc` 可略過等待），判定結果則留在聊天中該訊息的下方。
- **任務幀**。mu 會記住目標、你的硬約束（以你的原話記錄，並標明你是在哪裡說的）、目前的子目標，以及一份驗收條件清單。每次編輯之前，變更都會與你的約束比對，明顯違反的會被擋下，並引用你的原話。`/frame` 可以查看。
- **保持上下文精簡**。測試日誌中重複的失敗只保留一次。工具、MCP 伺服器、語言伺服器和能力包都已安裝，但在任務需要之前保持隱藏（能力目錄）。只回報新增的編譯錯誤（以基準線比對 LSP 診斷）。技能與經驗依任務挑選。
- **三種權限模式**。*完全存取*；*JeV 審批*（判定器核准任務明顯需要的操作，其餘的會詢問你）；*最小權限*（除了讀取以外，一律詢問）。用 `/permissions` 切換。某個步驟需要你核准時，狀態列會出現提示。
- **目標模式**。`/goal <condition>` 會讓代理持續工作，直到條件成立。每當代理想停下來，就由一個語言模型審視證據。硬性事實優先：清單中還有未完成的項目，或有某次編輯沒有經過任何檢查，都代表還沒完成。
- **人話看板**。每隔幾個步驟，判定器會挑出真正值得一提的新消息，再由一個擅長解說的模型，為不讀程式碼的人重新講一遍：工作進行到哪裡、現在正在做什麼、有哪些事在等你處理。一次執行結束時，看板會做總結。用 `/board on` 為個別專案開啟。
- **檢查點與回退**。每個回合第一次編輯之前，都會先在一個影子 git 目錄裡為工作區建立快照；你自己的 index 和 stash 絕不會被動到。`/rewind` 可以還原檔案、對話，或兩者一起還原。當代理一再以同樣的方式失敗，判定器可以建議回退；它絕不會自行回退。

**子代理與瀏覽器**

- **`delegate`**。彼此獨立的部分可以平行執行，或串成一連串的步驟。需要編輯的部分會在各自的 git worktree 中工作，完成後交回一份 patch。每個子代理都依照自己的清單工作，並回報清單結果。`/implement`、`/scout-and-plan` 和 `/implement-and-review` 是現成的串接流程。
- **`hive`（蜂群）**。面對一個困難的問題，由多個調查者同時著手，判定器決定哪些發現可以在彼此之間傳遞。
- **內建瀏覽器**。`browse` 以「觀察、一次判定器呼叫、行動」的迴圈運作。在桌面應用程式中，你可以在專屬的瀏覽器面板裡看著每一步，並隨時接手。任何不可逆的操作都會先徵詢你。

**日常工具**

- **沿用你現有的設定**。mu 會讀取你為 Claude Code、Cursor 和 Codex 設定的規則、技能與 MCP 伺服器。
- **能力包**。`/review` 會把找到的問題依 P0–P3 分級排序；`/commit` 會把一次變更拆成多個 commit，並先讓你看過計畫。另外還有 ast-grep、透過 `gh` 使用 GitHub、衝突解決，以及 DAP 除錯器（debugpy、delve、lldb-dap）。
- **背景工作、網頁擷取與搜尋**（包含在中國大陸也能使用的來源），以及用 Claude、ChatGPT、Grok 和 Google **登入**（透過 Gemini CLI 或 Antigravity 使用 Google 屬於*實驗性*功能：mu 會說明風險，並在開啟瀏覽器之前先徵詢你）。

**桌面應用程式**（`desktop/`）

- JeV 面板會顯示每一個判定結果。
- 瀏覽器面板由 mu 操控。
- 顯示人話看板與權限提示。
- 設定頁面由 harness 自身的 manifest 產生：判定器、判定模式、功能，以及使用 OpenAI 或 Anthropic 相容端點的提供者。
- 引導式的首次啟動與登入。
- 介面支援 13 種語言。

## 儲存庫結構

| 路徑 | 內容 |
| --- | --- |
| `packages/kyrn-judge` | mu 本體：判定核心、29 份判定規格，以及上述所有功能，以 pi 擴充套件的形式提供 |
| `packages/*`（其他） | pi 的 monorepo：`ai`（提供者）、`agent`（迴圈）、`coding-agent`（CLI）、`tui` 等，並帶有少量小修補 |
| `kyrn/bin` | `mu` 啟動器（`mu`、`mu.cmd`、`mu.ps1`；Node，無相依套件） |
| `kyrn/docs` | 設計筆記、產品計畫，以及每項功能各一份文件（大多為簡體中文） |
| `kyrn/local-judge` | 本機判定器 Laya（macOS，Core ML） |
| `desktop/` | 桌面應用程式（Electron，AionUi 的 fork） |

*KYRN* 是這個專案先前的名稱，至今仍保留在資料夾與套件名稱中。

## 安裝

```bash
npm i -g mu-agent
mu
```

需要 Node.js 22.19 或更新版本。套件名稱是 `mu-agent`，指令是 `mu`，支援 macOS、Linux、Windows 和 WSL。執行 `npm i -g mu-agent@latest` 即可更新。下文的內容同樣適用，只有一處不同：JeV 金鑰放在環境變數或 `~/.mu/.env` 裡，而不是 `kyrn/.env`。

## 從原始碼開始

你需要 Node.js 22.19 或更新版本（建議 24）、npm 和 git。

```bash
git clone https://github.com/qybaihe/mu.git
cd MU
npm install
kyrn/bin/mu            # Windows: kyrn\bin\mu.cmd
```

在 mu 裡，`/login` 登入模型提供者，`/model` 選擇模型。`/help` 會列出全部內容，`/doctor` 則檢查設定。要把 `mu` 加入 PATH，請執行 `kyrn/bin/mu link`。

**選擇判定器**。沒有判定器時，mu 的行為就像 pi 加上額外的工具。

- **JeV**：把 Vercel AI Gateway 金鑰以 `AI_GATEWAY_API_KEY` 寫入 `kyrn/.env`（參見 `kyrn/.env.example`）。
- **Laya，本機執行，僅限 macOS**：執行 `mu judge setup`。它會下載約 930 MB，開始之前會先詢問你。
- **任何你已經在用的模型**：`/mu judge llm:<provider>/<model>`。

判定一開始處於 `shadow` 模式，你可以先觀察判定器會怎麼做。等你信任它了，就執行 `/mu mode default active`，或在 `~/.mu/agent/mu.json` 中設定 `"modes": {"default": "active"}`。

**從原始碼執行桌面應用程式**，需要 [Bun](https://bun.sh)：

```bash
cd desktop
bun install
KYRN_ROOT="$(cd .. && pwd)" bun run start     # Windows (PowerShell): $env:KYRN_ROOT = (Resolve-Path ..); bun run start
```

應用程式會從 `KYRN_ROOT` 所指的儲存庫副本（checkout）執行 mu，所以請先在儲存庫根目錄執行 `npm install`。

## 建置

GitHub Actions 會檢查每一次 push。它會為所有常見平台建置桌面應用程式，並為每個 `v*` 標籤發布一個版本：

| | x64 | arm64 |
| --- | --- | --- |
| **macOS** | `.dmg`、`.zip`（Intel） | `.dmg`、`.zip`（Apple 晶片） |
| **Windows** | `.exe` 安裝程式 | `.exe` 安裝程式 |
| **Linux** | `.deb` | `.deb` |

每個版本也都附有儲存庫的原始碼封存檔。

這些都是**預覽版**：

- 它們目前還沒有經過程式碼簽署。macOS 首次啟動時，會要求你到*系統設定 → 隱私權與安全性*確認；Windows SmartScreen 則會顯示警告。
- 應用程式目前還沒有內含 mu。它會從同一台機器上這個儲存庫的副本執行 mu，所以請把 `KYRN_ROOT` 設為該副本。

`mu` 命令列工具在上述所有平台上都可以從 npm 安裝（`npm i -g mu-agent`，見上文），也可以從原始碼執行。

## 我們正在進行的工作

- **應用程式內建 mu，並提供獨立執行檔**。下載的應用程式應該能獨立運作，不需要儲存庫副本，也不需要 `KYRN_ROOT`；`mu` 指令則應該每個平台各一個檔案。
- **以應用程式作為使用 mu 的主要方式**。整個流程都在桌面應用程式內執行，而不是透過終端機橋接。這表示需要一個原生的對話檢視，由單一、有序的事件串流驅動。
- **一鍵安裝本機判定器**。從設定中安裝 Laya，會顯示其大小與來源，並在任何下載開始之前徵求你的同意。
- **在真實機器上跑 Windows 與 WSL**。相關的程式碼路徑已經存在，也有單元測試；但仍需要一台真正的 Windows 機器。
- **衡量判定器**。針對每個判定點，量測 JeV 和 Laya 在真實工作階段中判斷正確的頻率，以便調整門檻。
- **語意偏移檢查**（*實驗性*）。判定器會在模型輸出串流時加以監看，只有在輸出明顯違反你設定的規則時才會中止它。

詳細計畫以及每一項的狀態，請見 [kyrn/docs/11-out-of-the-box-roadmap.md](../../kyrn/docs/11-out-of-the-box-roadmap.md)（簡體中文）。

## 參與貢獻

請先閱讀 [AGENTS.md](../../AGENTS.md)。簡單來說：使用 tab 縮排、相對匯入要帶 `.ts` 副檔名、只使用可擦除的 TypeScript 語法、相依套件使用精確版本。執行 `npm run check` 以及你改動到的測試。完整的測試套件很慢，交給 CI 就好，每次推送它都會跑一遍。測試使用模擬判定器和假模型，從不呼叫真實模型。

## 致謝與授權

- **pi** 由 Mario Zechner 與貢獻者開發，採用 MIT 授權。根目錄的 [LICENSE](../../LICENSE) 涵蓋 `packages/` 和 `kyrn/`。
- **桌面應用程式以 [AionUi](https://github.com/iOfficeAI/AionUi) 為基礎開發**，作者是 iOfficeAI，採用 Apache 2.0 授權。在應用程式裡它叫 mu，但許多程式碼來自 AionUi，在此致謝。`desktop/` 保留 AionUi 的 [LICENSE](../../desktop/LICENSE)。
- 判定層中的第三方程式碼列於 [packages/kyrn-judge/THIRD_PARTY_NOTICES.md](../../packages/kyrn-judge/THIRD_PARTY_NOTICES.md)。
