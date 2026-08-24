const NEW_CHAT_URL = 'https://chatgpt.com/?model=auto';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validTabId(value) {
  return Number.isInteger(value) && value > 0;
}

function assertFreshChatUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('New ChatGPT tab has an invalid URL'); }
  if (url.origin !== 'https://chatgpt.com' || url.pathname.startsWith('/c/')) {
    throw new Error('New ChatGPT tab resolved to an existing conversation');
  }
}

function assertNotExistingConversation(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { return; }
  if (url.origin === 'https://chatgpt.com' && url.pathname.startsWith('/c/')) {
    throw new Error('New ChatGPT tab resolved to an existing conversation');
  }
}

function isNoReceiverError(error) {
  return /receiving end does not exist/i.test(String(error?.message || error || ''));
}

export function createPromptHandler({
  tabs,
  chatGptUrls = ['https://chatgpt.com/*'],
  sleep = delay,
  now = Date.now,
  readyTimeoutMs = 20_000,
  retryIntervalMs = 200,
} = {}) {
  if (!tabs) throw new TypeError('tabs adapter is required');

  async function selectExistingTab() {
    const candidates = await tabs.query({ url: chatGptUrls });
    return candidates.find((tab) => tab.active) || candidates[0] || null;
  }

  async function waitForNewTabComplete(tabId) {
    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      let tab;
      try {
        tab = await tabs.get(tabId);
      } catch (error) {
        throw new Error(`New ChatGPT tab became unavailable: ${error?.message || error}`);
      }
      if (!tab || !validTabId(tab.id)) throw new Error('New ChatGPT tab became unavailable');
      assertNotExistingConversation(tab.url);
      if (tab.status === 'complete') {
        assertFreshChatUrl(tab.url);
        return deadline;
      }
      await sleep(retryIntervalMs);
    }
    throw new Error('New ChatGPT tab loading timed out');
  }

  async function submitToTab(tabId, command) {
    const result = await tabs.sendMessage(tabId, {
      type: 'prompt.submit',
      commandId: String(command.commandId || ''),
      message: String(command.message || ''),
    });
    if (!result?.submitted) throw new Error(String(result?.error || 'Prompt was not submitted'));
    return { type: 'prompt.submitted', commandId: command.commandId, submitted: true, tabId };
  }

  async function submitToNewTab(tabId, command, deadline) {
    while (now() < deadline) {
      const tab = await tabs.get(tabId);
      if (!tab || !validTabId(tab.id)) throw new Error('New ChatGPT tab became unavailable');
      assertFreshChatUrl(tab.url);
      try {
        return await submitToTab(tabId, command);
      } catch (error) {
        if (!isNoReceiverError(error)) throw error;
        await sleep(retryIntervalMs);
      }
    }
    throw new Error('New ChatGPT tab content receiver was not available before timeout');
  }

  return async function handlePrompt(command) {
    if (command?.newChat === true) {
      const created = await tabs.create({ url: NEW_CHAT_URL, active: false });
      if (!validTabId(created?.id)) throw new Error('Chrome did not return a valid new ChatGPT tab ID');
      const exactTabId = created.id;
      const deadline = await waitForNewTabComplete(exactTabId);
      return submitToNewTab(exactTabId, command, deadline);
    }
    const tab = await selectExistingTab();
    if (!validTabId(tab?.id)) throw new Error('No ChatGPT tab is open');
    return submitToTab(tab.id, command);
  };
}
