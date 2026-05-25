/**
 * hoverleser – Background Script
 *
 * Responsibilities:
 *   • Open and manage the IndexedDB dictionary database
 *   • Handle 'lookup' messages from content scripts → instant local DB query
 *   • Handle 'db-status' messages → report ready/loading/empty state
 *   • Handle 'import-file-start' / 'import-file-chunk' → stream-import a local JSONL file
 *   • Handle 'get-settings' / 'set-settings' → persist user preferences
 *
 * DB Schema (one DB per language, named "hoverleser-{langCode}"):
 *   Object store "entries":  keyPath="k" (lowercase lemma)
 *     { k, w, p, g, s, i, _extra? }
 *       k       – lowercase lookup key   (string)
 *       w       – display word           (string, original casing)
 *       p       – part of speech         (string)
 *       g       – grammatical gender     (string|null, "m"/"f"/"n")
 *       s       – senses                 (Array<{gl:string[], t:string[]}>)
 *       i       – IPA pronunciation      (string|null)
 *       _extra  – additional POS blocks sharing the same key (e.g. Mensch noun
 *                 + mensch pronoun); each element is {p,g,s,i} (optional)
 *
 *   Object store "forms":    keyPath="f" (lowercase inflected form)
 *     { f, l }
 *       f  – lowercase form         (string)
 *       l  – lemma records          ({k:string, t:string[]}[])
 *
 *   Object store "meta":     keyPath="k"
 *     { k: "info", lang, langCode, version, entryCount, formCount }
 */

'use strict';

// Chrome MV3 runs the background as a service worker where `browser` is not
// defined. Import the webextension-polyfill so the rest of this file can use
// the same browser.* API as the Firefox build.
if (typeof browser === 'undefined') importScripts('lib/browser-polyfill.min.js');

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

/** Promisified IDB get on any store. Keys are NFC-normalised automatically. */
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

// ── Raw kaikki.org entry processing ───────────────────────────────────────
// Mirrors build-dict.js so Download & Import can work directly against
// kaikki.org JSONL without a separate build step.

const RAW_POS_MAP = {
  noun:'noun', verb:'verb', adj:'adj', adv:'adv', prep:'prep',
  pron:'pron', conj:'conj', intj:'intj', num:'num', article:'art',
  det:'det', particle:'part', name:'name', phrase:'phrase',
  suffix:'suf', prefix:'pre', proverb:'proverb',
};
const RAW_GENDER = { masculine:'m', feminine:'f', neuter:'n' };
const RAW_FORM_TAGS = new Set([
  'plural','singular','nominative','accusative','dative','genitive',
  'masculine','feminine','neuter','strong','weak','mixed',
  'comparative','superlative','past','present','future',
  'first-person','second-person','third-person',
  'indicative','subjunctive','imperative','participle','gerund',
]);
const RAW_SENSE_NOISE = new Set([
  'broadly','narrowly','dated','archaic','obsolete','rare','informal',
  'colloquial','slang','vulgar','offensive','pejorative','derogatory',
  'regional','dialectal','nonstandard','proscribed','uncommon',
]);
const RAW_MAX_SENSES = 5; // store more than the UI max (4) so users can change the setting without re-importing
const RAW_MAX_FORMS  = 40;

/**
 * Transform a raw kaikki.org entry object into our compact storage format.
 * Returns null for entries that should be skipped.
 * Forms are stored as { f: string, t: tags[] } objects so the lookup layer
 * can annotate a found entry with its grammatical relationship to the hover word.
 */
