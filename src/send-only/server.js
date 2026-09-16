import crypto from 'node:crypto';
import http from 'node:http';

import express from 'express';
import { WebSocketServer } from 'ws';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_PROMPT_BYTES = 64 * 1024;

function requireStrongToken(name, value) {
  const token = String(value || '');
  if (Buffer.byteLength(token) < 32) throw new Error(`${name} must be at least 32 bytes`);
  return token;
}

function sameToken(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearerToken(request) {
  const value = String(request.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function writeUpgradeError(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createSendOnlyBridge({
  apiToken,
  bridgeToken,
  promptTimeoutMs = 30_000,
  heartbeatIntervalMs = 20_000,
  logger = () => {},
} = {}) {
  const expectedApiToken = requireStrongToken('API token', apiToken);
  const expectedBridgeToken = requireStrongToken('Bridge token', bridgeToken);
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  const pending = new Map();
  let address = null;

  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_PROMPT_BYTES }));
  app.use((request, response, next) => {
    if (!sameToken(bearerToken(request), expectedApiToken)) {
      response.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    next();
  });

  app.get('/health', (_request, response) => {
    response.json({
      ok: true,
      mode: 'send-only',
      connectedClients: clients.size,
      pendingPrompts: pending.size,
    });
  });

  app.post('/prompt', async (request, response) => {
    const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
    const newChat = request.body?.newChat === true;
    if (!message) {
      response.status(400).json({ ok: false, error: 'message_required' });
      return;
    }
    if (Buffer.byteLength(message) > MAX_PROMPT_BYTES) {
      response.status(413).json({ ok: false, error: 'message_too_large' });
      return;
    }
    const client = [...clients].reverse().find((candidate) => candidate.readyState === candidate.OPEN);
    if (!client) {
      response.status(503).json({ ok: false, error: 'extension_not_connected' });
      return;
    }

    const commandId = crypto.randomUUID();
    logger('prompt.dispatch', { commandId, bytes: Buffer.byteLength(message) });
    try {
      const acknowledgement = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(commandId);
          reject(new Error('prompt_submission_timeout'));
        }, Math.max(1_000, Number(promptTimeoutMs) || 30_000));
        pending.set(commandId, { resolve, reject, timer, client });
        client.send(JSON.stringify({ type: 'prompt.submit', commandId, message, newChat }));
      });
      response.status(202).json({
        ok: true,
        commandId,
        submitted: true,
        tabId: acknowledgement.tabId,
      });
    } catch (error) {
      const status = error.message === 'prompt_submission_timeout' ? 504 : 502;
      response.status(status).json({ ok: false, commandId, error: error.message });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url || '/', `http://${request.headers.host || LOOPBACK_HOST}`); }
    catch {
      writeUpgradeError(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/extension/ws') {
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }
    if (!sameToken(url.searchParams.get('token'), expectedBridgeToken)) {
      writeUpgradeError(socket, 401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit('connection', webSocket));
  });

  wss.on('connection', (client) => {
    clients.add(client);
    logger('extension.connected', { clients: clients.size });
    const heartbeat = setInterval(() => {
      if (client.readyState === 1) client.send(JSON.stringify({ type: 'bridge.ping' }));
    }, Math.max(20, Number(heartbeatIntervalMs) || 20_000));
    heartbeat.unref?.();
    client.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      const commandId = String(message.commandId || '');
      const job = pending.get(commandId);
      if (!job || job.client !== client) return;
      if (message.type === 'prompt.submitted' && message.submitted === true) {
        clearTimeout(job.timer);
        pending.delete(commandId);
        job.resolve({ tabId: Number.isInteger(message.tabId) ? message.tabId : null });
      } else if (message.type === 'prompt.failed') {
        clearTimeout(job.timer);
        pending.delete(commandId);
        job.reject(new Error(String(message.error || 'prompt_submission_failed')));
      }
    });
    client.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
      for (const [commandId, job] of pending.entries()) {
        if (job.client !== client) continue;
        clearTimeout(job.timer);
        pending.delete(commandId);
        job.reject(new Error('extension_disconnected'));
      }
      logger('extension.disconnected', { clients: clients.size });
    });
  });

  return Object.freeze({
    get httpUrl() { return address ? `http://${LOOPBACK_HOST}:${address.port}` : ''; },
    get wsUrl() { return address ? `ws://${LOOPBACK_HOST}:${address.port}/extension/ws` : ''; },
    async listen(port = 8080) {
      if (address) return address;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(port), LOOPBACK_HOST, resolve);
      });
      address = server.address();
      return address;
    },
    async close() {
      if (!address) return;
      for (const client of clients) client.close(1001, 'server shutdown');
      await new Promise((resolve) => server.close(resolve));
      address = null;
    },
  });
}
