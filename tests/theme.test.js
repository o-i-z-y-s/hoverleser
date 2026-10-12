/**
 * Hoverleser tests: the color palette in src/lib/theme.js is the only place
 * colors are written, and every color the stylesheets use is defined there.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const read = file => fs.readFileSync(path.join(SRC, file), 'utf8');
const STYLED = ['popup.html', 'content.js'];

const sandbox = { document: { currentScript: null } };
sandbox.globalThis = sandbox;
vm.runInNewContext(read('lib/theme.js'), sandbox);
const { colors } = sandbox.hoverleserTheme;

test('every var(--name) in the stylesheets is a palette color', () => {
  for (const file of STYLED) {
    const used = [...read(file).matchAll(/var\(--([\w-]+)\)/g)].map(m => m[1]);
    assert.ok(used.length > 0, file);
    assert.deepEqual([...new Set(used.filter(name => !(name in colors)))], [], file);
  }
});

test('no color is written outside the palette', () => {
  for (const file of STYLED) {
    const literals = read(file).match(/(?<![&\w])#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [];
    assert.deepEqual(literals, [], file);
  }
});

test('the content script loads the palette first in both manifests', () => {
  for (const file of ['manifest.firefox.json', 'manifest.chrome.json']) {
    const js = JSON.parse(read(file)).content_scripts[0].js;
    assert.ok(js.indexOf('lib/theme.js') !== -1 && js.indexOf('lib/theme.js') < js.indexOf('content.js'), file);
  }
});
