/**
 * Hoverleser tests: word lookup, through the same messages the extension
 * sends, against the mini dictionary in tests/fixtures.
 *
 *   npm test
 */
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBackground, summarize, caseOf, caseId } = require('./harness.js');
const spec = require('./fixtures/lookups.json');

const MINI = path.join(__dirname, 'fixtures', 'mini-dict.jsonl');
let harness;

before(async () => {
  harness = loadBackground();
  await harness.importDictionary(MINI);
});

for (const group of spec.groups) {
  test(group.name, async t => {
    for (const c of group.words.map(caseOf)) {
      await t.test(caseId(c), async st => {
        const actual = summarize(await harness.lookup(c.word, c));
        st.diagnostic(actual);   // the result, for the log written by tests/reporter.mjs
        assert.equal(actual, spec.expect[caseId(c)]);
      });
    }
  });
}

test('every sample word on the tester page has an expectation', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.html'), 'utf8');
  const samples = [...html.matchAll(/class="sample-word">([^<]+)</g)].map(m => m[1]);
  assert.ok(samples.length > 0);
  assert.deepEqual(samples.filter(word => !(word in spec.expect)), []);
});

const entriesOf = async (word, opts) => (await harness.lookup(word, opts)).segments.flatMap(s => s.entries);
const firstGloss = entry => entry.s[0].gl[0];

test('readings that share a key keep their own word, gender, and senses', async () => {
  const [noun, verb] = await entriesOf('Leben');
  assert.deepEqual([noun.w, noun.p, noun.g], ['Leben', 'noun', 'n']);
  assert.deepEqual([verb.w, verb.p], ['leben', 'verb']);
  assert.match(firstGloss(noun), /^life/);
  assert.match(firstGloss(verb), /^to live/);
});

test('an inflected form points at the reading it belongs to', async () => {
  const [bench, bank] = await entriesOf('Bank');
  assert.match(firstGloss(bench), /^bench/);
  assert.match(firstGloss(bank), /^bank/);
  assert.match(firstGloss((await entriesOf('Bänke'))[0]), /^bench/);
  assert.match(firstGloss((await entriesOf('Banken'))[0]), /^bank/);
});

test('a derived word is described as itself, built on its base', async () => {
  const [adjective] = (await harness.lookup('außerbörsliche')).segments[1].entries;
  assert.equal(adjective.w, 'Börse');
  assert.deepEqual({ ...adjective.derivation }, { word: 'börslich', p: 'adj', suffix: 'lich' });

  const [noun] = await entriesOf('Absperrungen');
  assert.deepEqual({ ...noun.derivation }, { word: 'Absperrung', p: 'noun', g: 'f', suffix: 'ung' });
  assert.deepEqual([...noun.gramTags], ['plural']);
});

test('a word the dictionary derives from another is headed by itself, not guessed', async () => {
  const [entry] = await entriesOf('Kindlein');
  assert.equal(entry.w, 'Kind');
  assert.deepEqual({ ...entry.derivation }, { word: 'Kindlein', p: 'noun', g: 'n', relation: 'diminutive' });
  assert.equal(entry.inferred, undefined);
});

test('capitalization decides between a noun compound and a derived adjective', async () => {
  assert.equal((await harness.lookup('Unehrenhaft')).segments.length, 2);
  const [adjective] = await entriesOf('unehrenhaft');
  assert.deepEqual([adjective.derivation.word, adjective.derivation.p], ['unehrenhaft', 'adj']);
});

test('a guessed match is flagged and carries only tags the affixes prove', async () => {
  const [entry] = await entriesOf('gehandeltes');
  assert.equal(entry.inferred, true);
  assert.deepEqual([...entry.gramTags], ['participle', 'past']);

  const [derived] = await entriesOf('börslich');
  assert.equal(derived.inferred, true);
  assert.deepEqual([...derived.gramTags], []);

  const [recorded] = await entriesOf('Häuser');
  assert.equal(recorded.inferred, undefined);
});

test('compound segments cover the hovered word exactly', async () => {
  for (const word of ['Hochzeitsband', 'Gänsefeder', 'Donaudampfschifffahrtsgesellschaft', 'hinbringen']) {
    const { segments } = await harness.lookup(word);
    assert.ok(segments.length > 1, word);
    assert.equal(segments.map(s => s.matchedText).join(''), word);
    for (const segment of segments) assert.deepEqual(Object.keys(segment).sort(), ['entries', 'matchedText']);
  }
});

test('results carry no internal fields', async () => {
  for (const word of ['Leben', 'Bank', 'Sprachen', 'Hochzeitsband']) {
    for (const entry of await entriesOf(word)) {
      assert.equal('_b' in entry, false);
      assert.equal('_extra' in entry, false);
    }
  }
});

test('only German words are deinflected or split', async () => {
  const other = loadBackground();
  await other.send({ type: 'import-file-start', langCode: 'fr', lang: 'French', totalEntries: 2 });
  await other.send({ type: 'import-file-chunk', langCode: 'fr', done: true, meta: null, data: [
    { k: 'porte', w: 'porte', p: 'noun', s: [{ gl: ['door'] }] },
    { k: 'monnaie', w: 'monnaie', p: 'noun', s: [{ gl: ['change, currency'] }] },
  ] });
  const ask = word => other.send({ type: 'lookup', word, langCode: 'fr' });
  assert.equal(summarize(await ask('porte')), '[porte] porte(noun)');
  assert.equal(await ask('portemonnaie'), null);
  assert.equal(await ask('portes'), null);
});

test('a dictionary in the format of older builds still imports and resolves', async () => {
  const old = loadBackground();
  await old.send({ type: 'import-file-start', langCode: 'de', lang: 'German', totalEntries: 1 });
  await old.send({ type: 'import-file-chunk', langCode: 'de', done: true, meta: { version: '2025-01' }, data: [
    // forms as plain strings, as written before tags were kept
    { k: 'haus', w: 'Haus', p: 'noun', g: 'n', s: [{ gl: ['house'] }], f: ['häuser', 'hauses', 'dem haus'] },
  ] });
  assert.equal(summarize(await old.lookup('Häuser')), '[Häuser] Haus(noun)');
  const status = await old.send({ type: 'db-status', langCode: 'de' });
  assert.equal(status.meta.version, '2025-01');
  assert.equal(status.meta.formCount, 2, 'the multi-word form is not stored');
});
