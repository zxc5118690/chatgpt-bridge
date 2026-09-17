import { createPromptHandler } from './backgroundPrompt.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080';
const CHATGPT_URLS = ['https://chatgpt.com/*'];
let socket = null;
let reconnectTimer = null;

function setStatus(status, detail = '') {
  void chrome.storage.local.set({ bridgeStatus: { status, detail, updatedAt: Date.now() } });
}

async function readConfig() {
  const saved = await chrome.storage.local.get(['serverUrl', 'bridgeToken']);
  return {
    serverUrl: String(saved.serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, ''),
    bridgeToken: String(saved.bridgeToken || ''),
  };
}

function websocketUrl(serverUrl, bridgeToken) {
  const url = new URL('/extension/ws', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', bridgeToken);
  return url.toString();
}

const handlePrompt = createPromptHandler({ tabs: chrome.tabs, chatGptUrls: CHATGPT_URLS });

async function handleServerMessage(raw) {
  let command;
  try { command = JSON.parse(String(raw)); } catch { return; }
  if (command.type === 'bridge.ping') {
    socket?.send(JSON.stringify({ type: 'bridge.pong' }));
    return;
  }
  if (command.type !== 'prompt.submit') return;
  try {
    socket?.send(JSON.stringify(await handlePrompt(command)));
  } catch (error) {
    socket?.send(JSON.stringify({
      type: 'prompt.failed',
      commandId: String(command.commandId || ''),
      error: error.message || String(error),
    }));
  }
}

async function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  const config = await readConfig();
  if (!config.bridgeToken) {
    setStatus('not_configured', 'Open extension options and paste the bridge token');
    return;
  }
  setStatus('connecting');
  try {
    socket = new WebSocket(websocketUrl(config.serverUrl, config.bridgeToken));
  } catch (error) {
    setStatus('error', error.message || String(error));
    reconnectTimer = setTimeout(connect, 2_000);
    return;
  }
  socket.onopen = () => {
    setStatus('connected');
    socket.send(JSON.stringify({ type: 'client.hello', mode: 'send-only' }));
  };
  socket.onmessage = (event) => void handleServerMessage(event.data);
  socket.onerror = () => setStatus('error', 'WebSocket connection failed');
  socket.onclose = () => {
    socket = null;
    setStatus('disconnected');
    reconnectTimer = setTimeout(connect, 2_000);
  };
}

// MV3 service worker 閒置會被回收，socket onclose 的 setTimeout 跟著消失。
// 用 alarms 當看門狗：worker 每分鐘被叫醒一次，發現沒連線就重連。
const WATCHDOG_ALARM = 'bridge.watchdog';
function socketAlive() {
  return socket !== null && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN);
}
function armWatchdog() {
  void chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  if (!socketAlive()) void connect();
});
chrome.runtime.onStartup.addListener(() => { armWatchdog(); void connect(); });
chrome.runtime.onInstalled.addListener(() => { armWatchdog(); void chrome.runtime.openOptionsPage(); });
chrome.runtime.onMessage.addListener((message, _sender, sendReply) => {
  if (message?.type !== 'bridge.reconnect') return false;
  void connect().then(() => sendReply({ ok: true }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.serverUrl || changes.bridgeToken)) void connect();
});
armWatchdog();
void connect();