function processRawEntry(raw) {
  const word = (raw.word ?? '').trim();
  if (!word || word.length > 80) return null;

  const senses = (raw.senses ?? []).filter(s =>
    Array.isArray(s.glosses) && s.glosses.some(g => g && g.length > 1)
  );
  if (senses.length === 0) return null;

  const pos = RAW_POS_MAP[raw.pos] ?? raw.pos ?? null;

  let gender = null;
  for (const tag of [...(raw.tags ?? []), ...(senses[0]?.tags ?? [])]) {
    if (RAW_GENDER[tag]) { gender = RAW_GENDER[tag]; break; }
  }

  let ipa = null;
  for (const sound of (raw.sounds ?? [])) {
    if (sound.ipa) { ipa = sound.ipa.trim(); break; }
  }

  const processedSenses = senses.slice(0, RAW_MAX_SENSES).map(s => {
    const gl = (s.glosses ?? []).map(g => g.replace(/\s+/g,' ').trim()).filter(Boolean);
    const t  = (s.tags ?? []).filter(t => !RAW_SENSE_NOISE.has(t) && !RAW_GENDER[t]);
    const ft = [...new Set(
      (s.form_of ?? []).flatMap(fo => fo.tags ?? []).filter(t => RAW_FORM_TAGS.has(t))
    )];
    return { gl, ...(t.length ? {t} : {}), ...(ft.length ? {ft} : {}) };
  });

  const seen  = new Set([word.toLowerCase()]);
  const forms = [];
  for (const f of (raw.forms ?? [])) {
    const form = (f.form ?? '').trim();
    if (!form || form.length > 60) continue;
    if (form.includes('-') && form.length < 3) continue;
    const fl = form.toLowerCase().normalize('NFC');
    if (!seen.has(fl)) {
      seen.add(fl);
      const ft = (f.tags ?? []).filter(t => RAW_FORM_TAGS.has(t));
      // Store tags alongside each form so lookup can surface the relationship
      forms.push({ f: fl, t: ft });
      if (forms.length >= RAW_MAX_FORMS) break;
    }
  }

  const k = word.toLowerCase().normalize('NFC');
  return {
    k, w: word,
    ...(pos    ? {p: pos}    : {}),
    ...(gender ? {g: gender} : {}),
    s: processedSenses,
    ...(ipa    ? {i: ipa}    : {}),
    ...(forms.length ? {f: forms} : {}),
  };
}

// ── Bulk import via a single transaction (batched) ─────────────────────────
const BATCH_SIZE = 2000; // records per transaction

/**
 * Import an array of compact entry objects into the DB.
 * Each object is: { k, w, p, g, s, i, f[] }
 *   f[] is the list of inflected forms (already lowercased by build script).
 *
 * Returns { entryCount, formCount }.
 */
async function importBatch(db, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'forms'], 'readwrite');
    const entryStore = tx.objectStore('entries');
    const formStore  = tx.objectStore('forms');

    let entryCount = 0, formCount = 0;
    // form → Map<lemmaKey, tags[]>
    const batchFormMap = new Map();

    for (const rec of records) {
      // Accept both raw kaikki format (has 'word') and compact format (has 'k')
      const processed = rec.k ? rec : processRawEntry(rec);
      if (!processed) continue;

      const { f: forms, ...entry } = processed;
      entry.k = entry.k.normalize('NFC');
      entryStore.put(entry);
      entryCount++;

      if (Array.isArray(forms)) {
        for (const formObj of forms) {
          // Support { f, t } objects (new format) and plain strings (legacy)
          const formStr  = typeof formObj === 'string' ? formObj : formObj.f;
          const formTags = typeof formObj === 'string' ? []      : (formObj.t ?? []);
          const normForm = formStr.normalize('NFC');
          if (!batchFormMap.has(normForm)) batchFormMap.set(normForm, new Map());
          batchFormMap.get(normForm).set(entry.k, formTags);
          formCount++;
        }
      }
    }

    // Merge forms into DB using read-then-write within this transaction
    for (const [form, lemmaMap] of batchFormMap) {
      const req = formStore.get(form);
      req.onsuccess = () => {
        const prev = req.result;
        let merged;
        if (prev) {
          // Migrate old string[] format to {k,t}[] on first touch
          const prevMap = new Map();
          for (const x of (prev.l ?? [])) {
            if (typeof x === 'string') prevMap.set(x, []);
            else prevMap.set(x.k, x.t ?? []);
          }
          for (const [k, t] of lemmaMap) prevMap.set(k, t);
          merged = [...prevMap.entries()].map(([k, t]) => ({k, t}));
        } else {
          merged = [...lemmaMap.entries()].map(([k, t]) => ({k, t}));
        }
        formStore.put({ f: form, l: merged });
      };
    }

    tx.oncomplete = () => resolve({ entryCount, formCount });
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Lookup logic ───────────────────────────────────────────────────────────

/**
 * Compound-context suffix lookup.
 * Prefers the direct DB entry over forms-index expansions so compound suffixes
 * like "Suche" don't also pull in the verb "suchen" (a cross-POS forms-index hit).
 * Falls back to full lookupWord when there is no direct entry (e.g. inflected suffix).
 */
