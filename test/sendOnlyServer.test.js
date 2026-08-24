import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import WebSocket from 'ws';

import { createSendOnlyBridge } from '../src/send-only/server.js';

const API_TOKEN = 'a'.repeat(48);
const BRIDGE_TOKEN = 'b'.repeat(48);
const running = [];

afterEach(async () => {
  while (running.length) await running.pop().close();
});

async function startBridge(options = {}) {
  const bridge = createSendOnlyBridge({
    apiToken: API_TOKEN,
    bridgeToken: BRIDGE_TOKEN,
    promptTimeoutMs: 2_000,
    ...options,
  });
  await bridge.listen(0);
  running.push(bridge);
  return bridge;
}

async function connectExtension(bridge) {
  const socket = new WebSocket(`${bridge.wsUrl}?token=${BRIDGE_TOKEN}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

test('requires strong API and bridge tokens', () => {
  assert.throws(() => createSendOnlyBridge({ apiToken: 'short', bridgeToken: BRIDGE_TOKEN }), /at least 32/);
  assert.throws(() => createSendOnlyBridge({ apiToken: API_TOKEN, bridgeToken: 'short' }), /at least 32/);
});

test('binds only to loopback and exposes only health plus prompt', async () => {
  const bridge = await startBridge();
  assert.match(bridge.httpUrl, /^http:\/\/127\.0\.0\.1:/);

  const unauthorized = await fetch(`${bridge.httpUrl}/health`);
  assert.equal(unauthorized.status, 401);

  const health = await fetch(`${bridge.httpUrl}/health`, {
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    mode: 'send-only',
    connectedClients: 0,
    pendingPrompts: 0,
  });

  for (const path of ['/chat', '/v1/chat/completions', '/browser/observed-turns', '/browser/recover-latest', '/artifacts']) {
    const response = await fetch(`${bridge.httpUrl}${path}`, {
      method: path === '/chat' || path.includes('recover') || path.includes('completions') ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: path === '/chat' || path.includes('recover') || path.includes('completions') ? '{}' : undefined,
    });
    assert.equal(response.status, 404, path);
  }
});

test('returns submission acknowledgement but discards every extra extension field', async () => {
  const bridge = await startBridge();
  const socket = await connectExtension(bridge);
  socket.on('message', (raw) => {
    const command = JSON.parse(String(raw));
    assert.equal(command.type, 'prompt.submit');
    assert.equal(command.message, 'create a draft PR');
    assert.equal(command.newChat, false);
    socket.send(JSON.stringify({
      type: 'prompt.submitted',
      commandId: command.commandId,
      submitted: true,
      tabId: 42,
      output: 'must never reach the HTTP caller',
      markdown: '# forbidden',
    }));
  });

  const response = await fetch(`${bridge.httpUrl}/prompt`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'create a draft PR' }),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['commandId', 'ok', 'submitted', 'tabId']);
  assert.equal(body.submitted, true);
  assert.equal(body.tabId, 42);
  assert.doesNotMatch(JSON.stringify(body), /forbidden|output|markdown/i);
  socket.close();
});

test('passes only an explicit newChat boolean to the extension command', async () => {
  const bridge = await startBridge();
  const socket = await connectExtension(bridge);
  const received = [];
  socket.on('message', (raw) => {
    const command = JSON.parse(String(raw));
    if (command.type !== 'prompt.submit') return;
    received.push(command);
    socket.send(JSON.stringify({ type: 'prompt.submitted', commandId: command.commandId, submitted: true, tabId: 88 }));
  });
  const response = await fetch(`${bridge.httpUrl}/prompt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'new isolated chat', newChat: true }),
  });
  assert.equal(response.status, 202);
  assert.equal(received[0].newChat, true);
  socket.close();
});

test('rejects an extension WebSocket with the wrong token', async () => {
  const bridge = await startBridge();
  const socket = new WebSocket(`${bridge.wsUrl}?token=wrong`);
  const status = await new Promise((resolve) => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('error', () => resolve(401));
  });
  assert.equal(status, 401);
});

test('sends a local heartbeat so Chrome MV3 does not suspend the bridge socket', async () => {
  const bridge = await startBridge({ heartbeatIntervalMs: 20 });
  const socket = await connectExtension(bridge);
  const heartbeat = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('heartbeat timeout')), 500);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
  assert.deepEqual(heartbeat, { type: 'bridge.ping' });
  socket.close();
});
