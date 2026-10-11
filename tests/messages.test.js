/**
 * Hoverleser tests: the background script's messages other than lookups and
 * import: settings, and opening a word on LEO.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./harness.js');

test('open-leo opens LEO\'s result page for the whole word', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'open-leo', word: ' außerbörsliche ' });
  assert.deepEqual(bg.openedTabs.map(t => t.url), [
    'https://dict.leo.org/german-english/au%C3%9Ferb%C3%B6rsliche',
  ]);
});

test('open-leo opens nothing for a missing, empty, or overlong word', async () => {
  const bg = loadBackground();
  for (const word of [undefined, 42, '', '   ', 'x'.repeat(201)]) {
    assert.equal(await bg.send({ type: 'open-leo', word }), null);
  }
  assert.deepEqual(bg.openedTabs, []);
});

test('open-leo cannot be pointed at another site', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'open-leo', word: 'https://example.com/', url: 'https://example.com/' });
  assert.equal(bg.openedTabs[0].url, 'https://dict.leo.org/german-english/https%3A%2F%2Fexample.com%2F');
});

test('the popup settings are stored, and defaulted when missing or invalid', async () => {
  const bg = loadBackground();
  const defaults = await bg.send({ type: 'get-settings' });
  assert.equal(defaults.keepOpen, false);
  assert.equal(defaults.showLeo, true);

  await bg.send({ type: 'set-settings', settings: { ...defaults, keepOpen: true, showLeo: false } });
  const saved = await bg.send({ type: 'get-settings' });
  assert.equal(saved.keepOpen, true);
  assert.equal(saved.showLeo, false);

  await bg.send({ type: 'set-settings', settings: { ...defaults, keepOpen: 'yes', showLeo: 0 } });
  const cleaned = await bg.send({ type: 'get-settings' });
  assert.equal(cleaned.keepOpen, false);
  assert.equal(cleaned.showLeo, true);
});
