import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import WebSocket from 'ws';

import { createSendOnlyClient, SendOnlyClientError } from '../src/send-only/client.js';
import { runCli } from '../src/send-only/cli.js';
import { loadOrCreateServerConfig, readClientConfig } from '../src/send-only/config.js';
import { createSendOnlyBridge } from '../src/send-only/server.js';

const API_TOKEN = 'a'.repeat(48);
const BRIDGE_TOKEN = 'b'.repeat(48);
const running = [];

afterEach(async () => {
  while (running.length) await running.pop().close();
});

async function startBridge() {
  const bridge = createSendOnlyBridge({ apiToken: API_TOKEN, bridgeToken: BRIDGE_TOKEN, promptTimeoutMs: 2_000 });
  await bridge.listen(0);
  running.push(bridge);
  return bridge;
}

async function connectExtension(bridge, handler = null) {
  const socket = new WebSocket(`${bridge.wsUrl}?token=${BRIDGE_TOKEN}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  if (handler) socket.on('message', handler);
  return socket;
}

test('client config reads the existing 0600 file without exposing tokens', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-only-config-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    apiToken: API_TOKEN,
    bridgeToken: BRIDGE_TOKEN,
    port: 8123,
  }), { mode: 0o600 });

  const config = readClientConfig({ configDir });
  assert.deepEqual(config, { apiToken: API_TOKEN, serverUrl: 'http://127.0.0.1:8123' });
  assert.equal('bridgeToken' in config, false);
});

test('serve config never silently replaces a malformed token file', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-only-invalid-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), '{broken', { mode: 0o600 });
  assert.throws(() => loadOrCreateServerConfig({ configDir }), (error) => error.code === 'config_invalid');
  assert.equal(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'), '{broken');
});

test('health distinguishes a running server from a connected Chrome extension', async () => {
  const bridge = await startBridge();
  const client = createSendOnlyClient({ serverUrl: bridge.httpUrl, apiToken: API_TOKEN });

  await assert.rejects(client.health(), (error) => {
    assert.ok(error instanceof SendOnlyClientError);
    assert.equal(error.code, 'extension_not_connected');
    assert.equal(error.exitCode, 3);
    return true;
  });

  const socket = await connectExtension(bridge);
  const health = await client.health();
  assert.deepEqual(health, { ok: true, mode: 'send-only', connectedClients: 1, pendingPrompts: 0 });
  socket.close();
});

test('send returns only the submission acknowledgement allowlist', async () => {
  const bridge = await startBridge();
  const socket = await connectExtension(bridge, (raw) => {
    const command = JSON.parse(String(raw));
    if (command.type !== 'prompt.submit') return;
    socket.send(JSON.stringify({
      type: 'prompt.submitted',
      commandId: command.commandId,
      submitted: true,
      tabId: 77,
      output: 'forbidden assistant output',
    }));
  });
  const client = createSendOnlyClient({ serverUrl: bridge.httpUrl, apiToken: API_TOKEN });
  const acknowledgement = await client.send('create a draft PR');

  assert.deepEqual(Object.keys(acknowledgement).sort(), ['commandId', 'ok', 'submitted', 'tabId']);
  assert.doesNotMatch(JSON.stringify(acknowledgement), /forbidden|output/i);
  socket.close();
});

test('CLI --new-chat reaches the extension command and preserves the ACK allowlist', async () => {
  const bridge = await startBridge();
  let receivedCommand;
  const socket = await connectExtension(bridge, (raw) => {
    const command = JSON.parse(String(raw));
    if (command.type !== 'prompt.submit') return;
    receivedCommand = command;
    socket.send(JSON.stringify({ type: 'prompt.submitted', commandId: command.commandId, submitted: true, tabId: 123 }));
  });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-only-new-chat-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    apiToken: API_TOKEN,
    bridgeToken: BRIDGE_TOKEN,
    port: Number(new URL(bridge.httpUrl).port),
  }), { mode: 0o600 });
  const previous = process.env.SEND_ONLY_CONFIG_DIR;
  process.env.SEND_ONLY_CONFIG_DIR = configDir;
  try {
    let output = '';
    const exitCode = await runCli(['send', '--new-chat', '--message', 'isolated prompt'], {
      stdin: { isTTY: true },
      stdout: { write: (chunk) => { output += chunk; } },
      stderr: { write: () => {} },
    });
    assert.equal(exitCode, 0);
    assert.equal(receivedCommand.newChat, true);
    assert.deepEqual(JSON.parse(output), { ok: true, commandId: receivedCommand.commandId, submitted: true, tabId: 123 });
  } finally {
    if (previous === undefined) delete process.env.SEND_ONLY_CONFIG_DIR;
    else process.env.SEND_ONLY_CONFIG_DIR = previous;
    socket.close();
  }
});

test('CLI rejects repeated --new-chat and a value attached to the boolean flag', async () => {
  for (const args of [
    ['send', '--new-chat', '--new-chat', '--message', 'x'],
    ['send', '--new-chat', 'true', '--message', 'x'],
  ]) {
    let errors = '';
    const exitCode = await runCli(args, {
      stdin: { isTTY: true },
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { errors += chunk; } },
    });
    assert.equal(exitCode, 2);
    assert.equal(JSON.parse(errors).error, 'invalid_arguments');
  }
});

test('unreachable server has a stable machine-readable error and exit code', async () => {
  const client = createSendOnlyClient({
    serverUrl: 'http://127.0.0.1:1',
    apiToken: API_TOKEN,
    timeoutMs: 200,
  });
  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, 'bridge_unreachable');
    assert.equal(error.exitCode, 2);
    return true;
  });
});

test('CLI health uses exit 3 for a disconnected extension and exit 0 when connected', async () => {
  const bridge = await startBridge();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-only-cli-'));
  const port = Number(new URL(bridge.httpUrl).port);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    apiToken: API_TOKEN,
    bridgeToken: BRIDGE_TOKEN,
    port,
  }), { mode: 0o600 });
  const previous = process.env.SEND_ONLY_CONFIG_DIR;
  process.env.SEND_ONLY_CONFIG_DIR = configDir;
  try {
    let output = '';
    let errors = '';
    const disconnected = await runCli(['health'], {
      stdout: { write: (chunk) => { output += chunk; } },
      stderr: { write: (chunk) => { errors += chunk; } },
    });
    assert.equal(disconnected, 3);
    assert.equal(output, '');
    assert.equal(JSON.parse(errors).error, 'extension_not_connected');

    const socket = await connectExtension(bridge);
    output = '';
    errors = '';
    const connected = await runCli(['health'], {
      stdout: { write: (chunk) => { output += chunk; } },
      stderr: { write: (chunk) => { errors += chunk; } },
    });
    assert.equal(connected, 0);
    assert.equal(JSON.parse(output).connectedClients, 1);
    assert.equal(errors, '');
    socket.close();
  } finally {
    if (previous === undefined) delete process.env.SEND_ONLY_CONFIG_DIR;
    else process.env.SEND_ONLY_CONFIG_DIR = previous;
  }
});

test('CLI classifies an unreadable prompt file as input failure', async () => {
  let errors = '';
  const exitCode = await runCli(['send', '--file', '/definitely/not/a/prompt.txt'], {
    stdin: { isTTY: true },
    stdout: { write: () => {} },
    stderr: { write: (chunk) => { errors += chunk; } },
  });
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(errors).error, 'prompt_file_unreadable');
});
