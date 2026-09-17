# 為什麼 manifest.json 有 `key` 欄位

未封裝（unpacked）擴充的 ID 預設由**載入路徑**推導。路徑一變，Chrome 就當它是另一個
擴充：新 ID、全新的 `chrome.storage`，選項頁存的 bridge token 跟著消失。

2026-08-30 實際踩過：`wencode` 三層重整把專案從
`~/Desktop/wencode/chatgpt-local-bridge/` 搬到 `~/Desktop/wencode/agent/` 之後，
擴充直接從 Chrome 清單消失，bridge 連了兩天都是 `extension_not_connected`。

`key` 欄位放的是一組 RSA 公鑰（DER/base64）。有它之後 ID 改由公鑰推導，**與路徑無關**，
以後再怎麼搬都是同一個擴充、token 不會掉。

- 釘死後的 extension ID：`ebdjmblggikdanabfcgchmlbfljjjaca`
- 對應私鑰：`~/.chatgpt-send-only-bridge/extension-signing-key.pem`（mode 600，不在版控裡）
  只有將來要打包成 `.crx` 才需要它；純未封裝載入用不到。私鑰遺失＝ID 會再變一次。
