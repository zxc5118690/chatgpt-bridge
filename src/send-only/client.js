const MAX_PROMPT_BYTES = 64 * 1024;

export class SendOnlyClientError extends Error {
  constructor(code, message, { exitCode = 4, status = null } = {}) {
    super(message);
    this.name = 'SendOnlyClientError';
    this.code = code;
    this.exitCode = exitCode;
    this.status = status;
  }
}

function errorForResponse(status, body) {
  const serverCode = String(body?.error || 'bridge_request_failed');
  if (status === 401) return new SendOnlyClientError('unauthorized', 'Local API token was rejected', { exitCode: 2, status });
  if (status === 503 || serverCode === 'extension_not_connected') {
    return new SendOnlyClientError('extension_not_connected', 'No connected ChatGPT extension client', { exitCode: 3, status });
  }
  if (status === 504 || serverCode === 'prompt_submission_timeout') {
    return new SendOnlyClientError('prompt_submission_timeout', 'ChatGPT did not acknowledge prompt submission before timeout', { status });
  }
  return new SendOnlyClientError(serverCode, 'The local bridge rejected the request', { status });
}

export function createSendOnlyClient({ serverUrl, apiToken, timeoutMs = 35_000, fetchImpl = fetch } = {}) {
  const baseUrl = String(serverUrl || '').replace(/\/$/, '');
  const token = String(apiToken || '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new SendOnlyClientError('config_invalid', 'Server URL must use 127.0.0.1', { exitCode: 2 });
  if (Buffer.byteLength(token) < 32) throw new SendOnlyClientError('config_invalid', 'API token must be at least 32 bytes', { exitCode: 2 });

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        signal: AbortSignal.timeout(Math.max(100, Number(timeoutMs) || 35_000)),
      });
    } catch (error) {
      const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'bridge_timeout' : 'bridge_unreachable';
      const message = code === 'bridge_timeout' ? 'Local bridge request timed out' : `Local bridge is unreachable at ${baseUrl}`;
      throw new SendOnlyClientError(code, message, { exitCode: code === 'bridge_unreachable' ? 2 : 4 });
    }
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) throw errorForResponse(response.status, body);
    return body;
  }

  return Object.freeze({
    async health() {
      const body = await request('/health');
      const health = {
        ok: body.ok === true,
        mode: body.mode === 'send-only' ? 'send-only' : String(body.mode || ''),
        connectedClients: Number(body.connectedClients) || 0,
        pendingPrompts: Number(body.pendingPrompts) || 0,
      };
      if (health.connectedClients < 1) {
        throw new SendOnlyClientError('extension_not_connected', 'Bridge is running but no ChatGPT extension is connected', { exitCode: 3 });
      }
      return health;
    },
    async send(message) {
      const text = String(message || '').trim();
      if (!text) throw new SendOnlyClientError('message_required', 'Prompt message is empty', { exitCode: 2 });
      if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
        throw new SendOnlyClientError('message_too_large', 'Prompt exceeds 64 KiB', { exitCode: 2 });
      }
      const body = await request('/prompt', { method: 'POST', body: JSON.stringify({ message: text }) });
      return Object.freeze({
        ok: body.ok === true,
        commandId: String(body.commandId || ''),
        submitted: body.submitted === true,
        tabId: Number.isInteger(body.tabId) ? body.tabId : null,
      });
    },
  });
}
