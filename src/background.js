/**
 * hoverleser – Background Script
 *
 * Responsibilities:
 *   • Open and manage the IndexedDB dictionary database
 *   • Handle 'lookup' messages from content scripts → instant local DB query
 *   • Handle 'db-status' messages → report ready/loading/empty state
 *   • Handle 'import-file-start' / 'import-file-chunk' → stream-import a local JSONL file
 *   • Handle 'clear-db' → remove an imported dictionary
 *   • Handle 'get-settings' / 'set-settings' → persist user preferences
 *   • Handle 'open-leo' → open LEO's result page for a word in a new tab
 *
 * DB Schema (one DB per language, named "hoverleser-{langCode}"):
 *   Object store "entries":  keyPath="k" (lowercase lemma)
 *     { k, w, p, g, s, i, _extra? }
 *       k       – lowercase lookup key   (string)
 *       w       – display word           (string, original casing)
 *       p       – part of speech         (string)
 *       g       – grammatical gender     (string|null, "m"/"f"/"n")
 *       s       – senses                 (Array<{gl:string[], t?:string[], ft?:string[]}>)
 *                   gl = glosses, t = sense tags, ft = tags of a form-of sense
 *       i       – IPA pronunciation      (string|null)
 *       _extra  – further readings that share the key: another part of speech
 *                 (Leben noun + leben verb) or another etymology (Bank "bench"
 *                 + Bank "bank"). Each element is {w,p,g,s,i} (optional).
 *     A record's readings are called "blocks": block 0 is the record itself,
 *     and block n is _extra[n-1].
 *
 *   Object store "forms":    keyPath="f" (lowercase inflected form)
 *     { f, l }
 *       f  – lowercase form         (string)
 *       l  – lemma references       ({k:string, t:string[], b?:number}[])
 *              k = lemma key, t = grammatical tags of this form,
 *              b = block the form belongs to (omitted for block 0)
 *
 *   Object store "meta":     keyPath="k"
 *     { k: "info", lang, langCode, version, entryCount, formCount, importedAt }
 */

'use strict';

// Chrome MV3 runs the background as a service worker where `browser` is not
// defined. Import the webextension-polyfill so the rest of this file can use
// the same browser.* API as the Firefox build.
if (typeof browser === 'undefined') importScripts('lib/browser-polyfill.min.js');

const SUPPORTED_LANGS = ['de', 'fr', 'es', 'nl', 'it', 'pt', 'ru', 'zh', 'ja'];

// LEO's German-English result page for a search term. The extension only ever
// opens this page when the user clicks the LEO button; it never queries LEO.
const LEO_SEARCH_URL = 'https://dict.leo.org/german-english/';

// ── DB registry: langCode → IDBDatabase ───────────────────────────────────
const openDbs = new Map();
const DB_VERSION = 1;

function dbName(langCode) {
  return `hoverleser-${langCode}`;
}

/**
 * Open (or return cached) IDBDatabase for a language code.
 * Creates the object stores on first open.
 */
