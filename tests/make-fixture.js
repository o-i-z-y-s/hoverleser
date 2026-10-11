#!/usr/bin/env node
/**
 * Hoverleser tests: rebuilds tests/fixtures/mini-dict.jsonl, and with
 * --update also the expectations in tests/fixtures/lookups.json, from a full
 * dictionary.
 *
 *   node tests/make-fixture.js --dict src/dist/de.jsonl.gz [--update]
 *
 * The mini dictionary holds exactly the lines the fixture lookups read, so the
 * test suite runs in a second without the 14 MB dictionary. A lookup behaves
 * the same against it as against the full dictionary as long as it reads the
 * same keys; this script checks that before it writes anything.
 *
 * Run it after changing the lookup code, the fixture words, or the dictionary.
 * Without --update it fails when an expectation no longer matches, and prints
 * the difference.
 *
 * Entries built from tests/fixtures/kaikki-sample.jsonl replace the full
 * dictionary's lines for the same keys, so the cases for words with several
 * readings (Leben, Bank) do not depend on which dictionary build is used.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { loadBackground, dictionaryLines, summarize, caseOf, caseId } = require('./harness.js');
const { processEntry, createDeduper } = require('../src/scripts/build-dict.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const LOOKUPS  = path.join(FIXTURES, 'lookups.json');
const MINI     = path.join(FIXTURES, 'mini-dict.jsonl');
const SAMPLE   = path.join(FIXTURES, 'kaikki-sample.jsonl');
// Lemmas kept per form: enough to trip MAX_FORM_REFS in background.js.
const LEMMAS_PER_FORM = 30;

/** Processed entries for the raw sample, as build-dict.js would write them. */
function buildSample() {
  const { accept } = createDeduper();
  return fs.readFileSync(SAMPLE, 'utf8').split('\n').filter(Boolean)
    .map(line => processEntry(JSON.parse(line), true))
    .filter(entry => entry && accept(entry));
}

/** The full dictionary's entries, with the sample replacing its keys. */
async function* mergedEntries(dictPath, sample) {
  const sampleKeys = new Set(sample.map(e => e.k));
  for await (const line of dictionaryLines(dictPath)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.type !== 'meta' && !sampleKeys.has(obj.k)) yield obj;
  }
  yield* sample;
}

async function* asLines(entries) {
  yield JSON.stringify({ type: 'meta', lang: 'German', langCode: 'de', version: 'fixture' });
  for await (const entry of entries) yield JSON.stringify(entry);
}

async function runCases(harness, cases) {
  const out = new Map();
  for (const c of cases) {
    out.set(caseId(c), summarize(await harness.lookup(c.word, c)));
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dictPath = args[args.indexOf('--dict') + 1];
  const update = args.includes('--update');
  if (!args.includes('--dict') || !dictPath) {
    console.error('usage: node tests/make-fixture.js --dict <dictionary .jsonl or .jsonl.gz> [--update]');
    process.exit(1);
  }

  const spec   = JSON.parse(fs.readFileSync(LOOKUPS, 'utf8'));
  const cases  = spec.groups.flatMap(g => g.words.map(caseOf));
  const sample = buildSample();

  // 1. Full dictionary: run the lookups and record every key they read.
  const read = { entries: new Set(), forms: new Set() };
  let recording = false;
  const full = loadBackground({ onAccess: (store, key, hit) => { if (recording && hit) read[store]?.add(key); } });
  console.log('Importing the full dictionary…');
  await full.importDictionary(asLines(mergedEntries(dictPath, sample)));
  recording = true;
  const fullResults = await runCases(full, cases);
  recording = false;

  // 2. Keep the lines behind those keys; trim their forms to the ones read.
  const perForm = new Map();
  const kept = [];
  for await (const entry of mergedEntries(dictPath, sample)) {
    const forms = (entry.f ?? []).filter(f => {
      const form = typeof f === 'string' ? f : f.f;
      if (!read.forms.has(form)) return false;
      const n = perForm.get(form) ?? 0;
      if (n >= LEMMAS_PER_FORM) return false;
      perForm.set(form, n + 1);
      return true;
    });
    if (!read.entries.has(entry.k) && forms.length === 0) continue;
    const { f, ...rest } = entry;
    kept.push(forms.length > 0 ? { ...rest, f: forms } : rest);
  }

  // 3. The mini dictionary must answer every lookup exactly as the full one did.
  const mini = loadBackground();
  await mini.importDictionary(asLines(kept));
  const miniResults = await runCases(mini, cases);
  const drift = [...fullResults].filter(([id, text]) => miniResults.get(id) !== text);
  if (drift.length > 0) {
    for (const [id, text] of drift) console.error(`${id}\n  full: ${text}\n  mini: ${miniResults.get(id)}`);
    throw new Error(`${drift.length} lookups differ between the full and the mini dictionary`);
  }

  // 4. Compare with, or rewrite, the expectations.
  const expected = spec.expect ?? {};
  const changed = [...fullResults].filter(([id, text]) => expected[id] !== text);
  for (const [id, text] of changed) console.log(`${id}\n  - ${expected[id] ?? '(none)'}\n  + ${text}`);
  if (changed.length > 0 && !update) {
    throw new Error(`${changed.length} expectations differ; review them, then rerun with --update`);
  }

  spec.expect = Object.fromEntries(fullResults);
  fs.writeFileSync(LOOKUPS, JSON.stringify(spec, null, 2) + '\n');
  fs.writeFileSync(MINI,
    JSON.stringify({ type: 'meta', lang: 'German', langCode: 'de', version: 'fixture', entryCount: kept.length }) + '\n' +
    kept.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`\n${cases.length} lookups, ${kept.length} dictionary lines → ${path.relative(process.cwd(), MINI)}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