async function lookupWordAsSuffix(db, word, langCode = 'de') {
  const wordLower = word.toLowerCase();
  // If there's a real direct entry with senses, show only that.
  const direct = await lookupDirectEntry(db, wordLower);
  if (direct) return { segments: [{ matchedText: word, entries: [direct] }] };
  // No direct entry; fall back to full lookup (handles inflected suffix forms).
  return lookupWord(db, word, langCode);
}

/**
 * Restrict compound-prefix matching to direct lemma entries only.
 * Inflected forms (from the forms index) are valid words but not valid compound
 * prefixes, e.g. "Wörter" (plural of Wort) should not split "Wörterbüchsuche".
 * We also try stripping a trailing Fugen-s so "Hochzeits-" maps to "Hochzeit".
 */
async function lookupDirectEntry(db, key) {
  const entry = await idbGet(db, 'entries', key);
  // Reject missing, empty, or all-form-of entries: inflected/variant forms like
  // "Wörter" (nominative plural of Wort) must not serve as compound prefixes.
  if (!entry || (entry.s ?? []).length === 0) return null;
  if (entryIsAllFormOf(entry)) return null;
  return entry;
}

/**
 * Look up a word in the DB.
 *
 * Priority order (always biased toward the full word):
 *
 *   1. Exact entry match on full word (direct lemma key).
 *   2. Forms-index lookup on full word (inflected → lemma).
 *   3. Compound splitting (German only): ONLY when:
 *        • prefix is ≥ 4 characters
 *        • suffix is ≥ 3 characters
 *        • suffix ALSO resolves in the dictionary
 *      Both halves must resolve for a split to be reported.
 *      If only the prefix matches but the suffix is unknown,
 *      the word is treated as not found rather than truncated.
 *
 * Returns null if nothing found, or:
 *   { segments: [{ matchedText, entries }] }
 */
async function lookupWord(db, word, langCode = 'de') {
  const wordLower = word.toLowerCase();

  // Full-word lookup (uses forms-index + resolveFormOf for inflected forms)
  const full = await lookupCandidate(db, wordLower, 0, langCode);
  if (full && full.length > 0) {
    return { segments: [{ matchedText: word, entries: full }] };
  }

  // Compound splitting: German only; other languages do not use the same
  // closed-compound convention and Fugenelement stripping would be wrong for them.
  if (langCode !== 'de') return null;

  // Prefix must be a DIRECT lemma entry to prevent false splits on inflected
  // forms like "Woerter" (plural of Wort).
  // Suffix uses full lookup so inflected suffixes (e.g. -er, -en) still work.
  //
  // MIN_PREFIX=3 allows short but real German roots: Bau-, See-, Weg-, Bus-.
  // False splits are prevented by requiring the suffix to also resolve
  // independently as a valid dictionary entry.
  const MIN_PREFIX = 3;
  const MIN_SUFFIX = 3;
  const maxLen = wordLower.length - MIN_SUFFIX;

  // Fugenelemente (German compound-linking elements) to try stripping from
  // the candidate prefix when it is not itself a direct lemma entry.
  // Ordered longest-first so shorter strips don't shadow longer correct ones.
  // Examples of each:
  //   ens: Herzens+angelegenheit (Herz)
  //   es:  Tages+ablauf (Tag), Jahres+tag (Jahr)
  //   er:  Kinder+arzt (Kind), Bilder+buch (Bild)
  //   en:  (intermediate; caught by n below for most cases)
  //   n:   Goetzen+bild (Goetze), Sonnen+schein (Sonne), Hunden+halsband (Hund)
  //   e:   Hunde+huette (Hund), Taube+nschlag (Taube)
  //   s:   Hochzeits+band (Hochzeit), Geburts+tag (Geburt)
  const FUGEN = ['ens', 'es', 'er', 'en', 'n', 'e', 's'];

  for (let len = maxLen; len >= MIN_PREFIX; len--) {
    const prefixStr = wordLower.slice(0, len);

    // 1. Try prefix as-is (direct lemma)
    let prefEntry = await lookupDirectEntry(db, prefixStr);

    // 2. Try stripping each Fugenelement in order (longest first)
    if (!prefEntry) {
      for (const fugen of FUGEN) {
        if (!prefixStr.endsWith(fugen)) continue;
        const stripped = prefixStr.slice(0, -fugen.length);
        if (stripped.length < MIN_PREFIX) continue;
        prefEntry = await lookupDirectEntry(db, stripped);
        if (prefEntry) break;
      }
    }

    if (!prefEntry) continue;

    // Wrap the direct entry as a single-entry result for consistency
    const prefRes = [prefEntry];

    const suffixWord = word.slice(len);
    const suffixSeg  = await lookupWordAsSuffix(db, suffixWord, langCode);
    if (!suffixSeg) continue;

    return {
      segments: [
        { matchedText: word.slice(0, len), entries: prefRes },
        ...suffixSeg.segments,
      ],
    };
  }

  return null;
}

