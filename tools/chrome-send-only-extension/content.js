const COMPOSER_SELECTORS = [
  '#prompt-textarea[contenteditable]:not([contenteditable="false"])',
  'textarea#prompt-textarea',
  'form [role="textbox"][contenteditable]:not([contenteditable="false"])',
  'form textarea[name="prompt-textarea"]',
];
const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
  'button[title*="Send" i]',
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function findComposer() {
  return COMPOSER_SELECTORS
    .map((selector) => document.querySelector(selector))
    .find((element) => visible(element) && !element.disabled && !element.readOnly) || null;
}

function composerText(element) {
  return String(element?.value ?? element?.innerText ?? element?.textContent ?? '').trim();
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function composerContains(element, message) {
  const expected = normalizedText(message).slice(0, 200);
  return Boolean(expected) && normalizedText(composerText(element)).includes(expected);
}

function setComposerText(element, message) {
  element.focus();
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(element, message);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.execCommand('insertText', false, message)) {
      range.deleteContents();
      range.insertNode(document.createTextNode(message));
    }
    selection?.removeAllRanges();
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function findSendButton(composer) {
  const root = composer.closest('form') || document;
  return SEND_SELECTORS
    .map((selector) => root.querySelector(selector))
    .find((element) => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true') || null;
}

async function waitForComposer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = findComposer();
    if (composer) return composer;
    await delay(200);
  }
  throw new Error('ChatGPT composer was not found');
}

async function waitForSubmission(composer, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!composer.isConnected || !composerContains(composer, message)) return;
    await delay(100);
  }
  throw new Error('Prompt submission could not be confirmed');
}

async function submitPrompt(message) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Prompt is empty');
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new Error('Prompt is too large');
  const composer = await waitForComposer();
  setComposerText(composer, text);
  await delay(150);
  if (!composerContains(composer, text)) throw new Error('Prompt text was not accepted by the composer');
  const sendButton = findSendButton(composer);
  if (sendButton) sendButton.click();
  else {
    const form = composer.closest('form');
    if (form?.requestSubmit) form.requestSubmit();
    else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }
  await waitForSubmission(composer, text);
  return { submitted: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendReply) => {
  if (message?.type !== 'prompt.submit') return false;
  void submitPrompt(message.message)
    .then(() => sendReply({ submitted: true }))
    .catch((error) => sendReply({ submitted: false, error: error.message || String(error) }));
  return true;
});