function openDb(langCode) {
  if (openDbs.has(langCode)) return Promise.resolve(openDbs.get(langCode));

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(langCode), DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('entries')) {
        db.createObjectStore('entries', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('forms')) {
        db.createObjectStore('forms', { keyPath: 'f' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };

    req.onsuccess = e => {
      const db = e.target.result;
      openDbs.set(langCode, db);
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

/** Promisified IDB get on any store. Keys are NFC-normalized automatically. */
function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const normKey = typeof key === 'string' ? key.normalize('NFC') : key;
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(normKey);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/** Promisified IDB put (upsert). */
function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** Clear all entries in a store. */
function idbClear(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Read-only view of one language DB for the duration of a single lookup.
 *
 * Every read is memoized, so a compound split that probes the same key from
 * several prefix lengths costs one request, and all reads share one
 * transaction instead of opening one each. `splits` memoizes compound
 * analyses of word tails for the same reason.
 */
function createReader(db) {
  const memo = new Map();
  let tx = null;

  const request = (storeName, key) => new Promise((resolve, reject) => {
    let req;
    try {
      if (!tx) tx = db.transaction(['entries', 'forms'], 'readonly');
      req = tx.objectStore(storeName).get(key);
    } catch {
      // The shared transaction has already committed; continue on a new one.
      tx  = db.transaction(['entries', 'forms'], 'readonly');
      req = tx.objectStore(storeName).get(key);
    }
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });

  return {
    splits: new Map(),
    /** Resolves to the stored record, or null. Callers must not mutate it. */
    get(storeName, key) {
      const normKey = key.normalize('NFC');
      const memoKey = `${storeName}\u0000${normKey}`;
      if (!memo.has(memoKey)) memo.set(memoKey, request(storeName, normKey));
      return memo.get(memoKey);
    },
  };
}

// ── Form-of glosses ────────────────────────────────────────────────────────
// Wiktionary describes many entries only by their relation to another word:
// "plural of Wort", "inflection of weit:", "obsolete spelling of Tür". Such an
// entry is a stub; the lookup shows the word it points to instead.
//
// build-dict.js carries a copy of parseFormOf and its two word lists, because
// the build script and the extension do not share a module.
// tests/formof-sync.test.js fails if the two copies drift apart.

// Words that describe an inflection of the base word.
const INFLECTION_WORDS = new Set([
  'inflection', 'inflected', 'form', 'degree', 'and', 'or',
  'singular', 'plural',
  'nominative', 'accusative', 'dative', 'genitive',
  'masculine', 'feminine', 'neuter',
  'strong', 'weak', 'mixed',
  'comparative', 'superlative',
  'first-person', 'second-person', 'third-person',
  'first', 'second', 'third',   // "first/third-person" splits into "first" + "third-person"
  'present', 'past', 'preterite', 'perfect', 'future',
  'indicative', 'subjunctive', 'i', 'ii', 'imperative', 'dependent',
  'participle', 'infinitive', 'zu-infinitive',
]);

// Words that describe a different word standing in a fixed relation to the base.
const LEXICAL_WORDS = new Set([
  'alternative', 'obsolete', 'archaic', 'dated', 'deprecated', 'standard',
  'superseded', 'nonstandard', 'informal', 'rare', 'censored', 'pronunciation',
  'eye', 'letter-case', 'switzerland', 'liechtenstein', 'spelling',
  'misspelling', 'female', 'male', 'equivalent', 'diminutive', 'augmentative',
  'agent', 'verbal', 'noun', 'gerund', 'nominalization', 'abbreviation',
  'syllabic', 'initialism', 'clipping', 'ellipsis', 'contraction', 'short',
  'synonym',
]);

// Badge shown for a lexical relation, keyed by the first matching lead word.
const RELATION_LABELS = [
  ['diminutive', 'diminutive'], ['augmentative', 'augmentative'],
  ['female', 'feminine'], ['male', 'masculine'],
  ['agent', 'agent noun'], ['gerund', 'gerund'], ['verbal', 'verbal noun'],
  ['nominalization', 'nominalized'],
  ['abbreviation', 'abbreviation'], ['initialism', 'abbreviation'],
  ['clipping', 'abbreviation'], ['ellipsis', 'abbreviation'], ['short', 'abbreviation'],
  ['contraction', 'abbreviation'],
  ['synonym', 'synonym'],
  ['spelling', 'variant'], ['misspelling', 'variant'], ['form', 'variant'],
];

// Lexical relations whose base is the verb or adjective a noun was built from.
const DEVERBAL_LEADS = new Set(['agent', 'gerund', 'verbal', 'nominalization']);
// Lexical relations that make a word of its own from the base (Kindlein,
// diminutive of Kind), as opposed to another spelling of the same word.
const DERIVED_LEADS = new Set([...DEVERBAL_LEADS, 'diminutive', 'augmentative', 'female', 'male']);

/**
 * Parse a gloss of the shape "<relation words> of <base>".
 *
 * Returns null unless every word before the first "of" is a known relation
 * word, so ordinary definitions that happen to contain "of" ("a municipality
 * of Bavaria", "capital of Germany") are never mistaken for stubs.
 *
 * An inflection may carry a translation after the base ("plural of Sprache:
 * languages"). A lexical relation may only be followed by a "which ..."
 * clause; with anything else after the base it is a definition in its own
 * right ("diminutive of Kasten: a small box") and returns null.
 *
 * `taggedFormOf` says Wiktionary itself marked the sense as a form-of; an
 * inflection gloss is then accepted whatever follows the base.
 *
 * @returns {{lead: string[], base: string, kind: 'inflection'|'lexical'}|null}
 */
function parseFormOf(gloss, taggedFormOf = false) {
  const m = /^((?:[\w./-]+\s+)*?)of\s+(\S+)(.*)$/i.exec((gloss ?? '').trim());
  if (!m) return null;

  const lead = m[1].toLowerCase().split(/\s+/).filter(Boolean);
  if (lead.length === 0) return null;
  const parts = lead.flatMap(w => w.split('/'));
  const kind = parts.every(w => INFLECTION_WORDS.has(w)) ? 'inflection'
             : parts.every(w => INFLECTION_WORDS.has(w) || LEXICAL_WORDS.has(w)) ? 'lexical'
             : null;
  if (!kind) return null;

  const base = m[2].replace(/[:;,.]+$/, '');
  if (!base) return null;
  const clauseEnded = base.length < m[2].length;
  const rest = m[3].trim();
  if (rest && !/^which\b/i.test(rest)) {
    if (kind === 'lexical') return null;
    // "inflection of sich freuen": the base is a phrase, not a single word.
    if (!taggedFormOf && !clauseEnded && !/^[:;,("“„]/.test(rest)) return null;
  }
  return { lead, base, kind };
}

/**
 * parseFormOf for a whole sense. A lexical relation with a sub-gloss
 * (["agent noun of regeln", "regulator"]) has a definition of its own and is
 * not a stub; the sub-gloss of an inflection only spells out the form.
 */
function parseSenseFormOf(sense) {
  const glosses = Array.isArray(sense?.gl) ? sense.gl : [];
  const parsed = parseFormOf(glosses[0], (sense?.t ?? []).includes('form-of'));
  return parsed && parsed.kind === 'lexical' && glosses.length > 1 ? null : parsed;
}

/** True when every sense of a block is a form-of stub. */
function isFormOfBlock(block) {
  const senses = block?.s ?? [];
  return senses.length > 0 && senses.every(s => parseSenseFormOf(s) !== null);
}

/** True when a block has definitions of its own. */
function isRealBlock(block) {
  return (block?.s ?? []).length > 0 && !isFormOfBlock(block);
}

/**
 * True when a block is nothing but an old or variant spelling: every sense is
 * marked alt-of. One such sense among real ones (Mantel, also short for
 * Fahrradmantel) does not make the word a variant.
 */
const isAltOfBlock = block =>
  (block.s ?? []).length > 0 && block.s.every(s => (s.t ?? []).includes('alt-of'));

/**
 * Display word for an extra reading imported before readings stored their own
 * `w`: German nouns and names are capitalized, and everything else is not.
 */
function extraDisplayWord(rec, extra) {
  if (extra.p !== 'noun' && extra.p !== 'name') return rec.k;
  return rec.w !== rec.k ? rec.w : rec.k[0].toUpperCase() + rec.k.slice(1);
}

/** Expand a stored record into its blocks (see the schema note above). */
function entryBlocks(rec) {
  if (!rec) return [];
  const { _extra, ...primary } = rec;
  const blocks = [primary];
  for (const x of (_extra ?? [])) {
    blocks.push({ k: rec.k, w: x.w ?? extraDisplayWord(rec, x), p: x.p, g: x.g ?? null, s: x.s, i: x.i ?? null });
  }
  blocks.forEach((block, n) => { block._b = n; });
  return blocks;
}

/** The block a forms-index reference points at; old references have no `b`. */
function pickBlock(rec, b) {
  const blocks = entryBlocks(rec);
  return blocks[b ?? 0] ?? blocks[0] ?? null;
}

// A forms-index key that lists this many lemmas is not an inflected form but
// table metadata that older dictionary builds stored as one ("haben" as the
// auxiliary of 9,000 verbs, "strong" as a declension class). Untagged
// references are dropped for such keys.
const MAX_FORM_REFS = 24;

/** Normalize a forms-store record to a list of {k, t, b?} references. */
function formRefs(formRec) {
  let stored = formRec?.l ?? [];
  if (stored.length > MAX_FORM_REFS) {
    stored = stored.filter(x => typeof x !== 'string' && x.t?.length > 0).slice(0, MAX_FORM_REFS);
  }
  return stored.map(x => (typeof x === 'string' ? { k: x, t: [] } : { ...x, t: x.t ?? [] }));
}

// ── Lookup logic ───────────────────────────────────────────────────────────

// Tags surfaced as visible badges
const GRAM_DISPLAY_TAGS = new Set([
  'plural','singular',
  'nominative','accusative','dative','genitive',
  'comparative','superlative',
  'past','present','future',
  'first-person','second-person','third-person',
  'indicative','subjunctive','imperative','participle',
]);

// Parts of speech that take case, and the closed classes among them.
const DECLINING_POS = new Set(['noun', 'name', 'adj', 'pron', 'art', 'det']);
const PRONOMINAL_POS = new Set(['pron', 'art', 'det']);
const CASE_TAGS   = new Set(['nominative', 'accusative', 'dative', 'genitive']);
// Part of speech of an entry as shown: a derived word's own, not its base's.
const posOf       = entry => entry.derivation?.p ?? entry.p;
const isNounLike  = entry => posOf(entry) === 'noun' || posOf(entry) === 'name';
const senseCount  = block => (block.s ?? []).length;

/**
 * What the spelling of the hovered word says about its part of speech.
 * German capitalizes every noun, so a lowercase word is not one, and a
 * capitalized word in the middle of a sentence almost always is.
 *
 *   'lower'      starts lowercase
 *   'upper'      capitalized, not at the start of a sentence
 *   'ambiguous'  capitalized at the start of a sentence, ALL CAPS, or camelCase
 */
function caseHint(word, sentenceInitial) {
  const first = word[0] ?? '';
  const rest  = word.slice(1);
  if (first === first.toLowerCase()) return 'lower';
  if (rest !== rest.toLowerCase()) return 'ambiguous';
  return sentenceInitial ? 'ambiguous' : 'upper';
}

/**
 * Order (and for lowercase words, trim) the readings of a single word by what
 * its capitalization implies.
 *
 *   'upper'  nouns and names first.
 *   'lower'  other parts of speech first. Nouns reached only through an
 *            inflected form are dropped when another reading exists: "fragen"
 *            is the verb, not the plural of Frage.
 */
function arrangeByCase(entries, hint) {
  if (hint === 'upper') {
    return [...entries.filter(isNounLike), ...entries.filter(e => !isNounLike(e))];
  }
  if (hint === 'lower') {
    const others = entries.filter(e => !isNounLike(e));
    if (others.length === 0) return entries;
    return [...others, ...entries.filter(e => isNounLike(e) && e.gramTags === undefined)];
  }
  return entries;
}

// ── Derivation and inflection (German) ────────────────────────────────────

// Endings an adjective can take: plain, comparative, and superlative.
const ADJ_ENDS = ['', 'e', 'en', 'em', 'er', 'es',
                  'ere', 'eren', 'erem', 'erer', 'eres',
                  'ste', 'sten', 'stem', 'ster', 'stes'];
const adjEndTags = end => (end.startsWith('st') ? ['superlative'] : end.length > 2 ? ['comparative'] : []);
const adjEnds = Object.fromEntries(ADJ_ENDS.map(end => [end, adjEndTags(end)]));

// Ways a base may be spelled in front of a suffix, from the stem left over.
const asVerb    = s => [s + 'en', s + 'n'];
const asNoun    = s => [s, s + 'e'];
const umlautOff = (spell, s) => (deUmlaut(s) ? spell(deUmlaut(s)) : []);

/**
 * Derivational suffixes. Each forms a word of class `p` (and gender `g`) from
 * a base of a part of speech in `from`, takes the endings in `ends` (ending →
 * the tags it proves), and lists the spellings its base may have (`bases`).
 * `accept` narrows the base further where a suffix is picky: -in makes the
 * feminine of a masculine noun, and -er makes nouns from verbs freely but
 * from nouns mostly in -ik (Forensiker) or from longer ones (Tausender), which
 * keeps English names (Baker, Hunter) out.
 *
 * `capital` suffixes are tried only on a word that may be a noun by its
 * spelling: -er, -in, and -ling also end many English words (water, darling).
 * Where one suffix ends another, the longer one comes first (-lein before
 * -in, -ler before -er), except that -in and -ei come before -erin and -erei:
 * Lehrerin is Lehrer + -in and Bäckerei is Bäcker + -ei when the dictionary
 * has the noun in -er. The present participle (stinkend: stinken + -d) is
 * listed as the suffix -d, which follows an infinitive.
 */
const DERIVATIONS = [
  ...['lich', 'haft', 'sam', 'ig'].map(suffix =>
    ({ suffix, p: 'adj', from: ['noun', 'verb', 'adj'], ends: adjEnds, bases: s => [s + 'en', s + 'e', s, ...umlautOff(asNoun, s)] })),
  { suffix: 'isch', p: 'adj', from: ['noun'], ends: adjEnds, bases: s => [s + 'e', s, ...umlautOff(asNoun, s)] },
  { suffix: 'bar', p: 'adj', from: ['verb', 'noun'], ends: adjEnds, bases: s => [s + 'en', s + 'e', s] },
  { suffix: 'los', p: 'adj', from: ['noun'], ends: adjEnds, bases: s => [s + 'en', s + 'e', s] },
  { suffix: 'd', p: 'adj', from: ['verb'], ends: adjEnds, tags: ['participle', 'present'], bases: s => (/..(?:e|[lr])n$/.test(s) ? [s] : []) },
  { suffix: 'heit', p: 'noun', g: 'f', from: ['adj', 'noun'], ends: { '': [], en: ['plural'] }, bases: s => [s, s + 'en', s + 'e'] },
  { suffix: 'keit', p: 'noun', g: 'f', from: ['adj'], ends: { '': [], en: ['plural'] }, bases: s => [s, s + 'en', s + 'e'] },
  { suffix: 'schaft', p: 'noun', g: 'f', from: ['noun', 'adj', 'verb'], ends: { '': [], en: ['plural'] }, bases: s => [s, s + 'en', s + 'e'] },
  { suffix: 'ung', p: 'noun', g: 'f', from: ['verb'], ends: { '': [], en: ['plural'] }, bases: asVerb },
  { suffix: 'lein', p: 'noun', g: 'n', from: ['noun'], capital: true, ends: { '': [], s: ['genitive'] }, bases: s => [...asNoun(s), ...umlautOff(asNoun, s)] },
  { suffix: 'chen', p: 'noun', g: 'n', from: ['noun'], capital: true, ends: { '': [], s: ['genitive'] }, bases: s => [...asNoun(s), ...umlautOff(asNoun, s)] },
  { suffix: 'in', p: 'noun', g: 'f', from: ['noun'], capital: true, ends: { '': [], nen: ['plural'] }, bases: s => [...asNoun(s), ...umlautOff(asNoun, s)],
    accept: base => base.g === 'm' },
  { suffix: 'erin', p: 'noun', g: 'f', from: ['verb', 'noun'], capital: true, ends: { '': [], nen: ['plural'] }, bases: s => [...asVerb(s), s, ...umlautOff(asVerb, s), ...umlautOff(asNoun, s)] },
  { suffix: 'ler', p: 'noun', g: 'm', from: ['noun'], capital: true, ends: { '': [], n: ['plural'], s: ['genitive'] }, bases: s => (s.length >= 4 ? [s, ...umlautOff(asNoun, s)] : []) },
  { suffix: 'er', p: 'noun', g: 'm', from: ['verb', 'noun'], capital: true, ends: { '': [], n: ['plural'], s: ['genitive'] }, bases: s => [...asVerb(s), s, ...umlautOff(asVerb, s), ...umlautOff(asNoun, s)],
    accept: base => base.p === 'verb' || base.k.length >= 6 || base.k.endsWith('ik') },
  { suffix: 'ist', p: 'noun', g: 'm', from: ['noun'], capital: true, ends: { '': [], en: [] }, bases: s => [s + 'ie', s + 'e', s, s + 'o'] },
  { suffix: 'ei', p: 'noun', g: 'f', from: ['noun'], capital: true, ends: { '': [], en: ['plural'] }, bases: s => (s.endsWith('er') ? [s] : []) },
  { suffix: 'erei', p: 'noun', g: 'f', from: ['verb'], capital: true, ends: { '': [], en: ['plural'] }, bases: s => [...asVerb(s), ...umlautOff(asVerb, s)] },
  { suffix: 'ling', p: 'noun', g: 'm', from: ['verb', 'adj'], capital: true, ends: { '': [], e: ['plural'], en: ['plural'], s: ['genitive'] }, bases: s => [...asVerb(s), s, s + 'e'] },
  { suffix: 'nis', p: 'noun', from: ['verb', 'adj'], capital: true, ends: { '': [], se: ['plural'], sen: ['plural'], ses: ['genitive'] }, bases: s => [...asVerb(s), s] },
  { suffix: 'tum', p: 'noun', g: 'n', from: ['adj', 'noun', 'verb'], capital: true, ends: { '': [], s: ['genitive'], es: ['genitive'] }, bases: s => [s, s + 'e', s + 'en'] },
];

/**
 * Stems of a word built with a derivational suffix, alone or followed by an
 * ending: börsliche = börs + lich + e, Kostbarkeiten = kostbar + keit + en,
 * Forensikern = Forensik + er + n. Each candidate carries a `derivation`
 * describing the derived word itself (börslich, an adjective, by -lich),
 * since that is what was hovered, and `accepts`, which tells whether a block
 * found for the stem can be its base.
 *
 * @param {'lower'|'upper'|'ambiguous'} hint  see caseHint
 */
function derivationStems(word, hint) {
  const w = word.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const d of DERIVATIONS) {
    if (d.capital && hint === 'lower') continue;
    const pos = new Set(d.from);
    const accepts = base => pos.has(base.p) && (!d.accept || d.accept(base));
    for (const [end, endTags] of Object.entries(d.ends)) {
      const tail = d.suffix + end;
      if (!w.endsWith(tail) || w.length - tail.length < 3) continue;
      const lemma = w.slice(0, w.length - end.length);
      const derivation = {
        word: d.p === 'noun' ? lemma[0].toUpperCase() + lemma.slice(1) : lemma,
        p: d.p, ...(d.g && { g: d.g }), suffix: d.suffix,
      };
      const tags = [...(d.tags ?? []), ...endTags];
      for (const stem of d.bases(w.slice(0, -tail.length))) {
        const id = `${d.suffix}\u0000${stem}`;
        if (stem.length < 3 || stem === w || seen.has(id)) continue;
        seen.add(id);
        out.push({ stem, tags, derivation, accepts });
      }
    }
  }
  return out;
}

// Parts of speech that take the adjective endings -er and -em.
const ADJECTIVAL_POS = new Set(['adj', 'pron', 'art', 'det', 'num']);

// Inseparable verb prefixes: their past participles have no ge- (versucht).
const INSEPARABLE = /^(?:be|emp|ent|er|ge|miss|ver|zer)/;

/**
 * Stems of an inflected word that neither the entries nor the forms index
 * know, by stripping inflectional endings and the ge- of a participle.
 *
 * Examples (the stem that ends up matching):
 *   gehandeltes   → ge- and -tes stripped, +n      → handeln
 *   schönsten     → -sten stripped                 → schön
 *   versuchter    → -ter stripped, +en             → versuchen (participle)
 *
 * Returns {stem, tags, accepts?} candidates in priority order (most specific
 * first), never including the word itself. `tags` holds only what the
 * stripped affixes make certain; see inferFromStems for how they are applied.
 * A stem reached by an ending nouns do not take (-er, -ter, -st ...) accepts
 * no noun, and one reached by -er or -em, which no verb form ends in, accepts
 * no verb either: a match of that kind is a coincidence or a derivation
 * (Forensiker, Aufpasser), not an inflected form.
 */
function inflectionStems(word) {
  const w = word.toLowerCase();
  const seenCandidates = new Set([w]);
  const out = [];
  const add = (stem, tags = [], accepts = undefined) => {
    if (stem.length >= 3 && !seenCandidates.has(stem)) {
      seenCandidates.add(stem);
      out.push({ stem, tags, accepts });
    }
  };
  const notNoun = block => block.p !== 'noun';
  const adjectival = block => ADJECTIVAL_POS.has(block.p);

  // ── ge- prefix (past participles used as adjectives) ──────────────────────
  if (w.startsWith('ge') && w.length > 5) {
    const deGe = w.slice(2);
    for (const end of ['sten','stem','ster','stes','ste',
                       'tes','ten','ter','tem','te',
                       'es','en','er','em','e','t','st']) {
      if (deGe.endsWith(end) && deGe.length - end.length >= 3) {
        const base = deGe.slice(0, -end.length);
        // ge-…-t plus an adjective ending is a weak past participle.
        const tags = end.startsWith('t') ? ['participle', 'past'] : [];
        add(base + 'en', tags); // verb infinitive (most common)
        add(base + 'n', tags);
        add(base + 't', tags);  // participle stem
        add(base, tags);
      }
    }
    add(deGe + 'en');
    add(deGe);
  }

  // ── Inflectional endings (adjective agreement + verb conjugation) ─────────
  // Order: longer/more-specific suffixes before shorter ones.
  for (const end of [
    'sten','stem','ster','stes','ste',   // superlative adj
    'tes','ten','ter','tem','te',         // weak/mixed adj or past tense
    'es','en','er','em','e',             // strong adj / gen / plural
    'st','t',                            // verb 2nd/3rd person present
  ]) {
    if (w.endsWith(end) && w.length - end.length >= 3) {
      const base = w.slice(0, -end.length);
      const accepts = end === 'er' || end === 'em' ? adjectival
                    : ['es', 'en', 'e'].includes(end) ? undefined : notNoun;
      // -ter, -tes, -tem can only be a participle with an adjective ending;
      // without ge-, that is a verb with an inseparable prefix or in -ieren.
      const prefix = INSEPARABLE.exec(w)?.[0] ?? '';
      const participle = ['ter', 'tes', 'tem'].includes(end) &&
        ((prefix && base.length - prefix.length >= 3) || base.endsWith('ier'));
      const tags = participle ? ['participle', 'past']
                 : end.startsWith('st') && end.length > 2 ? ['superlative'] : [];
      add(base + 'en', tags, accepts);
      add(base + 'n', tags, accepts);
      add(base + 'e', tags, accepts);
      add(base, tags, accepts);
    }
  }

  return out;
}

// An inferred tag is shown only on the part of speech it can describe.
const INFERRED_TAG_POS = { participle: 'verb', past: 'verb', superlative: 'adj' };

/**
 * Collect the readings of one lowercase candidate from the entries store and
 * the forms index, without any guessing.
 *
 * Forms-index lemmas are annotated as { ...lemmaBlock, gramTags } so the UI
 * shows the lemma with its grammatical role badged. The loop below decides
 * which of them belong next to the word's own entries.
 *
 * @param {'lower'|'upper'|'ambiguous'} hint  see caseHint
 */
async function collectCandidate(reader, candidate, hint) {
  const blocks = entryBlocks(await reader.get('entries', candidate));
  const refs   = formRefs(await reader.get('forms', candidate)).filter(r => r.k !== candidate);
  const primary = blocks[0] ?? null;

  let collected = [...blocks];

  if (primary) {
    const directIsFormOf = isFormOfBlock(primary);
    const directIsAltOf  = isAltOfBlock(primary);
    // The words a stub entry points at ("das" → der).
    const stubBases      = new Set(blocks.filter(isFormOfBlock)
      .flatMap(b => b.s.map(sense => baseKey(parseSenseFormOf(sense).base))));
    const realDirect     = blocks.filter(isRealBlock);

    // An imperative that merely looks like the hovered word ("Haus" as the
    // imperative of hausen) is noise next to a real entry. Keep it only where
    // the spelling leaves the verb plausible: a lowercase word whose direct
    // entries are all nouns ("lauf"), or the first word of a sentence.
    const hideImperative = realDirect.length > 0 && !directIsAltOf && (
      hint === 'upper' || (hint === 'lower' && realDirect.some(b => !isNounLike(b)))
    );

    for (const ref of refs) {
      const lemma = pickBlock(await reader.get('entries', ref.k), ref.b);
      if (!lemma) continue;
      // A lemma with the part of speech of a direct entry competes with it,
      // unless the direct entry is a stub for that lemma or a variant
      // spelling. It is listed only if the hovered word is an inflected form
      // of it and it has at least as many senses: "Karten" is a card game,
      // but first the plural of Karte, while "Essen" is not worth reading as
      // the plural of Esse. Sense count stands in for how common a word is,
      // which the dictionary does not record. Counterparts (Trainerin, whose
      // table names "Trainer" as its masculine) and pronouns (whose tables
      // list one another) never qualify.
      const rivals = blocks.filter(b => b.p === lemma.p);
      if (rivals.length > 0 && !directIsAltOf && !stubBases.has(lemma.k)) {
        const inflected = !PRONOMINAL_POS.has(lemma.p) && ref.t.some(tag => GRAM_DISPLAY_TAGS.has(tag));
        if (!inflected || rivals.some(b => senseCount(b) > senseCount(lemma))) continue;
      }
      // A pronoun or article reached through a case form, when the direct
      // entry is a word that takes no case, is a Wiktionary artifact: the
      // verb "sein" also turns up in the declension tables of du, ich, and
      // wir, as their possessive.
      if (!directIsFormOf && primary.p && !DECLINING_POS.has(primary.p) &&
          PRONOMINAL_POS.has(lemma.p) && ref.t.some(tag => CASE_TAGS.has(tag))) continue;
      if (hideImperative && lemma.p === 'verb' && ref.t.includes('imperative')) continue;
      collected.push({ ...lemma, gramTags: ref.t });
    }

    // A variant-spelling entry is redundant once the lemma it stands for was
    // found through the forms index with the same part of speech.
    const annotatedPos = new Set(collected.filter(e => e.gramTags !== undefined).map(e => e.p));
    collected = collected.filter(e =>
      !(blocks.includes(e) && isAltOfBlock(e) && !isFormOfBlock(e) && annotatedPos.has(e.p))
    );
  } else {
    for (const ref of refs) {
      const lemma = pickBlock(await reader.get('entries', ref.k), ref.b);
      if (lemma) collected.push({ ...lemma, gramTags: ref.t });
    }
  }

  if (collected.length === 0) return [];

  const resolved = await resolveFormOf(reader, collected);

  // One result per block; a derived word beats its plain base, and an
  // annotated copy beats a plain one.
  const best = new Map();
  for (const entry of resolved) {
    const id   = `${entry.k}\u0000${entry.p ?? ''}\u0000${entry._b ?? 0}`;
    const prev = best.get(id);
    if (!prev || (entry.derivation && !prev.derivation) ||
        (!prev.derivation && entry.gramTags?.length && !prev.gramTags?.length)) best.set(id, entry);
  }
  const all = [...best.values()]
    .filter(e => (e.s ?? []).length > 0)
    .map(({ _b, ...rest }) => rest);
  // When a canonical entry exists, drop variant spellings of it.
  const canonical = all.filter(e => !isAltOfBlock(e));
  return canonical.length > 0 ? canonical : all;
}

/**
 * First stem in `stems` that the dictionary knows, as entries marked
 * `inferred: true`.
 *
 * Their gramTags describe only what the stripped affixes make certain; tags
 * that described the stem's own relation to its lemma are discarded, because
 * they do not describe the hovered word. Proper names are skipped: names do
 * not inflect or derive this way, so a name reached by stripping is chance.
 * Unresolved stubs are skipped too, since "plural of X" says nothing about X.
 * A candidate's `accepts`, when present, decides which blocks the stem may
 * match.
 *
 * An entry reached through a derivational suffix keeps its base's senses and
 * gains `derivation` ({ word, p, g?, suffix }): the popup heads it with the
 * derived word, and its tags describe that word, not the base.
 */
async function inferFromStems(reader, stems) {
  for (const { stem, tags, derivation, accepts = () => true } of stems) {
    const viaStem = (await collectCandidate(reader, stem, 'ambiguous'))
      .filter(e => e.p !== 'name' && isRealBlock(e) && accepts(e));
    if (viaStem.length === 0) continue;
    return viaStem.map(e => ({
      ...e,
      gramTags: derivation ? tags : inferredTags(e, tags),
      inferred: true,
      ...(derivation && { derivation }),
    }));
  }
  return [];
}

/**
 * Tags for a block reached by stripping inflectional endings: those the
 * endings prove that fit its part of speech, plus participle tags when the
 * stem itself is a recorded participle (stinkend in stinkende), since an
 * adjective ending does not change that.
 */
function inferredTags(block, tags) {
  const own = block.gramTags ?? [];
  const participle = own.includes('participle') ? own.filter(tag => PARTICIPLE_TAGS.has(tag)) : [];
  return [...new Set([...participle, ...tags.filter(tag => INFERRED_TAG_POS[tag] === block.p)])];
}
const PARTICIPLE_TAGS = new Set(['participle', 'present', 'past']);

/**
 * Look up one lowercase candidate. When nothing is recorded for it, fall back
 * to inflectionStems if `deinflect` is set, and then to derivationStems if
 * `derive` is set too.
 */
async function lookupCandidate(reader, candidate, { hint = 'ambiguous', deinflect = false, derive = false } = {}) {
  const found = await collectCandidate(reader, candidate, hint);
  if (found.length > 0 || !deinflect) return found;
  const inflected = await inferFromStems(reader, inflectionStems(candidate));
  if (inflected.length > 0 || !derive) return inflected;
  return inferFromStems(reader, derivationStems(candidate, hint));
}

// Lead words of an inflection gloss that are badged under another name.
const LEAD_WORD_TAGS = {
  preterite: 'past', first: 'first-person', second: 'second-person', third: 'third-person',
};

/** Badges for a stub block, from its form_of tags and the words of its glosses. */
function stubTags(block, parsed) {
  const tags = new Set();
  for (const sense of (block.s ?? [])) {
    for (const tag of (sense.ft ?? [])) if (GRAM_DISPLAY_TAGS.has(tag)) tags.add(tag);
  }
  for (const { lead, kind } of parsed) {
    if (kind === 'inflection') {
      for (const word of lead.flatMap(w => w.split('/'))) {
        const tag = LEAD_WORD_TAGS[word] ?? word;
        if (GRAM_DISPLAY_TAGS.has(tag)) tags.add(tag);
      }
    } else {
      const label = RELATION_LABELS.find(([word]) => lead.includes(word));
      if (label) tags.add(label[1]);
    }
  }
  return [...tags];
}

/** Lookup key for the base word named in a form-of gloss. */
const baseKey = base => base.toLowerCase().normalize('NFC').replace(/[[\]#|]/g, '').trim();

/** Find the real block a stub points at, or null. */
async function findBase(reader, stub, { base, lead }) {
  const key = baseKey(base);
  if (!key) return null;
  const deverbal = lead.some(word => DEVERBAL_LEADS.has(word));
  const choose = blocks => {
    const real = blocks.filter(isRealBlock);
    return (deverbal ? real.find(b => !isNounLike(b)) : real.find(b => b.p === stub.p)) ?? real[0] ?? null;
  };

  const direct = choose(entryBlocks(await reader.get('entries', key)));
  if (direct) return direct;

  // The base may itself be listed only as a form of its lemma.
  const ref = formRefs(await reader.get('forms', key))[0];
  if (!ref) return null;
  const lemma = pickBlock(await reader.get('entries', ref.k), ref.b);
  return lemma && isRealBlock(lemma) ? lemma : null;
}

/**
 * Replace stub blocks ("plural of Wörterbuch") with the block they point at,
 * annotated with the stub's grammatical role as gramTags.
 *
 * A stub for a word derived from its base (Kindlein: "diminutive of Kind")
 * stands for a word of its own, so the result also gets `derivation`
 * ({ word, p, g?, relation }), and the popup heads it with the stub's word.
 *
 * A stub that arrived through the forms index keeps the tags it arrived with.
 * A stub whose base is already among `entries` adds nothing and is dropped,
 * unless it is a derived word of its own; collectCandidate then keeps the
 * derived reading in place of the plain base.
 * A stub whose base cannot be found is kept as it is: "plural of X" is still
 * worth showing when X has no entry.
 */
async function resolveFormOf(reader, entries) {
  const out = [];

  for (const entry of entries) {
    const parsed = (entry.s ?? []).map(parseSenseFormOf);
    if (parsed.length === 0 || parsed.some(p => p === null)) { out.push(entry); continue; }

    const { kind, lead } = parsed[0];
    const derived = kind === 'lexical' && lead.some(word => DERIVED_LEADS.has(word));
    const key = baseKey(parsed[0].base);
    if (!derived && entries.some(e => e !== entry && e.k === key && !isFormOfBlock(e))) continue;

    const base = await findBase(reader, entry, parsed[0]);
    if (!base) { out.push(entry); continue; }
    // findBase can follow the forms index back to a block that is in hand.
    if (!derived && entries.some(e => e.k === base.k && e._b === base._b && !isFormOfBlock(e))) continue;
    const tags = entry.gramTags ?? stubTags(entry, parsed);
    if (derived) {
      const relation = lead.join(' ');
      const label = RELATION_LABELS.find(([word]) => lead.includes(word))?.[1];
      const derivation = { word: entry.w, p: entry.p, ...(entry.g && { g: entry.g }), relation };
      out.push({ ...base, gramTags: tags.filter(tag => tag !== label), derivation });
    } else {
      out.push({ ...base, gramTags: tags });
    }
  }
  return out;
}

// ── Compound splitting (German) ────────────────────────────────────────────

const MIN_PREFIX = 3;  // allows short but real roots: Bau-, See-, Weg-, Bus-
const MIN_SUFFIX = 3;
// A three-letter part is easy to find by accident inside a foreign word, so
// it is held to stricter rules; see splitAfterShortPrefix and resolveTail.
const SHORT_PART = 3;
// Three-letter separable verb particles. Longer ones (zurück, weiter, herum)
// are ordinary adverbs or prepositions and need no special rule.
const PARTICLES = new Set(['auf', 'aus', 'bei', 'ein', 'her', 'hin', 'los', 'mit', 'ran', 'rum', 'vor', 'weg']);
// Shortest tail that may be a bare verb form or a proper name instead of a
// recorded noun or adjective, and shortest tail after a three-letter prefix.
const MIN_INFERRED_HEAD = 5;
// Shortest tail that may be matched through inflectionStems or
// derivationStems, which strip up to six letters and so need more of the word
// left over to mean anything.
const MIN_DEINFLECTED_HEAD = 6;

// Linking elements (Fugenelemente) between the parts of a compound, longest
// first so a short strip cannot shadow a longer correct one:
//   ens  Herzens+wunsch (Herz)        n   Sonnen+schein (Sonne)
//   es   Tages+licht (Tag)            e   Hunde+hütte (Hund)
//   er   Kinder+garten (Kind)         s   Hochzeits+tag (Hochzeit)
//   en   Studenten+wohnheim (Student)
const LINKERS = ['ens', 'es', 'er', 'en', 'n', 'e', 's'];
// Noun endings that always take -s- before the next part of a compound.
const REGULAR_S_STEM = /(?:ung|heit|keit|schaft|ion|tät|ling|tum)$/;
// Those of them that are never the end of a shorter word (Schwung, Million,
// and Eigentum can end a word in -ung, -ion, and -tum), so a first part in
// one of them without its -s- is no first part at all (Gesundheit + Samt).
const MUST_LINK = /(?:heit|keit|schaft|tät)$/;
// Linking elements that are plural endings and can umlaut the stem
// (Bücher+regal, Gänse+braten), plus none at all (Mütter+beratung).
const UMLAUT_LINKERS = ['er', 'e', ''];

const PREFIX_POS = new Set(['noun', 'name', 'adj', 'verb', 'adv', 'prep', 'num', 'part']);
const POS_RANK   = { noun: 0, name: 1, adj: 2, verb: 3 };
const byPosRank  = (a, b) => (POS_RANK[a.p] ?? 4) - (POS_RANK[b.p] ?? 4);

const strip = ({ _b, ...block }) => block;

/** Undo the umlaut on the last umlauted vowel: büch → buch, häus → haus. */
function deUmlaut(stem) {
  const at = Math.max(stem.lastIndexOf('ä'), stem.lastIndexOf('ö'), stem.lastIndexOf('ü'));
  if (at === -1) return null;
  return stem.slice(0, at) + { 'ä': 'a', 'ö': 'o', 'ü': 'u' }[stem[at]] + stem.slice(at + 1);
}

/** The real blocks stored under a key. */
async function realBlocks(reader, key) {
  return entryBlocks(await reader.get('entries', key)).filter(isRealBlock);
}

/** The real noun block stored under a key, or null. */
async function realNoun(reader, key) {
  return (await realBlocks(reader, key)).find(b => b.p === 'noun') ?? null;
}

/**
 * Any infinitive can serve as a neuter noun (das Leben, das Essen), and the
 * dictionary does not list every such noun separately. Where a noun is
 * expected and only the verb is recorded, the verb stands in for it.
 */
const isInfinitive = block => block.p === 'verb' && block.k.endsWith('n') && isRealBlock(block);

/**
 * The noun a compound prefix is a recorded plural or genitive of (Kinder,
 * Bücher, Tages, Bauern), or null. This is evidence, not a guess: either the
 * forms index lists the prefix under the noun, or the prefix has a stub entry
 * of its own ("Klassen: plural of Klasse"). Dative forms (Kindern) do not
 * link compounds.
 *
 * With `noBareGenitive`, a genitive in -s is not enough. findPrefix asks for
 * that when the prefix is also a word in its own right: a plural is a common
 * linking form and outweighs it (Korallen-, Sonnen-), a genitive -s does not
 * ("trans" is not the genitive of Tran in Transfeindlichkeit). A genitive in
 * -n still counts, because the forms index keeps one tag set per form and
 * the -n of a weak noun (Schützen) is its plural as well.
 */
async function findAttestedNoun(reader, prefix, noBareGenitive) {
  const genitiveCounts = !(noBareGenitive && prefix.endsWith('s'));
  const links = tags => !tags.includes('dative') &&
    (tags.includes('plural') || (tags.includes('genitive') && genitiveCounts));
  const fits = (lemma, tags) => lemma &&
    ((lemma.p === 'noun' && isRealBlock(lemma)) ||
     (tags.includes('genitive') && isInfinitive(lemma)));   // Lebens-, Essens-

  const candidates = [];
  for (const ref of formRefs(await reader.get('forms', prefix))) {
    if (!links(ref.t)) continue;
    const lemma = pickBlock(await reader.get('entries', ref.k), ref.b);
    if (fits(lemma, ref.t)) candidates.push(lemma);
  }
  for (const stub of entryBlocks(await reader.get('entries', prefix))) {
    if (stub.p !== 'noun' || !isFormOfBlock(stub)) continue;
    const parsed = parseSenseFormOf(stub.s[0]);
    const tags = stubTags(stub, [parsed]);
    if (parsed.kind !== 'inflection' || !links(tags)) continue;
    const base = await findBase(reader, stub, parsed);
    if (fits(base, tags)) candidates.push(base);
  }

  // Several nouns can share a form; the one that changes least to get there
  // is the likelier: Sonnen is Sonne + n before it is Sonn + en.
  return candidates.reduce((best, c) => (!best || c.k.length > best.k.length ? c : best), null);
}

/**
 * Work out the word behind a compound prefix that is not recorded in this
 * shape. Returns { blocks, guessed }, or null.
 *
 *   1. Stripping a linking element leaves a noun (Hochzeits → Hochzeit), a
 *      name before -s- (Adams → Adam), or an infinitive before -s-.
 *   2. The same with the plural umlaut undone (Gänse → Gans).
 *   3. The prefix lost its ending: a noun without its final -e, with or
 *      without -s- after it (Sprach → Sprache, Geschichts → Geschichte), or a
 *      verb stem (Schreib → schreiben). Both are returned when both exist.
 *
 * All of these are guesses, with one exception: -s- after a noun in -ung,
 * -heit, -keit, -schaft, -ion, -tät, -ling, or -tum is a rule of the
 * language (Austragungs+ort), so that match is not marked as guessed.
 */
async function guessLinked(reader, prefix) {
  for (const link of LINKERS) {
    if (!prefix.endsWith(link)) continue;
    const stem = prefix.slice(0, -link.length);
    if (stem.length < MIN_PREFIX) continue;
    const blocks = await realBlocks(reader, stem);
    const noun = blocks.find(b => b.p === 'noun');
    if (noun) return { blocks: [noun], guessed: !(link === 's' && REGULAR_S_STEM.test(stem)) };
    const other = link === 's' ? blocks.find(b => b.p === 'name' || isInfinitive(b)) : null;
    if (other) return { blocks: [other], guessed: true };
  }

  for (const link of UMLAUT_LINKERS) {
    if (!prefix.endsWith(link)) continue;
    const stem = deUmlaut(prefix.slice(0, prefix.length - link.length));
    if (!stem || stem.length < MIN_PREFIX) continue;
    const noun = await realNoun(reader, stem);
    if (noun) return { blocks: [noun], guessed: true };
  }

  const shortened = [
    await realNoun(reader, prefix + 'e'),
    (await realBlocks(reader, prefix + 'en')).find(isInfinitive),
  ].filter(Boolean);
  if (shortened.length > 0) return { blocks: shortened, guessed: true };
  if (prefix.endsWith('s') && prefix.length > MIN_PREFIX + 1) {
    const noun = await realNoun(reader, prefix.slice(0, -1) + 'e');
    if (noun) return { blocks: [noun], guessed: true };
  }
  return null;
}

/**
 * Readings for a compound prefix of four letters or more, or null when it is
 * not a plausible one.
 *
 * A prefix is a lemma, never an arbitrary inflected form: "Wörter" alone must
 * not split "Wörterbuchsuche". Nouns win, because the first part of a German
 * compound is a noun far more often than anything else: "Sonnen" in
 * Sonnenliege is Sonne plus -n-, not the verb sonnen. A recorded noun plural
 * therefore overrides a verb, adjective, or name spelled the same, but not a
 * preposition or adverb: "gegen" stays gegen.
 *
 * With `exactOnly`, guessLinked is not tried; only the regular -s- after
 * -ung, -heit, and the like is (Gesundheits+amt, not Gesundheit + Samt).
 *
 * @returns {Promise<{entries: object[], guessed: boolean}|null>}
 */
async function findPrefix(reader, prefix, exactOnly) {
  const direct = (await realBlocks(reader, prefix)).filter(b => PREFIX_POS.has(b.p));
  const recorded = blocks => ({ entries: [...blocks].sort(byPosRank).map(strip), guessed: false });

  if (direct.some(b => b.p === 'noun')) return recorded(direct);
  if (direct.every(b => b.p === 'verb' || b.p === 'adj' || b.p === 'name')) {
    const attested = await findAttestedNoun(reader, prefix, direct.length > 0);
    if (attested) return recorded([attested]);
  }
  if (direct.length > 0) return recorded(direct);
  // -s- after -ung, -heit, and the like is a rule, so it counts as recorded.
  if (prefix.endsWith('s') && REGULAR_S_STEM.test(prefix.slice(0, -1))) {
    const noun = await realNoun(reader, prefix.slice(0, -1));
    if (noun) return recorded([noun]);
  }
  if (exactOnly) return null;
  const linked = await guessLinked(reader, prefix);
  return linked && { entries: linked.blocks.map(strip), guessed: linked.guessed };
}

/** Only the noun readings when there are any; a compound's head is usually one. */
const preferNouns = entries => {
  const nouns = entries.filter(e => posOf(e) === 'noun');
  return nouns.length > 0 ? nouns : entries;
};

/**
 * Segments for the rest of a compound after its prefix, or null.
 *
 * The tail must end in a plausible head: a noun or adjective (inflected or
 * not), a verb lemma or participle, from MIN_INFERRED_HEAD letters up also a
 * proper name or another verb form, and from MIN_DEINFLECTED_HEAD letters up
 * a deinflected stem. Function words never qualify, which is what keeps
 * "Anderson" from reading as ander + so'n.
 */
async function resolveTail(reader, tailWord, exactOnly) {
  const tail  = tailWord.toLowerCase();
  const short = tail.length === SHORT_PART;
  const long  = tail.length >= MIN_INFERRED_HEAD;

  const directHeads = (await realBlocks(reader, tail)).filter(b =>
    b.p === 'noun' || (!short && (b.p === 'adj' || b.p === 'verb' || (long && b.p === 'name')))
  );
  if (directHeads.length > 0) {
    return [{ matchedText: tailWord, entries: preferNouns(directHeads).map(strip) }];
  }
  if (short) return null;

  const guess = !exactOnly && tail.length >= MIN_DEINFLECTED_HEAD;
  const found = await lookupCandidate(reader, tail, { deinflect: guess, derive: guess });
  const heads = found.filter(e =>
    posOf(e) === 'noun' || posOf(e) === 'adj' ||
    (posOf(e) === 'verb' && (long || !e.gramTags?.length || e.gramTags.includes('participle')))
  );
  if (heads.length > 0) return [{ matchedText: tailWord, entries: preferNouns(heads) }];

  return splitCompoundMemo(reader, tailWord, exactOnly);
}

/**
 * Split after a three-letter prefix, which is held to stricter rules than a
 * longer one because three letters match by accident so easily. It is always
 * a lemma as written, never a guess, and one of:
 *
 *   • A separable particle (hin, her, vor ...) before a verb: an infinitive
 *     or participle of any length (hin + bringen, her + gefahren), or a
 *     four-letter finite form (los + geht). Imperatives are excluded, since
 *     a particle verb separates in the imperative ("geh los!").
 *   • A noun, an adjective, or a particle before any other tail of at least
 *     MIN_INFERRED_HEAD letters: Bus + fahrerin, rot + braun, vor + Ionisation.
 */
async function splitAfterShortPrefix(reader, prefix, tailWord, exactOnly) {
  const direct   = (await realBlocks(reader, prefix)).filter(b => PREFIX_POS.has(b.p));
  const particle = PARTICLES.has(prefix);
  const readings = particle ? direct : direct.filter(b => b.p === 'noun' || b.p === 'adj');
  if (readings.length === 0 || tailWord.length === SHORT_PART) return null;
  const first = blocks => ({ matchedText: prefix, entries: [...blocks].sort(byPosRank).map(strip) });
  const long  = tailWord.length >= MIN_INFERRED_HEAD;

  if (particle) {
    const asParticle = readings.filter(b => b.p !== 'noun');
    const verbs = (await lookupCandidate(reader, tailWord.toLowerCase()))
      .filter(e => e.p === 'verb' && !e.gramTags?.includes('imperative'));
    const nonFinite = verbs.filter(e =>
      !e.gramTags?.length || e.gramTags.includes('participle') || e.gramTags.includes('infinitive'));
    const chosen = nonFinite.length > 0 ? nonFinite : long ? [] : verbs;
    if (asParticle.length > 0 && chosen.length > 0) {
      return [first(asParticle), { matchedText: tailWord, entries: chosen }];
    }
  }

  if (!long) return null;
  const tailSegments = await resolveTail(reader, tailWord, exactOnly);
  return tailSegments && [first(readings), ...tailSegments];
}

/**
 * Split a word that has no entry of its own into dictionary words.
 *
 * Every split point is tried: the prefix must resolve (findPrefix, or
 * splitAfterShortPrefix at three letters) and so must the tail (resolveTail),
 * which may itself be a compound. The cheapest analysis wins (see splitCost).
 * If no split resolves completely, the word counts as not found instead of
 * being shown truncated.
 *
 * There are two passes: one that accepts only parts the dictionary records as
 * written (exactOnly), and one that also guesses linking elements and
 * deinflects tails. A split made of recorded words therefore beats a longer
 * prefix that had to be guessed (Deutsch + Tümelei, not "Deutschtüme" + Lei),
 * and a guess beats a chain of accidental short words (Fuß + Abstreifer, not
 * Fuß + ABS + "treifer").
 *
 * @returns {Promise<Array<{matchedText: string, entries: object[], guessed?: boolean}>|null>}
 */
async function splitCompound(reader, word) {
  const exact = await splitCompoundMemo(reader, word, true);
  // Two recorded parts of four letters or more cannot be beaten.
  const best = exact && splitCost(exact) <= 2.1
    ? exact
    : cheaper(exact, await splitCompoundMemo(reader, word, false));
  return best;
}

const cheaper = (a, b) => (!a || !b ? a ?? b : splitCost(b) < splitCost(a) ? b : a);

/**
 * Cost of a compound analysis; lower is better.
 *
 *   1     per part: fewer, longer parts are likelier to be the real ones
 *   0.5   per three-letter part, the kind most often matched by accident
 *   0.4   per prefix whose linking element was guessed
 *   1     when the last part is a deinflected stem, the weakest evidence
 *   0.1   when the last part has no noun reading; most compounds are nouns
 */
function splitCost(segments) {
  const last = segments[segments.length - 1];
  return segments.length
    + 0.5 * segments.filter(seg => seg.matchedText.length === SHORT_PART).length
    + 0.4 * segments.filter(seg => seg.guessed).length
    + (last.entries.some(e => e.inferred) ? 1 : 0)
    + (last.entries.some(e => posOf(e) === 'noun') ? 0 : 0.1);
}

function splitCompoundMemo(reader, word, exactOnly) {
  const memoKey = `${exactOnly ? 'exact' : 'loose'}\u0000${word}`;
  if (!reader.splits.has(memoKey)) reader.splits.set(memoKey, splitCompoundPass(reader, word, exactOnly));
  return reader.splits.get(memoKey);
}

async function splitCompoundPass(reader, word, exactOnly) {
  const lower = word.toLowerCase();
  let best = null, bestCost = Infinity;

  // Longest prefix first, so that on equal cost the longer prefix is kept.
  for (let len = lower.length - MIN_SUFFIX; len >= MIN_PREFIX; len--) {
    const tailWord = word.slice(len);
    let segments;

    if (len === SHORT_PART) {
      segments = await splitAfterShortPrefix(reader, lower.slice(0, len), tailWord, exactOnly);
      if (!segments) continue;
      segments = [{ ...segments[0], matchedText: word.slice(0, len) }, ...segments.slice(1)];
    } else {
      if (MUST_LINK.test(lower.slice(0, len))) continue;
      const prefix = await findPrefix(reader, lower.slice(0, len), exactOnly);
      if (!prefix) continue;
      // A guessed linking element in front of a three-letter tail is two
      // weak matches in a row ("Minnes" + OTA in Minnesota).
      if (prefix.guessed && tailWord.length === SHORT_PART) continue;
      const tailSegments = await resolveTail(reader, tailWord, exactOnly);
      if (!tailSegments) continue;
      segments = [{ matchedText: word.slice(0, len), ...prefix }, ...tailSegments];
    }

    const cost = splitCost(segments);
    if (cost < bestCost) { best = segments; bestCost = cost; }
  }
  return best;
}

/** Whether an analysis's head reading agrees with the word's capitalization. */
function nounByCase(segments, hint) {
  if (hint === 'ambiguous') return true;
  const noun = segments[segments.length - 1].entries.some(e => posOf(e) === 'noun');
  return noun === (hint === 'upper');
}

/**
 * Look up a word in the DB.
 *
 * Priority order (always biased toward the full word):
 *
 *   1. The word itself: its entry, plus lemmas it is an inflected form of.
 *   2. German only: a stem reached by inflectionStems.
 *   3. German only: the cheaper of a compound split (see splitCompound) and a
 *      derivation of the whole word (see derivationStems), scored alike by
 *      splitCost. Where one analysis is a noun and the other is not, the
 *      word's capitalization decides (Unehrenhaft is Unehre + Haft, but
 *      unehrenhaft is an adjective in -haft); otherwise a split into recorded
 *      words wins a tie (Spieltisch is Spiel + Tisch, not an adjective in
 *      -isch). Other languages do not share the closed-compound convention or
 *      its linking elements.
 *
 * Returns null if nothing is found, or { segments: [{ matchedText, entries }] }
 * with one segment per compound part. `matchedText` is the slice of the
 * hovered word a segment covers, linking element included ("Hochzeits" for
 * the entry Hochzeit).
 *
 * @param {boolean} [sentenceInitial]  the word starts a sentence (see caseHint)
 */
async function lookupWord(db, word, langCode = 'de', sentenceInitial = false) {
  const reader = createReader(db);
  const german = langCode === 'de';
  const hint   = german ? caseHint(word, sentenceInitial) : 'ambiguous';

  const full = await lookupCandidate(reader, word.toLowerCase(), { hint, deinflect: german });
  if (full.length > 0) {
    return { segments: [{ matchedText: word, entries: arrangeByCase(full, hint) }] };
  }
  if (!german) return null;

  const derived = await inferFromStems(reader, derivationStems(word, hint));
  const whole = derived.length > 0 ? [{ matchedText: word, entries: derived }] : null;
  const split = await splitCompound(reader, word);
  const best = !split || !whole ? split ?? whole
             : nounByCase(split, hint) !== nounByCase(whole, hint) ? (nounByCase(split, hint) ? split : whole)
             : splitCost(split) <= splitCost(whole) ? split : whole;
  return best && { segments: best.map(({ guessed, ...segment }) => segment) };
}

// ── Metadata helpers ───────────────────────────────────────────────────────

async function getDbMeta(langCode) {
  try {
    const db = await openDb(langCode);
    return await idbGet(db, 'meta', 'info');
  } catch {
    return null;
  }
}

async function setDbMeta(db, meta) {
  return idbPut(db, 'meta', { k: 'info', ...meta });
}

// ── Settings ───────────────────────────────────────────────────────────────

async function getSettings() {
  const result = await browser.storage.local.get('settings');
  // Merge stored settings over defaults so any missing key uses a safe fallback
  // rather than potentially reverting enabled:false → enabled:true.
  return Object.assign(defaultSettings(), result.settings ?? {});
}

function defaultSettings() {
  return {
    enabled:    false,
    langCode:   'de',
    showIpa:    true,
    showTags:   true,
    showGender: true,
    maxSenses:  3,
    keepOpen:   false,   // the popup can be moved onto and clicked
    showLeo:    true,    // the popup has a "Look up on LEO" button
  };
}

// ── Message router ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  // Extension pages (the toolbar popup, or popup.html opened as a tab) always have
  // a sender.url beginning with the extension scheme. Content scripts running in
  // web pages have http/https URLs. Use the URL (not sender.tab) as the
  // authoritative signal, because popup.html opened as a tab carries sender.tab
  // but is still a trusted extension page.
  const isExtensionPage =
    typeof sender.url === 'string' &&
    (sender.url.startsWith('moz-extension://') ||
     sender.url.startsWith('chrome-extension://'));
  const extensionOnly = () =>
    isExtensionPage
      ? null
      : Promise.reject(new Error('Permission denied'));

  switch (msg.type) {

    // ── Word lookup ──────────────────────────────────────────────────────
    case 'lookup': {
      const word = msg.word;
      if (typeof word !== 'string' || word.length === 0 || word.length > 200) {
        return Promise.resolve(null);
      }
      const langCode = SUPPORTED_LANGS.includes(msg.langCode) ? msg.langCode : 'de';
      const sentenceInitial = msg.sentenceInitial === true;
      return openDb(langCode).then(db => lookupWord(db, word, langCode, sentenceInitial));
    }

    // ── DB status ────────────────────────────────────────────────────────
    case 'db-status': {
      const { langCode } = msg;
      return getDbMeta(langCode).then(meta => ({
        ready:      !!meta,
        meta:       meta ?? null,
        importing:  importSession.langCode === langCode
          ? { status: importSession.status, done: importSession.entryCount,
              total: importSession.total, error: importSession.error }
          : null,
      }));
    }

    // ── Settings ─────────────────────────────────────────────────────────
    case 'get-settings': {
      return getSettings();
    }

    case 'set-settings': {
      const denied = extensionOnly();
      if (denied) return denied;
      // Validate and sanitize every field before persisting.
      // This prevents a malicious content-script message from corrupting settings.
      const raw = msg.settings ?? {};
      const safe = {
        enabled:    typeof raw.enabled    === 'boolean' ? raw.enabled    : false,
        langCode:   SUPPORTED_LANGS.includes(raw.langCode) ? raw.langCode : 'de',
        showIpa:    typeof raw.showIpa    === 'boolean' ? raw.showIpa    : true,
        showTags:   typeof raw.showTags   === 'boolean' ? raw.showTags   : true,
        showGender: typeof raw.showGender === 'boolean' ? raw.showGender : true,
        maxSenses:  Number.isInteger(raw.maxSenses) && raw.maxSenses >= 1 && raw.maxSenses <= 10
                      ? raw.maxSenses : 3,
        keepOpen:   typeof raw.keepOpen   === 'boolean' ? raw.keepOpen   : false,
        showLeo:    typeof raw.showLeo    === 'boolean' ? raw.showLeo    : true,
      };
      return browser.storage.local.set({ settings: safe }).then(() => ({ ok: true }));
    }

    // ── Look a word up on LEO ────────────────────────────────────────────
    // The URL is built here, so a message can open nothing but a LEO search.
    case 'open-leo': {
      const word = typeof msg.word === 'string' ? msg.word.trim() : '';
      if (word.length === 0 || word.length > 200) return Promise.resolve(null);
      const nextToSender = sender.tab ? { openerTabId: sender.tab.id, index: sender.tab.index + 1 } : {};
      return browser.tabs.create({ url: LEO_SEARCH_URL + encodeURIComponent(word), ...nextToSender })
        .then(() => ({ ok: true }));
    }

    // ── Clear / reset DB ─────────────────────────────────────────────────
    case 'clear-db': {
      const denied = extensionOnly();
      if (denied) return denied;
      if (importSession.status === 'running') {
        return Promise.reject(new Error('Cannot clear while import is in progress'));
      }
      const { langCode } = msg;
      return openDb(langCode).then(async db => {
        await idbClear(db, 'entries');
        await idbClear(db, 'forms');
        await idbClear(db, 'meta');
        return { ok: true };
      });
    }

    case 'import-file-start': {
      const denied = extensionOnly();
      if (denied) return denied;
      const { langCode, lang, totalEntries } = msg;
      return startImportFromFileStream(langCode, lang, totalEntries)
        .then(() => ({ ok: true }))
        .catch(err => { importSession.status = 'error'; importSession.error = err.message; throw err; });
    }

    case 'import-file-chunk': {
      const denied = extensionOnly();
      if (denied) return denied;
      const { data, meta, done } = msg;
      return receiveFileChunk(data, meta ?? null, done)
        .then(() => ({ ok: true }))
        .catch(err => { importSession.status = 'error'; importSession.error = err.message; throw err; });
    }
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(({ reason }) => {
  // On fresh install open popup.html as a tab so the user sees the
  // onboarding prompt immediately. A tab (not a popup window) is the only
  // reliable way to do this from a background script. browserAction.openPopup()
  // requires a real user gesture. This is standard practice (uBlock, 1Password, etc.).
  if (reason === 'install') {
    setTimeout(() => {
      browser.tabs.create({ url: browser.runtime.getURL('popup.html') });
    }, 600);
  }
});

// Pre-open the default language DB on startup so first lookup is fast
getSettings().then(s => openDb(s.langCode)).catch(() => {});

// ── File import (chunked from popup) ──────────────────────────────────────
// The popup streams a local .jsonl/.jsonl.gz file, parses it into entry
// objects, and sends them here in batches.

// The most readings (blocks) kept for one key.
const MAX_BLOCKS = 4;

// Single source of truth for an in-progress import: public progress fields
// (polled by the popup via 'db-status') plus the private dedup state that
// spans batches. Replaced at the start of each import.
let importSession = newImportSession();

function newImportSession(fields = {}) {
  return {
    status:     'idle',   // 'idle' | 'running' | 'done' | 'error'
    langCode:   null,
    lang:       null,
    db:         null,
    total:      0,
    entryCount: 0,
    formCount:  0,
    error:      null,
    seen:       new Set(),   // every key imported so far
    formOfSet:  new Set(),   // keys whose stored record is a form-of stub
    blockCount: new Map(),   // key → readings stored or queued (absent = 1)
    extraQueue: [],          // readings to append as _extra once all records are in
    ...fields,
  };
}

async function startImportFromFileStream(langCode, lang, totalEntries) {
  if (importSession.status === 'running') throw new Error('Import already in progress');

  const db = await openDb(langCode);
  await idbClear(db, 'entries');
  await idbClear(db, 'forms');
  await idbClear(db, 'meta');

  importSession = newImportSession({ status: 'running', langCode, lang, db, total: totalEntries ?? 0 });
}

/**
 * Sort one batch of file records into those to store as records and those to
 * append to an existing record. Mutates `state` (see newImportSession).
 *
 * Rules, per key:
 *   • The first record wins the key.
 *   • A record with real definitions replaces a stored form-of stub.
 *   • A further record with real definitions becomes an extra reading
 *     (another part of speech or etymology), up to MAX_BLOCKS per key.
 *   • A form-of stub for a key that is already taken is dropped; the forms
 *     index still links the form to its lemma.
 *
 * @returns {{records: object[], extraForms: Array<{k: string, b: number, f: Array}>}}
 */
function dedupeStreamBatch(batch, state) {
  const { seen, formOfSet, blockCount, extraQueue } = state;
  const records = [];
  const extraForms = [];

  for (const entry of batch) {
    if (!entry || !entry.k) continue;
    const formOf = isFormOfBlock(entry);

    if (!seen.has(entry.k)) {
      seen.add(entry.k);
      if (formOf) formOfSet.add(entry.k);
      records.push(entry);
    } else if (formOf) {
      continue;
    } else if (formOfSet.has(entry.k)) {
      formOfSet.delete(entry.k);
      records.push(entry);
    } else {
      const b = blockCount.get(entry.k) ?? 1;
      if (b >= MAX_BLOCKS) continue;
      blockCount.set(entry.k, b + 1);
      extraQueue.push({ k: entry.k, w: entry.w, p: entry.p, g: entry.g ?? null, s: entry.s, i: entry.i ?? null });
      if (Array.isArray(entry.f)) extraForms.push({ k: entry.k, b, f: entry.f });
    }
  }
  return { records, extraForms };
}

/**
 * Store one batch in a single transaction.
 *
 * `records` are compact entry objects { k, w, p, g, s, i, f[] } as produced by
 * build-dict.js; f[] lists the inflected forms, already lowercased. The forms
 * of `records` and of `extraForms` go to the forms index. Forms that contain
 * whitespace are skipped: a hover selects a single word, so they could never
 * be looked up.
 *
 * Returns { entryCount, formCount }.
 */
async function importBatch(db, records, extraForms = []) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'forms'], 'readwrite');
    const entryStore = tx.objectStore('entries');
    const formStore  = tx.objectStore('forms');

    let entryCount = 0, formCount = 0;
    const refId = ref => `${ref.k}\u0000${ref.b ?? 0}`;
    // form → Map<refId, {k, t, b?}>
    const batchForms = new Map();

    const addForms = (k, b, forms) => {
      for (const formObj of forms) {
        // { f, t } objects, or plain strings in dictionaries built before tags were kept
        const formStr = typeof formObj === 'string' ? formObj : formObj.f;
        if (!formStr || /\s/.test(formStr)) continue;
        const ref = { k, t: (typeof formObj === 'string' ? [] : formObj.t) ?? [] };
        if (b > 0) ref.b = b;
        const form = formStr.normalize('NFC');
        if (!batchForms.has(form)) batchForms.set(form, new Map());
        batchForms.get(form).set(refId(ref), ref);
        formCount++;
      }
    };

    for (const rec of records) {
      const { f: forms, ...entry } = rec;
      entry.k = entry.k.normalize('NFC');
      entryStore.put(entry);
      entryCount++;
      if (Array.isArray(forms)) addForms(entry.k, 0, forms);
    }
    for (const { k, b, f } of extraForms) addForms(k.normalize('NFC'), b, f);

    // Merge with references stored by earlier batches (read, then write).
    for (const [form, refs] of batchForms) {
      const req = formStore.get(form);
      req.onsuccess = () => {
        const merged = new Map();
        for (const x of (req.result?.l ?? [])) {
          const ref = typeof x === 'string' ? { k: x, t: [] } : x;
          merged.set(refId(ref), ref);
        }
        for (const [id, ref] of refs) merged.set(id, ref);
        formStore.put({ f: form, l: [...merged.values()] });
      };
    }

    tx.oncomplete = () => resolve({ entryCount, formCount });
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Append the queued extra readings to their records, in queue order, so each
 * lands in the block that dedupeStreamBatch numbered it as.
 */
async function mergeExtraQueue(db, extraQueue) {
  try {
    for (const { k, ...reading } of extraQueue) {
      const existing = await idbGet(db, 'entries', k);
      if (!existing) continue;
      existing._extra = [...(existing._extra ?? []), reading];
      await idbPut(db, 'entries', existing);
    }
  } catch (err) {
    console.warn('hoverleser: _extra merge failed:', err);
  }
}

// Receives batches of already-parsed entry objects from popup.js.
// 'data' is an array of entry objects; 'metaObj' is the file's metadata line
// (sent with the last chunk).
async function receiveFileChunk(data, metaObj, isLast) {
  if (!importSession.db) throw new Error('No import session active; send import-file-start first');
  if (Array.isArray(data) && data.length > 0) {
    const { records, extraForms } = dedupeStreamBatch(data, importSession);
    if (records.length > 0 || extraForms.length > 0) {
      const counts = await importBatch(importSession.db, records, extraForms);
      importSession.entryCount += counts.entryCount;
      importSession.formCount  += counts.formCount;
    }
  }

  if (isLast) {
    await mergeExtraQueue(importSession.db, importSession.extraQueue);

    await setDbMeta(importSession.db, {
      lang:       importSession.lang,
      langCode:   importSession.langCode,
      version:    metaObj?.version ?? 'local',
      entryCount: importSession.entryCount,
      formCount:  importSession.formCount,
      importedAt: Date.now(),
    });
    importSession.status = 'done';
  }
}