// Matches: "plural of Foo", "dative plural of Foo", "inflection of weit", etc.
const FORM_OF_RE = /^((?:[\w./-]+\s+)*of)\s+(\S+)$/i;

// Tags surfaced as visible badges
const GRAM_DISPLAY_TAGS = new Set([
  'plural','singular',
  'nominative','accusative','dative','genitive',
  'comparative','superlative',
  'past','present','future',
  'first-person','second-person','third-person',
  'indicative','subjunctive','imperative','participle',
]);

/** True when every sense of an entry is a kaikki "X of Y" form-of gloss. */
function entryIsAllFormOf(entry) {
  const senses = entry.s ?? [];
  return senses.length > 0 && senses.every(s => {
    const gl = Array.isArray(s.gl) ? s.gl[0] ?? '' : '';
    return FORM_OF_RE.test(gl.trim());
  });
}

/**
 * German morphological fallback.
 * When the forms index has no entry for a word, try common inflectional and
 * derivational reductions to find the underlying lemma.
 *
 * Examples:
 *   gehandeltes  → ge- strip + -es strip → handelt → forms index → handeln
 *   börslich     → -lich strip → börse → direct entry
 *   außerbörslich → compound split → außer + börslich → Börse
 *   entwickelte  → -te strip → entwickel + en → entwickeln
 *
 * Returns lowercase stem candidates in priority order (most specific first).
 * Does NOT include the original word to avoid trivial re-lookups.
 */
function germanDeinflect(word) {
  const w = word.toLowerCase();
  const seenCandidates = new Set([w]);
  const out = [];
  const add = s => {
    if (s.length >= 3 && !seenCandidates.has(s)) { seenCandidates.add(s); out.push(s); }
  };

  // ── ge- prefix (past participles used as adjectives) ──────────────────────
  // gehandeltes → strip ge → handeltes → strip -es → handelt → forms → handeln
  if (w.startsWith('ge') && w.length > 5) {
    const deGe = w.slice(2);
    for (const end of ['sten','stem','ster','stes','ste',
                       'tes','ten','ter','tem','te',
                       'es','en','er','em','e','t','st']) {
      if (deGe.endsWith(end) && deGe.length - end.length >= 3) {
        const base = deGe.slice(0, -end.length);
        add(base + 'en'); // verb infinitive (most common)
        add(base + 'n');
        add(base + 't');  // participle stem
        add(base);
      }
    }
    add(deGe + 'en');
    add(deGe);
  }

  // ── Derivational suffixes (adjective-forming), plain and with inflection ───
  // außerbörsliche → strip -liche (=-lich+-e) → börse ✓
  // außerbörslicher → strip -licher           → börse ✓
  // Build every combination: derivational suffix × inflectional ending (+ bare).
  const DERIV_SUFS = ['lich','isch','haft','bar','los','sam','ig'];
  const INFL_ENDS  = ['sten','stem','ster','stes','ste',
                      'tes','ten','ter','tem','te',
                      'es','en','er','em','e','st','t',''];
  for (const dsuf of DERIV_SUFS) {
    for (const iend of INFL_ENDS) {
      const combined = dsuf + iend;
      if (w.endsWith(combined) && w.length - combined.length >= 3) {
        const base = w.slice(0, -combined.length);
        add(base + 'en');  // verb infinitive first (most canonical)
        add(base + 'e');   // noun root (e.g. Börse)
        add(base);
      }
    }
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
      add(base + 'en');
      add(base + 'n');
      add(base + 'e');
      add(base);
    }
  }

  return out;
}

/**
 * Look up a (lowercase) candidate word.
 * Forms-index entries are annotated with gramTags for grammatical relationship display.
 *
 * Forms-index entries use {k, t} objects where t = grammatical tag list.
 * When a forms-index entry is a different POS than the direct entry (or no
 * direct entry exists), we annotate it as:
 *   { ...lemmaEntry, gramTags: t }
 * so the UI shows the lemma word with its grammatical role badged.
 *
 * Same-POS forms-index entries are excluded to avoid Trainer→Trainerin noise.
 * Exception: if the direct entry is itself all-form-of, all forms-index entries
 * are included to help base-lemma resolution in resolveFormOf.
 */
