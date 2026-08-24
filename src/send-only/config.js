import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 8080;

export class SendOnlyConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SendOnlyConfigError';
    this.code = code;
    this.exitCode = 2;
  }
}

function defaultConfigDir(env = process.env) {
  return path.resolve(env.SEND_ONLY_CONFIG_DIR || path.join(os.homedir(), '.chatgpt-send-only-bridge'));
}

function configFile(configDir) {
  return path.join(configDir, 'config.json');
}

function strongToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function validToken(value) {
  return Buffer.byteLength(String(value || '')) >= 32;
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function readSavedConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SendOnlyConfigError('config_missing', `Config not found: ${configPath}. Run "chatgpt-send serve" once.`);
    throw new SendOnlyConfigError('config_invalid', `Config is not valid JSON: ${configPath}`);
  }
}

export function readClientConfig({ configDir = defaultConfigDir(), env = process.env } = {}) {
  const configPath = configFile(path.resolve(configDir));
  const saved = readSavedConfig(configPath);
  const apiToken = String(env.SEND_ONLY_API_TOKEN || saved.apiToken || '');
  const port = validPort(env.SEND_ONLY_PORT || saved.port || DEFAULT_PORT);
  if (!validToken(apiToken)) throw new SendOnlyConfigError('config_invalid', 'API token must be at least 32 bytes');
  if (!port) throw new SendOnlyConfigError('config_invalid', 'Port must be an integer between 1 and 65535');
  return Object.freeze({ apiToken, serverUrl: `http://127.0.0.1:${port}` });
}

export function loadOrCreateServerConfig({ configDir = defaultConfigDir(), env = process.env } = {}) {
  const resolvedDir = path.resolve(configDir);
  const configPath = configFile(resolvedDir);
  fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  const saved = fs.existsSync(configPath) ? readSavedConfig(configPath) : {};
  const config = {
    apiToken: String(env.SEND_ONLY_API_TOKEN || saved.apiToken || strongToken()),
    bridgeToken: String(env.SEND_ONLY_BRIDGE_TOKEN || saved.bridgeToken || strongToken()),
    port: validPort(env.SEND_ONLY_PORT || saved.port || DEFAULT_PORT),
  };
  if (!validToken(config.apiToken) || !validToken(config.bridgeToken)) {
    throw new SendOnlyConfigError('config_invalid', 'API and bridge tokens must each be at least 32 bytes');
  }
  if (!config.port) throw new SendOnlyConfigError('config_invalid', 'Port must be an integer between 1 and 65535');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return Object.freeze({ ...config, configPath });
}
