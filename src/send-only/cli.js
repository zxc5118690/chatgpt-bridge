#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createSendOnlyClient } from './client.js';
import { loadOrCreateServerConfig, readClientConfig } from './config.js';
import { createSendOnlyBridge } from './server.js';

const HELP = `Usage:
  chatgpt-send health
  chatgpt-send send --file PROMPT.txt
  chatgpt-send send --new-chat --file PROMPT.txt
  chatgpt-send send --message "prompt text"
  printf "prompt text" | chatgpt-send send
  chatgpt-send serve

Exit codes: 0 success, 2 config/input, 3 extension disconnected, 4 submission failure.`;

function jsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function cliError(code, message, exitCode = 2) {
  return Object.assign(new Error(message), { code, exitCode });
}

async function readStdin(stream) {
  stream.setEncoding('utf8');
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

function optionValue(args, name) {
  const matches = args.reduce((indices, value, index) => value === name ? [...indices, index] : indices, []);
  if (matches.length > 1) throw cliError('invalid_arguments', `${name} may only be used once`);
  const [index = -1] = matches;
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw cliError('invalid_arguments', `${name} requires a value`);
  return args[index + 1];
}

function booleanOption(args, name) {
  const matches = args.filter((value) => value === name);
  if (matches.length > 1) throw cliError('invalid_arguments', `${name} may only be used once`);
  return matches.length === 1;
}

function validateOptions(args, allowedValues, allowedBooleans = []) {
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (allowedBooleans.includes(option)) continue;
    if (!allowedValues.includes(option)) throw cliError('invalid_arguments', `Unknown option: ${option}`);
    index += 1;
  }
}

async function promptFromArgs(args, stdin) {
  const file = optionValue(args, '--file');
  const message = optionValue(args, '--message');
  if (file && message) throw cliError('invalid_arguments', 'Use only one of --file or --message');
  if (file) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch { throw cliError('prompt_file_unreadable', `Prompt file is not readable: ${file}`); }
  }
  if (message) return message;
  if (!stdin.isTTY) return readStdin(stdin);
  throw cliError('message_required', 'Provide --file, --message, or stdin');
}

async function serve({ stdout }) {
  const config = loadOrCreateServerConfig();
  const bridge = createSendOnlyBridge({
    ...config,
    logger(event, details) {
      jsonLine(stdout, { event, ...details });
    },
  });
  try { await bridge.listen(config.port); }
  catch (error) {
    if (error?.code === 'EADDRINUSE') throw cliError('bridge_already_running', `Port ${config.port} is already in use`);
    throw error;
  }
  jsonLine(stdout, { ok: true, mode: 'send-only', listening: bridge.httpUrl, configPath: config.configPath });

  async function shutdown() {
    await bridge.close();
    process.exit(0);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

export async function runCli(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  try {
    if (command === 'serve') {
      validateOptions(args, []);
      return await serve({ stdout });
    }
    if (command === 'health') validateOptions(args, ['--timeout-ms']);
    else if (command === 'send') validateOptions(args, ['--file', '--message', '--timeout-ms'], ['--new-chat']);
    else throw cliError('invalid_arguments', `Unknown command: ${command}`);
    const timeoutValue = optionValue(args, '--timeout-ms');
    const timeoutMs = timeoutValue === null ? undefined : Number(timeoutValue);
    if (timeoutValue !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 100)) {
      throw cliError('invalid_arguments', '--timeout-ms must be a number of at least 100');
    }
    const prompt = command === 'send' ? await promptFromArgs(args, stdin) : null;
    const newChat = command === 'send' && booleanOption(args, '--new-chat');
    const config = readClientConfig();
    const client = createSendOnlyClient({
      ...config,
      timeoutMs,
    });
    if (command === 'health') {
      jsonLine(stdout, await client.health());
      return 0;
    }
    if (command === 'send') {
      jsonLine(stdout, await client.send(prompt, { newChat }));
      return 0;
    }
  } catch (error) {
    jsonLine(stderr, {
      ok: false,
      error: String(error.code || 'cli_error'),
      message: String(error.message || 'Unknown error'),
    });
    return Number(error.exitCode) || 4;
  }
}

export async function main() {
  return runCli(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
