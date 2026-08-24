import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPromptHandler } from '../tools/chrome-send-only-extension/backgroundPrompt.js';

function command(newChat = true) {
  return { type: 'prompt.submit', commandId: 'command-1', message: 'do the work', newChat };
}

function controlledClock() {
  let value = 0;
  return { now: () => value, sleep: async (ms) => { value += ms; } };
}

test('new-chat retries only no-receiver delivery and gets one receiver response on the exact tab', async () => {
  const calls = [];
  let deliveries = 0;
  const tabs = {
    async create(options) { calls.push(['create', options]); return { id: 91 }; },
    async get(id) { calls.push(['get', id]); return { id, status: 'complete', url: 'https://chatgpt.com/' }; },
    async query() { calls.push(['query']); return [{ id: 7, active: true }]; },
    async sendMessage(id, message) {
      calls.push(['sendMessage', id, message.type]);
      deliveries += 1;
      if (deliveries < 3) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { submitted: true };
    },
  };
  const clock = controlledClock();
  const result = await createPromptHandler({ tabs, ...clock })(command());

  assert.deepEqual(result, { type: 'prompt.submitted', commandId: 'command-1', submitted: true, tabId: 91 });
  assert.deepEqual(calls[0], ['create', { url: 'https://chatgpt.com/?model=auto', active: false }]);
  assert.deepEqual(calls.filter(([name]) => name === 'sendMessage').map(([, id]) => id), [91, 91, 91]);
  assert.equal(calls.some(([name]) => name === 'query'), false);
});

test('legacy submission still selects the active existing ChatGPT tab without retry policy', async () => {
  const sent = [];
  const tabs = {
    async query() { return [{ id: 8, active: false }, { id: 9, active: true }]; },
    async sendMessage(id, message) { sent.push([id, message.type]); return { submitted: true }; },
  };
  const result = await createPromptHandler({ tabs })(command(false));
  assert.equal(result.tabId, 9);
  assert.deepEqual(sent, [[9, 'prompt.submit']]);
});

test('new-chat does not retry after a receiver responds submitted false', async () => {
  let sends = 0;
  const tabs = {
    async create() { return { id: 101 }; },
    async get(id) { return { id, status: 'complete', url: 'https://chatgpt.com/' }; },
    async sendMessage() { sends += 1; return { submitted: false, error: 'composer rejected prompt' }; },
  };
  await assert.rejects(createPromptHandler({ tabs })(command()), /composer rejected prompt/i);
  assert.equal(sends, 1);
});

test('new-chat does not retry an unknown sendMessage error', async () => {
  let sends = 0;
  const tabs = {
    async create() { return { id: 102 }; },
    async get(id) { return { id, status: 'complete', url: 'https://chatgpt.com/' }; },
    async sendMessage() { sends += 1; throw new Error('Extension context invalidated'); },
  };
  await assert.rejects(createPromptHandler({ tabs })(command()), /context invalidated/i);
  assert.equal(sends, 1);
});

test('new-chat retry fails closed if the exact tab redirects to an existing conversation', async () => {
  let gets = 0;
  let sends = 0;
  const tabs = {
    async create() { return { id: 202 }; },
    async get(id) {
      gets += 1;
      return { id, status: 'complete', url: gets < 3 ? 'https://chatgpt.com/' : 'https://chatgpt.com/c/existing' };
    },
    async query() { throw new Error('old tab selector must not run'); },
    async sendMessage() {
      sends += 1;
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  };
  const clock = controlledClock();
  await assert.rejects(createPromptHandler({ tabs, ...clock })(command()), /existing conversation/i);
  assert.equal(sends, 1);
});

test('new-chat creation failure never selects an old tab', async () => {
  let queried = false;
  const tabs = {
    async create() { throw new Error('create failed'); },
    async query() { queried = true; return [{ id: 4, active: true }]; },
  };
  await assert.rejects(createPromptHandler({ tabs })(command()), /create failed/i);
  assert.equal(queried, false);
});

test('new-chat tolerates an empty loading URL before the fresh root completes', async () => {
  let gets = 0;
  const tabs = {
    async create() { return { id: 301 }; },
    async get(id) {
      gets += 1;
      return gets === 1
        ? { id, status: 'loading', url: '' }
        : { id, status: 'complete', url: 'https://chatgpt.com/' };
    },
    async sendMessage() { return { submitted: true }; },
  };
  const clock = controlledClock();
  const result = await createPromptHandler({ tabs, ...clock })(command());
  assert.equal(result.tabId, 301);
});

test('new-chat fails immediately when a loading tab already points to a conversation', async () => {
  let sends = 0;
  const tabs = {
    async create() { return { id: 302 }; },
    async get(id) { return { id, status: 'loading', url: 'https://chatgpt.com/c/existing' }; },
    async sendMessage() { sends += 1; return { submitted: true }; },
  };
  await assert.rejects(createPromptHandler({ tabs })(command()), /existing conversation/i);
  assert.equal(sends, 0);
});

test('new-chat rejects a completed tab outside the ChatGPT origin', async () => {
  let sends = 0;
  const tabs = {
    async create() { return { id: 303 }; },
    async get(id) { return { id, status: 'complete', url: 'chrome://newtab/' }; },
    async sendMessage() { sends += 1; return { submitted: true }; },
  };
  await assert.rejects(createPromptHandler({ tabs })(command()), /existing conversation/i);
  assert.equal(sends, 0);
});
