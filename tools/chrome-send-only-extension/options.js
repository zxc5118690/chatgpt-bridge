const serverUrl = document.querySelector('#server-url');
const bridgeToken = document.querySelector('#bridge-token');
const statusNode = document.querySelector('#status');

async function refresh() {
  const saved = await chrome.storage.local.get(['serverUrl', 'bridgeToken', 'bridgeStatus']);
  serverUrl.value = saved.serverUrl || 'http://127.0.0.1:8080';
  bridgeToken.value = saved.bridgeToken || '';
  const status = saved.bridgeStatus || {};
  statusNode.textContent = `狀態：${status.status || '尚未連線'}${status.detail ? `\n${status.detail}` : ''}`;
}

document.querySelector('#save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    serverUrl: String(serverUrl.value || '').trim().replace(/\/$/, ''),
    bridgeToken: String(bridgeToken.value || '').trim(),
  });
  await chrome.runtime.sendMessage({ type: 'bridge.reconnect' });
  await refresh();
});

chrome.storage.onChanged.addListener(() => void refresh());
void refresh();
