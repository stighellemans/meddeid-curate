import assert from 'node:assert/strict';
import test from 'node:test';

import { isAppleDevice, shortcutModifier } from '../../src/platform-shortcuts.js';

test('platform shortcuts use Command only on Apple devices', () => {
  assert.equal(isAppleDevice({ platform: 'MacIntel' }), true);
  assert.equal(isAppleDevice({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), true);
  assert.equal(shortcutModifier({ platform: 'MacIntel' }), '⌘');
});

test('platform shortcuts use Ctrl on Windows and Linux', () => {
  assert.equal(isAppleDevice({ platform: 'Win32' }), false);
  assert.equal(isAppleDevice({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false);
  assert.equal(shortcutModifier({ platform: 'Win32' }), 'Ctrl+');
  assert.equal(shortcutModifier({ platform: 'Linux x86_64' }), 'Ctrl+');
});
