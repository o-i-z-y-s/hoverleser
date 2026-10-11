/**
 * Hoverleser tests: the dictionary build script, on a small hand-written
 * sample in kaikki.org's format (tests/fixtures/kaikki-sample.jsonl).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processEntry, createDeduper, isFormOfEntry, MAX_READINGS } = require('../src/scripts/build-dict.js');

const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'kaikki-sample.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line));
const rawEntry = (word, pos) => raw.find(e => e.word === word && e.pos === pos);
const formsOf = entry => Object.fromEntries((entry.f ?? []).map(f => [f.f, f.t]));

test('processEntry keeps real forms and drops table metadata and phrases', () => {
  const forms = formsOf(processEntry(rawEntry('leben', 'verb'), true));
  assert.deepEqual(Object.keys(forms), ['lebt', 'lebte', 'gelebt', 'lebten']);
  for (const junk of ['weak', 'de-conj', 'haben', 'habe gelebt']) assert.equal(junk in forms, false, junk);
});

test('processEntry stores the simple past under one tag name', () => {
  const forms = formsOf(processEntry(rawEntry('leben', 'verb'), true));
  assert.deepEqual(forms.lebte, ['past']);
  assert.deepEqual(forms.lebten, ['first-person', 'indicative', 'plural', 'past']);
});

test('processEntry reads gender, pronunciation, and display word', () => {
  const entry = processEntry(rawEntry('Leben', 'noun'), true);
  assert.deepEqual([entry.k, entry.w, entry.p, entry.g, entry.i], ['leben', 'Leben', 'noun', 'n', '/ˈleːbən/']);
  assert.equal(entry.s[0].t.includes('neuter'), false, 'gender is stored once, as g');
});

test('processEntry leaves the word itself out of its forms, and skips forms on request', () => {
  assert.equal('leben' in formsOf(processEntry(rawEntry('Leben', 'noun'), true)), false);
  assert.equal(processEntry(rawEntry('Leben', 'noun'), false).f, undefined);
});

test('processEntry rejects entries without a usable gloss', () => {
  assert.equal(processEntry(rawEntry('Xyz', 'noun'), true), null);
  assert.equal(processEntry({ pos: 'noun', senses: [{ glosses: ['thing'] }] }, true), null);
});

test('isFormOfEntry tells stubs from definitions', () => {
  assert.equal(isFormOfEntry(processEntry(rawEntry('bitte', 'verb'), true)), true);
  assert.equal(isFormOfEntry(processEntry(rawEntry('bitte', 'intj'), true)), false);
  assert.equal(isFormOfEntry({ s: [{ gl: ['cause of death'] }] }), false);
  assert.equal(isFormOfEntry({ s: [{ gl: ['agent noun of regeln', 'regulator'] }] }), false);
  assert.equal(isFormOfEntry({ s: [] }), false);
});

const real = (k, p, forms = 0) => ({ k, p, s: [{ gl: ['a definition'] }], f: Array.from({ length: forms }, (_, i) => ({ f: `${k}${i}`, t: [] })) });
const stub = (k, forms = 0) => ({ ...real(k, 'verb', forms), s: [{ gl: [`inflection of ${k}n:`] }] });

test('the deduper writes every real reading of a key, up to the limit', () => {
  const { accept, counts } = createDeduper();
  const written = Array.from({ length: MAX_READINGS + 2 }, (_, i) => accept(real('ton', `pos${i}`, 1)));
  assert.deepEqual(written, [...Array(MAX_READINGS).fill(true), false, false]);
  assert.deepEqual(counts, { entryCount: 1, formCount: MAX_READINGS, readingCount: MAX_READINGS - 1 });
});

test('the deduper lets a definition replace a stub, and drops later stubs', () => {
  const { accept, counts } = createDeduper();
  assert.equal(accept(stub('bitte', 3)), true);
  assert.equal(accept(stub('bitte', 5)), false, 'a second stub for the key');
  assert.equal(accept(real('bitte', 'intj', 1)), true, 'replaces the stub');
  assert.equal(accept(real('bitte', 'noun', 2)), true, 'a further reading');
  assert.equal(accept(stub('bitte')), false, 'a stub after a definition');
  assert.deepEqual(counts, { entryCount: 1, formCount: 3, readingCount: 1 });
});

test('the sample builds to the expected lines', () => {
  const { accept, counts } = createDeduper();
  const lines = raw.map(e => processEntry(e, true)).filter(e => e && accept(e)).map(e => `${e.w}/${e.p}`);
  assert.deepEqual(lines, [
    'leben/verb', 'Leben/noun', 'mensch/pron', 'Mensch/noun', 'Bank/noun', 'Bank/noun',
    'Morgen/noun', 'morgen/adv', 'essen/verb', 'Essen/noun', 'weg/adv', 'Weg/noun',
    'bitte/verb', 'bitte/intj', 'Bitte/noun', 'Sonne/noun',
  ]);
  assert.equal(counts.entryCount, 8);
  assert.equal(counts.readingCount, 7);
});
