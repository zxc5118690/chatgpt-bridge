import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(root, 'tools', 'chrome-send-only-extension');

test('extension has a minimal permission and script surface', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.content_scripts.flatMap((entry) => entry.js), ['content.js']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.options_page, 'options.html');
});

test('legacy full bridge manifest is inert if the wrong folder is loaded', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'chrome-bridge-extension', 'manifest.json'), 'utf8'));
  assert.match(manifest.name, /^DISABLED/);
  assert.deepEqual(manifest.permissions, []);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('content runtime contains no assistant-output selectors or recovery surface', () => {
  const source = fs.readFileSync(path.join(extensionRoot, 'content.js'), 'utf8');
  for (const forbidden of [
    'data-message-author-role="assistant"',
    'responseParser',
    'observed-turn',
    'recover-latest',
    'artifact',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test('composer writing uses verified paste, native, execCommand, and textContent strategies', () => {
  const source = fs.readFileSync(path.join(extensionRoot, 'content.js'), 'utf8');
  assert.match(source, /new DataTransfer\(\)/);
  assert.match(source, /Object\.getOwnPropertyDescriptor\(prototype, 'value'\)/);
  assert.match(source, /execCommand\('insertText'/);
  assert.match(source, /element\.textContent = message/);
  assert.match(source, /const attempts = \[setByPaste, setByNativeValue, setByExecCommand, setByTextContent\]/);
  assert.match(source, /if \(composerContains\(element, message\)\) return/);
  assert.match(source, /replace\(\/\\s\+\/g, ' '\)/);
});

test('published package excludes the legacy full bridge runtime', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.files, [
    'bin/send-only-bridge.js',
    'src/send-only/',
    'tools/chrome-send-only-extension/',
    'README-SEND-ONLY.md',
  ]);
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['express', 'ws']);
});
