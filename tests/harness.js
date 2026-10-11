/**
 * Hoverleser tests: loads src/background.js into a sandbox with a stand-in
 * `browser` API and IndexedDB, then talks to it through the same runtime
 * messages the popup and content script send. `internal()` additionally
 * evaluates an expression inside the sandbox, for unit tests of pure helpers
 * such as parseFormOf.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const zlib = require('zlib');
const readline = require('readline');
const { createFakeIndexedDB } = require('./fake-idb.js');

const EXTENSION_PAGE = { url: 'chrome-extension://hoverleser-test/popup.html' };
const BATCH = 500;

/**
 * @param {object} [opts]
 * @param {string} [opts.background]  path to background.js (default: src/background.js)
 * @param {Function} [opts.onAccess]  forwarded to the fake IndexedDB
 */
function loadBackground(opts = {}) {
  const file = opts.background ?? path.join(__dirname, '..', 'src', 'background.js');
  let onMessage = null;
  const stored = {};
  const openedTabs = [];
  const indexedDB = createFakeIndexedDB(opts.onAccess);

  const browser = {
    runtime: {
      onMessage:   { addListener: fn => { onMessage = fn; } },
      onInstalled: { addListener: () => {} },
      getURL: p => `chrome-extension://hoverleser-test/${p}`,
    },
    storage: { local: {
      get: async () => ({ ...stored }),
      set: async obj => { Object.assign(stored, structuredClone(obj)); },
    } },
    tabs: { create: async props => { openedTabs.push(props); return { id: openedTabs.length }; } },
  };

  const context = vm.createContext({
    browser, indexedDB, console, setTimeout, clearTimeout, queueMicrotask, structuredClone,
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });

  const send = msg => Promise.resolve(onMessage(msg, EXTENSION_PAGE));

  /**
   * Import a dictionary the way popup.js does.
   * @param {string|AsyncIterable<string>} source  a .jsonl or .jsonl.gz path, or its lines
   */
  async function importDictionary(source, langCode = 'de') {
    const lines = typeof source === 'string' ? dictionaryLines(source) : source;

    let meta = null, started = false, batch = [];
    const start = async () => {
      await send({ type: 'import-file-start', langCode, lang: 'German', totalEntries: meta?.entryCount ?? 0 });
      started = true;
    };
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'meta') { meta = obj; continue; }
      if (!started) await start();
      batch.push(obj);
      if (batch.length >= BATCH) {
        await send({ type: 'import-file-chunk', langCode, data: batch, meta: null, done: false });
        batch = [];
      }
    }
    if (!started) await start();
    await send({ type: 'import-file-chunk', langCode, data: batch, meta, done: true });
    return (await send({ type: 'db-status', langCode })).meta;
  }

  /**
   * @param {string} word
   * @param {object} [opts]
   * @param {boolean} [opts.sentenceInitial]  the word starts a sentence
   * @param {boolean} [opts.hidden]  look the word up as if it had no entry of
   *        its own, which is how a compound's split is tested when the
   *        dictionary happens to list the compound
   */
  async function lookup(word, { sentenceInitial = false, hidden = false } = {}) {
    const msg = { type: 'lookup', word, langCode: 'de', sentenceInitial };
    if (!hidden) return send(msg);
    await send({ type: 'db-status', langCode: 'de' });   // make sure the DB is open
    const rows = indexedDB.databases.get('hoverleser-de').stores.get('entries').rows;
    const key = word.toLowerCase().normalize('NFC');
    const saved = rows.get(key);
    rows.delete(key);
    try { return await send(msg); }
    finally { if (saved !== undefined) rows.set(key, saved); }
  }

  /** Evaluate an expression inside the sandbox (pure helpers only). */
  const internal = code => vm.runInContext(code, context);

  return { send, lookup, importDictionary, internal, indexedDB, openedTabs };
}

/** The lines of a .jsonl or .jsonl.gz file. */
function dictionaryLines(dictPath) {
  let input = fs.createReadStream(dictPath);
  if (dictPath.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  return readline.createInterface({ input, crlfDelay: Infinity });
}

/** One line per lookup result; the format the fixture expectations use. */
function summarize(result) {
  if (!result) return 'null';
  return result.segments.map(seg =>
    `[${seg.matchedText}] ` + seg.entries.map(e => {
      const tags = e.gramTags?.length ? `{${e.gramTags.join(',')}}` : '';
      const word = e.derivation
        ? `${e.derivation.word}(${e.derivation.p})<${e.w}+-${e.derivation.suffix}`
        : `${e.w}(${e.p ?? '?'})`;
      return `${word}${tags}${e.inferred ? '~' : ''}`;
    }).join(' / ')
  ).join(' || ');
}

/** A fixture case as written in lookups.json: a word, or { word, ...options }. */
const caseOf = c => (typeof c === 'string' ? { word: c } : c);
const caseId = c => c.word + (c.sentenceInitial ? ' (sentence-initial)' : '') + (c.hidden ? ' (entry hidden)' : '');

module.exports = { loadBackground, dictionaryLines, summarize, caseOf, caseId };
