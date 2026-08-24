# ChatGPT Send-Only Bridge

This fork exposes only `GET /health` and `POST /prompt`. It submits a prompt to a logged-in ChatGPT tab and stops after confirming that the user message was submitted. It never reads, parses, streams, or downloads the ChatGPT response.

## Installation

```bash
npm ci
npm link
npm start
```

The first startup creates two random 48-byte tokens in `~/.chatgpt-send-only-bridge/config.json` with `0600` permissions. Open `chrome://extensions`, enable Developer mode, and load:

```text
tools/chrome-send-only-extension
```

Enter `http://127.0.0.1:8080` and the config file's `bridgeToken` in the extension options.

> Load only `tools/chrome-send-only-extension/`. The historical upstream `tools/chrome-bridge-extension/` manifest is an inert guard with no permissions or scripts.

## Stable CLI

```bash
chatgpt-send health
chatgpt-send send --file /absolute/path/to/prompt.txt
chatgpt-send send --new-chat --file /absolute/path/to/prompt.txt
printf '%s' 'Create the authorized branch, commit, and draft PR.' | chatgpt-send send
chatgpt-send serve
```

`npm start` and `chatgpt-send serve` are equivalent. Agents should prefer `--file` or stdin. `--message` is suitable for short, non-sensitive text because command-line arguments may briefly appear in the process list.

`--new-chat` creates an inactive tab through the fresh-composer bootstrap URL `https://chatgpt.com/?model=auto` and locks delivery to its exact Chrome tab ID. After the tab completes loading, one `prompt.submit` message atomically waits for the composer and submits through the content script. The background retries only when Chrome explicitly proves that no content receiver existed, checking the exact tab and rejecting any `/c/...` conversation URL before every retry. Once a receiver responds with either success or failure, the message is never resent. All other creation, identity, loading, or submission failures fail closed with no fallback to an existing tab. A failed newly created tab is left open for inspection and recovery.

Without `--new-chat`, the existing behavior remains unchanged: the active ChatGPT tab is preferred, followed by the first matching ChatGPT tab.

Successful stdout is exactly one JSON line. The `send` acknowledgement contains only `ok`, `commandId`, `submitted`, and `tabId`. Verify task results through the GitHub API; never recover them from the ChatGPT DOM.

| Exit code | Meaning |
|---:|---|
| `0` | The prompt reached the ChatGPT composer and submission was confirmed |
| `2` | Configuration or input error, or the local bridge is unavailable/token authentication failed |
| `3` | The bridge is running but the Chrome extension is disconnected |
| `4` | Submission timed out or the ChatGPT composer rejected the prompt |

Errors are written only to stderr as `{"ok":false,"error":"stable_code","message":"human-readable message"}` and never contain the prompt or token.

## Agent Contract

1. Run `chatgpt-send health`; stop if its exit code is not zero.
2. Write the complete assignment to a temporary file and submit it with `chatgpt-send send --new-chat --file ...`; read only the acknowledgement.
3. Do not read the ChatGPT page, DOM, or response. Poll the agreed branch or draft PR through `gh` or the GitHub API.
4. Do not merge a PR, force-push, or touch repositories outside the prompt's explicit scope.

## Security Boundary

- HTTP and WebSocket listeners bind only to `127.0.0.1`.
- HTTP and extension tokens are separate and at least 32 bytes each.
- The extension has only `storage` plus ChatGPT and loopback host permissions. Chrome's `tabs.create`, `tabs.query`, `tabs.get`, and `tabs.sendMessage` do not require the broad `tabs` permission; the ChatGPT host permission supplies the required site access.
- The extension does not request `cookies`, `downloads`, `debugger`, `scripting`, `nativeMessaging`, or `<all_urls>`.
- The npm publication allowlist excludes the upstream full bridge, workflows, shell access, ZIP support, Codex RPC, and response parsers.
