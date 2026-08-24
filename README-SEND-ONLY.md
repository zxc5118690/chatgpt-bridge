# ChatGPT Send-Only Bridge

這個 fork 只提供兩個 API：`GET /health` 與 `POST /prompt`。它把 prompt 送進已登入的 ChatGPT 分頁，收到「使用者訊息已送出」確認後就停止；不讀取、解析、串流或下載 ChatGPT 回答。

## 安裝

```bash
npm ci
npm link
npm start
```

首次啟動會在 `~/.chatgpt-send-only-bridge/config.json` 建立兩個 48-byte 隨機 token，檔案權限為 `0600`。Chrome 開啟 `chrome://extensions`、啟用開發人員模式，載入：

```text
tools/chrome-send-only-extension
```

在 extension options 填入 `http://127.0.0.1:8080` 和設定檔中的 `bridgeToken`。

> 只載入 `tools/chrome-send-only-extension/`。歷史 upstream 目錄 `tools/chrome-bridge-extension/` 的 manifest 已改成無權限、無 script 的 inert guard，即使誤載也不會執行 full bridge。

## 固定 CLI

```bash
chatgpt-send health
chatgpt-send send --file /absolute/path/to/prompt.txt
printf '%s' '在已授權的 repo 建立 branch、commit 與 Draft PR。' | chatgpt-send send
chatgpt-send serve
```

`npm start` 與 `chatgpt-send serve` 等價。Agent 應優先使用 `--file` 或 stdin；`--message` 適合短且不敏感的文字，因為命令列參數可能短暫出現在 process list。

成功時 stdout 只有一行 JSON。`send` 回傳只包含 `ok`、`commandId`、`submitted`、`tabId`；完成結果應從 GitHub API 驗證，不得從 ChatGPT DOM 回收。

| Exit code | 意義 |
|---:|---|
| `0` | 命令成功；prompt 已獲 ChatGPT composer 送達確認 |
| `2` | 設定／輸入錯誤，或本機 bridge 沒啟動／token 不符 |
| `3` | bridge 有啟動，但 Chrome extension 沒連線 |
| `4` | 送達逾時或 ChatGPT composer 拒絕提交 |

錯誤只寫到 stderr，格式為 `{"ok":false,"error":"穩定代碼","message":"人類可讀訊息"}`，不包含 prompt 或 token。

## Agent 呼叫契約

1. 先跑 `chatgpt-send health`，exit code 非 0 就停止，不送 prompt。
2. 把完整交辦包寫進暫存檔，以 `chatgpt-send send --file ...` 送出，只讀 ACK。
3. 不讀 ChatGPT 頁面、DOM 或回答；依 prompt 約定改用 `gh`／GitHub API 輪詢指定 branch／Draft PR。
4. Agent 不得自行 merge PR、force push、碰未在 prompt 明列的 repo。

## 安全邊界

- HTTP 與 WebSocket 固定只綁 `127.0.0.1`。
- HTTP token 與 extension token 分離，且都至少 32 bytes。
- extension 權限只有 `storage`、ChatGPT 與 loopback host；不含 `tabs`、`cookies`、`downloads`、`debugger` 或 `<all_urls>`。
- npm 發布白名單不包含 upstream 的 full bridge、workflow、shell、ZIP、Codex RPC 或回答 parser。