async function lookupCandidate(db, candidate, _depth = 0, langCode = 'de') {
  const directRaw = await idbGet(db, 'entries', candidate);
  // Expand _extra POS blocks into virtual sibling entries (e.g. Mensch noun + mensch pronoun).
  // Each sibling shares k and w with the primary entry but has its own p/g/s/i.
  const directAll = directRaw
    ? [directRaw, ...(directRaw._extra ?? []).map(e => ({
        k: directRaw.k, w: directRaw.w, ...e, _extra: undefined
      }))]
    : [];
  // The "direct" variable used by the rest of the function is the primary entry.
  const direct = directRaw;

  const formRec     = await idbGet(db, 'forms', candidate);
  const rawLemmas   = formRec?.l ?? [];
  // Normalise to {k,t} regardless of whether stored in old or new format
  const formLemmas  = rawLemmas
    .map(x => typeof x === 'string' ? {k: x, t: []} : x)
    .filter(x => x.k !== candidate);

  const collected = [];

  // True when an entry has any sense marked alt-of (old/variant spelling)
  const hasAltOf = e => (e.s ?? []).some(s => (s.t ?? []).includes('alt-of'));

  if (directAll.length > 0) {
    // Push all POS variants of the direct entry (primary + _extra siblings)
    for (const d of directAll) collected.push(d);
    // For forms-index lookup, use the primary entry's properties for the inclusion check
    const directIsFormOf = entryIsAllFormOf(direct);
    const directIsAltOf  = hasAltOf(direct);
    // Collect POS set of direct entries to avoid redundant forms-index inclusions
    const directPosSet   = new Set(directAll.map(d => d.p));
    // Case tags signal nominal inflection (noun/pronoun/article declension).
    // When the direct entry is a non-nominal POS (e.g. verb), forms-index entries
    // whose only gramTags are case markers are data artifacts, not real relationships.
    // Example: sein (verb) incorrectly pulls in du/ich/wir from the possessive-pronoun
    // forms table -- those entries are tagged genitive/singular/masculine.
    const NOMINAL_POS = new Set(['noun', 'pron', 'art', 'det', 'name']);
    const CASE_TAGS   = new Set(['nominative', 'accusative', 'dative', 'genitive']);
    const directPos   = direct.p ?? null;
    for (const {k, t} of formLemmas) {
      const fe = await idbGet(db, 'entries', k);
      if (!fe) continue;
      // Include if: direct is form-of / alt-of (needs real entry) OR POS not already covered
      if (directIsFormOf || directIsAltOf || !directPosSet.has(fe.p)) {
        // Skip cross-POS forms-index entries that carry only case/agreement tags when
        // the direct entry is non-nominal: these are Wiktionary data artifacts where
        // a pronoun declension table records the hover word as a possessive form.
        if (!directIsFormOf && directPos && !NOMINAL_POS.has(directPos) &&
            t.length > 0 && t.some(tag => CASE_TAGS.has(tag))) continue;
        const annotated = { ...fe };        // keep lemma's own w (canonical form)
        annotated.gramTags = t;
        collected.push(annotated);
      }
    }
  } else {
    for (const {k, t} of formLemmas) {
      const fe = await idbGet(db, 'entries', k);
      if (!fe) continue;
      const annotated = { ...fe };        // keep lemma's own w
      annotated.gramTags = t;  // always set
      collected.push(annotated);
    }
  }

  // If both a plain direct entry AND a forms-index annotated entry exist for
  // the same POS, the annotated one is more canonical (it's the actual lemma).
  // Drop the direct entry to avoid duplicates like two "sprechen verb" blocks.
  if (direct && collected.length > 1) {
    // Only drop a direct entry when a same-POS annotated entry exists AND the direct
    // entry is NOT itself a form-of (i.e. it has its own real senses).
    // Form-of direct entries must survive into resolveFormOf to get proper tag annotation.
    const toRemove = new Set();
    for (const d of directAll) {
      if (entryIsAllFormOf(d)) continue;  // form-of entries must not be dropped here
      const hasAnnotatedMatch = collected.some(
        e => !directAll.includes(e) && e.gramTags !== undefined && e.p === d.p
      );
      if (hasAnnotatedMatch) toRemove.add(d);
    }
    if (toRemove.size > 0) {
      collected.splice(0, collected.length, ...collected.filter(e => !toRemove.has(e)));
    }
  }

  if (collected.length === 0) {
    // Morphological fallback: German only; guard with _depth so we never
    // recurse more than one level.
    if (_depth === 0 && langCode === 'de') {
      const stems = germanDeinflect(candidate);
      for (const stem of stems) {
        const r = await lookupCandidate(db, stem, 1, langCode);
        if (r && r.length > 0) return r;
      }
    }
    return null;
  }

  const resolved = await resolveFormOf(db, collected);

  // Deduplicate.
  // When _dedup is set (by resolveFormOf to distinguish tagged vs plain base),
  // use that as the key so both can coexist in the popup.
  // Otherwise fall back to entry.k, preferring annotated over plain.
  const seen = new Map();
  for (const entry of resolved) {
    const dk = entry._dedup ?? entry.k;
    const prev = seen.get(dk);
    if (!prev || (entry.gramTags?.length && !prev.gramTags?.length)) {
      seen.set(dk, entry);
    }
  }
  // Drop entries with no renderable senses; clean up internal _dedup marker
  const all = [...seen.values()]
    .filter(e => (e.s ?? []).length > 0)
    .map(e => { const {_dedup, ...rest} = e; return rest; });
  // When a non-alt-of entry exists, drop any alt-of entries: they are
  // old/variant spellings that add noise when the canonical form is already shown.
  const nonAltOf = all.filter(e => !hasAltOf(e));
  return nonAltOf.length > 0 ? nonAltOf : all;
}

