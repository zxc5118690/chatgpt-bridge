# ChatGPT Send-Only Bridge

這個 fork 只提供兩個 API：`GET /health` 與 `POST /prompt`。它把 prompt 送進已登入的 ChatGPT 分頁，收到「使用者訊息已送出」確認後就停止；不讀取、解析、串流或下載 ChatGPT 回答。

## 安裝

```bash
npm ci
npm start
```

首次啟動會在 `~/.chatgpt-send-only-bridge/config.json` 建立兩個 48-byte 隨機 token，檔案權限為 `0600`。Chrome 開啟 `chrome://extensions`、啟用開發人員模式，載入：

```text
tools/chrome-send-only-extension
```

在 extension options 填入 `http://127.0.0.1:8080` 和設定檔中的 `bridgeToken`。

> 只載入 `tools/chrome-send-only-extension/`。歷史 upstream 目錄 `tools/chrome-bridge-extension/` 的 manifest 已改成無權限、無 script 的 inert guard，即使誤載也不會執行 full bridge。

## 呼叫

```bash
curl -X POST http://127.0.0.1:8080/prompt \
  -H "Authorization: Bearer $SEND_ONLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"message":"在已授權的 repo 建立 branch、commit 與 Draft PR。"}'
```

API 回傳只包含 `commandId`、`submitted` 與瀏覽器 `tabId`。完成結果應從 GitHub API 驗證，不得從 ChatGPT DOM 回收。

## 安全邊界

- HTTP 與 WebSocket 固定只綁 `127.0.0.1`。
- HTTP token 與 extension token 分離，且都至少 32 bytes。
- extension 權限只有 `storage`、ChatGPT 與 loopback host；不含 `tabs`、`cookies`、`downloads`、`debugger` 或 `<all_urls>`。
- npm 發布白名單不包含 upstream 的 full bridge、workflow、shell、ZIP、Codex RPC 或回答 parser。
