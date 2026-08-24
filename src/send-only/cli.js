#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSendOnlyBridge } from './server.js';

const configDir = path.resolve(process.env.SEND_ONLY_CONFIG_DIR || path.join(os.homedir(), '.chatgpt-send-only-bridge'));
const configPath = path.join(configDir, 'config.json');

function strongToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function loadOrCreateConfig() {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  const config = {
    apiToken: String(process.env.SEND_ONLY_API_TOKEN || saved.apiToken || strongToken()),
    bridgeToken: String(process.env.SEND_ONLY_BRIDGE_TOKEN || saved.bridgeToken || strongToken()),
    port: Number(process.env.SEND_ONLY_PORT || saved.port || 8080),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return config;
}

const config = loadOrCreateConfig();
const bridge = createSendOnlyBridge({
  ...config,
  logger(event, details) {
    console.log(`[send-only] ${event}`, JSON.stringify(details));
  },
});

await bridge.listen(config.port);
console.log(`[send-only] listening on ${bridge.httpUrl}`);
console.log(`[send-only] config: ${configPath}`);
console.log('[send-only] assistant output collection is disabled by design');

async function shutdown() {
  await bridge.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