/**
 * For entries that are themselves stored as all-form-of glosses (e.g. a kaikki
 * entry whose only sense is "plural of Wörterbuch"), look up the base lemma
 * and substitute real definitions, annotating with gramTags.
 *
 * Entries that already have gramTags set (annotated by lookupCandidate via
 * the forms index) pass through unchanged; their annotation is authoritative.
 *
 * No gramNote is produced; the tag badges carry all needed information.
 */
async function resolveFormOf(db, entries) {
  const byKey = new Map(entries.map(e => [e.k, e]));
  const out   = [];

  for (const entry of entries) {
    // Already annotated by lookupCandidate → pass through
    if (entry.gramTags !== undefined) { out.push(entry); continue; }

    const senses = entry.s ?? [];
    if (senses.length === 0) { out.push(entry); continue; }

    const notes   = [];
    const allFt   = new Set();
    let allFormOf = true;
    let baseWord  = null;

    for (const sense of senses) {
      const gl = Array.isArray(sense.gl) ? sense.gl[0] ?? '' : '';
      const m  = FORM_OF_RE.exec(gl.trim());
      if (m) {
        notes.push(gl.trim());
        if (!baseWord) baseWord = m[2].split(/;;/)[0].replace(/[:;,\s]+$/, '').trim();
        for (const tag of (sense.ft ?? [])) allFt.add(tag);
      } else {
        allFormOf = false;
        break;
      }
    }

    if (!allFormOf || notes.length === 0) { out.push(entry); continue; }

    // Build gramTags from form_of field tags + keywords in gloss text
    const fromFt    = [...allFt].filter(t => GRAM_DISPLAY_TAGS.has(t));
    const fromGloss = notes.flatMap(n => n.split(/;;/)[0].split(/[\s/;,]+/))
      .map(w => w.toLowerCase()).filter(w => GRAM_DISPLAY_TAGS.has(w));
    const gramTags  = [...new Set([...fromFt, ...fromGloss])];

    // Resolve base lemma
    let baseEntry = null;
    if (baseWord) {
      const key = baseWord.toLowerCase().normalize('NFC').replace(/[[\]#|]/g, '').trim();
      // 1. Check already-collected entries first (e.g. weit alongside weitere)
      const inHand = byKey.get(key);
      if (inHand && !entryIsAllFormOf(inHand)) baseEntry = inHand;
      // 2. DB direct lookup
      if (!baseEntry) {
        const dbEntry = await idbGet(db, 'entries', key);
        if (dbEntry && !entryIsAllFormOf(dbEntry)) baseEntry = dbEntry;
      }
      // 3. Forms index fallback: runs if no baseEntry yet, OR if step 2 found one
      //    with zero senses (step 3 was skipped but the gap still needs filling).
      if (!baseEntry || (baseEntry.s ?? []).length === 0) {
        const bf = await idbGet(db, 'forms', key);
        const firstLemma = bf?.l?.[0];
        const lemmaKey   = typeof firstLemma === 'string' ? firstLemma : firstLemma?.k;
        if (lemmaKey) {
          const fe = await idbGet(db, 'entries', lemmaKey);
          if (fe && !entryIsAllFormOf(fe) && (fe.s ?? []).length > 0) baseEntry = fe;
        }
      }
    }

    if (baseEntry && (baseEntry.s ?? []).length > 0 && !entryIsAllFormOf(baseEntry)) {
      // Happy path: base found with real definitions.
      // Push only the plain base lemma; the form-of entry already carries
      // the grammatical role (gramTags / PAST PARTICIPLE etc.) separately,
      // so duplicating the base senses under the surface word's header is noise.
      if (!byKey.has(baseEntry.k) || entryIsAllFormOf(byKey.get(baseEntry.k))) {
        out.push({ ...baseEntry });
      }
    }
    // else: nothing resolvable → silently drop; the deinflect fallback in
    // lookupCandidate may still surface something, and an empty-senses
    // entry would only produce an unusable popup.
  }
  return out;
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
  };
}

// ── Import state machine ───────────────────────────────────────────────────
// Tracks in-progress import so popup can poll progress.

let importState = {
  status:  'idle',   // 'idle' | 'downloading' | 'running' | 'done' | 'error'
  lang:    null,
  total:   0,
  done:    0,
  error:   null,
};

// ── Message router ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  // Extension pages (popup, options, setup tab opened as a full tab) always have
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
      const { word, langCode } = msg;
      return openDb(langCode).then(db => lookupWord(db, word, langCode));
    }

    // ── DB status ────────────────────────────────────────────────────────
    case 'db-status': {
      const { langCode } = msg;
      return getDbMeta(langCode).then(meta => ({
        ready:      !!meta,
        meta:       meta ?? null,
        importing:  importState.lang === langCode ? importState : null,
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
        langCode:   ['de','fr','es','nl','it','pt','ru','zh','ja'].includes(raw.langCode) ? raw.langCode : 'de',
        showIpa:    typeof raw.showIpa    === 'boolean' ? raw.showIpa    : true,
        showTags:   typeof raw.showTags   === 'boolean' ? raw.showTags   : true,
        showGender: typeof raw.showGender === 'boolean' ? raw.showGender : true,
        maxSenses:  Number.isInteger(raw.maxSenses) && raw.maxSenses >= 1 && raw.maxSenses <= 10
                      ? raw.maxSenses : 3,
      };
      return browser.storage.local.set({ settings: safe }).then(() => ({ ok: true }));
    }

    // ── Import dictionary from JSONL text ────────────────────────────────
    // The popup sends chunks of the JSONL file one at a time.

    // ── Clear / reset DB ─────────────────────────────────────────────────
    case 'clear-db': {
      const denied = extensionOnly();
      if (denied) return denied;
      if (importState.status === 'running' || importState.status === 'downloading') {
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
      const { langCode, lang, totalSize } = msg;
      return startImportFromFileStream(langCode, lang, totalSize)
        .then(() => ({ ok: true }))
        .catch(err => { importState.status = 'error'; importState.error = err.message; throw err; });
    }

    case 'import-file-chunk': {
      const denied = extensionOnly();
      if (denied) return denied;
      const { langCode, data, meta, done } = msg;
      return receiveFileChunk(langCode, data, meta ?? null, done)
        .then(() => ({ ok: true }))
        .catch(err => { importState.status = 'error'; importState.error = err.message; throw err; });
    }
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  const settings = await getSettings();

  // Pre-open DB so first lookup is fast
  await openDb(settings.langCode).catch(() => {});

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
// The popup streams a local .jsonl/.jsonl.gz file, parses it into entry objects,
// and sends them here in batches. Dedup and DB writes mirror the URL import path.

let fileImportState = {
  langCode:   null,
  lang:       null,
  db:         null,
  entryCount: 0,
  formCount:  0,
  meta:       null,
  // cross-chunk dedup state
  seen:       new Set(),
  formOfSet:  new Set(),
  posSeen:    new Map(),
  extraQueue: [],
};

async function startImportFromFileStream(langCode, lang, totalEntries) {
  if (importState.status === 'running') throw new Error('Import already in progress');

  const db = await openDb(langCode);
  await idbClear(db, 'entries');
  await idbClear(db, 'forms');
  await idbClear(db, 'meta');

  fileImportState = {
    langCode, lang, db,
    entryCount: 0, formCount: 0, meta: null,
    seen: new Set(), formOfSet: new Set(), posSeen: new Map(), extraQueue: [],
  };

  importState = { status: 'running', lang: langCode, total: totalEntries, done: 0, error: null };
}

/**
 * Merge queued _extra POS blocks into already-stored entries.
 * Called at the end of both URL and file import paths.
 */
async function mergeExtraQueue(db, extraQueue) {
  if (extraQueue.length === 0) return;
  try {
    for (const extra of extraQueue) {
      const existing = await idbGet(db, 'entries', extra.k);
      if (!existing) continue;
      const extras = existing._extra ?? [];
      if (!extras.some(e => e.p === extra.p)) {
        extras.push({ p: extra.p, g: extra.g ?? null, s: extra.s, i: extra.i ?? null });
        existing._extra = extras;
        await idbPut(db, 'entries', existing);
      }
    }
  } catch (err) {
    console.warn('hoverleser: _extra merge failed:', err);
  }
}

/**
 * Shared stream-dedup helper for the file import path.
 * Mutates state in-place; returns a filtered array ready for importBatch.
 *
 * Rules:
 *   • First occurrence of a key wins.
 *   • If the first was form-of and a real-definition entry arrives later, upgrade.
 *   • Two real entries with different POS → queue as _extra.
 *   • Duplicate key + same POS → skip.
 */
function dedupeStreamBatch(records, state) {
  const { seen, formOfSet, posSeen, extraQueue } = state;
  const filtered = [];

  for (const rec of records) {
    const entry = rec.k ? rec : processRawEntry(rec);
    if (!entry) continue;

    const entryIsFormOf = (entry.s ?? []).length > 0 && (entry.s ?? []).every(s =>
      (s.gl ?? []).some(g => FORM_OF_RE.test(g.trim()))
    );

    if (seen.has(entry.k)) {
      if (!entryIsFormOf && formOfSet.has(entry.k)) {
        // Upgrade: a real-definition entry supersedes the stored form-of entry.
        formOfSet.delete(entry.k);
        if (entry.p) posSeen.set(entry.k, entry.p);
        // fall through: include this entry
      } else if (!entryIsFormOf && !formOfSet.has(entry.k)) {
        // Two real entries share the same key.
        const prevPos = posSeen.get(entry.k);
        if (prevPos && entry.p && entry.p !== prevPos) {
          // Different POS (e.g. Mensch noun vs mensch pronoun) → _extra merge later.
          extraQueue.push({ k: entry.k, p: entry.p, g: entry.g ?? null, s: entry.s, i: entry.i ?? null });
        }
        continue; // don't re-push to batch
      } else {
        continue; // form-of duplicate or same-POS duplicate → skip
      }
    } else {
      seen.add(entry.k);
      if (entryIsFormOf) formOfSet.add(entry.k);
      else if (entry.p) posSeen.set(entry.k, entry.p);
    }

    filtered.push(entry);
  }
  return filtered;
}

// Receives batches of already-parsed entry objects from popup.js.
// 'data' is an array of entry objects; 'meta' is the metadata object (on last chunk).
async function receiveFileChunk(langCode, data, metaObj, isLast) {
  if (!fileImportState.db) throw new Error('No import session active; send import-file-start first');
  if (Array.isArray(data) && data.length > 0) {
    const filtered = dedupeStreamBatch(data, fileImportState);
    if (filtered.length > 0) {
      const counts = await importBatch(fileImportState.db, filtered);
      fileImportState.entryCount += counts.entryCount;
      fileImportState.formCount  += counts.formCount;
      importState.done = fileImportState.entryCount;
    }
  }

  if (isLast) {
    await mergeExtraQueue(fileImportState.db, fileImportState.extraQueue);

    const m = metaObj ?? fileImportState.meta;
    await setDbMeta(fileImportState.db, {
      lang:       fileImportState.lang,
      langCode:   fileImportState.langCode,
      version:    m?.version ?? 'local',
      entryCount: fileImportState.entryCount,
      formCount:  fileImportState.formCount,
      importedAt: Date.now(),
    });
    importState.status = 'done';
    importState.done   = fileImportState.entryCount;
  }
}

