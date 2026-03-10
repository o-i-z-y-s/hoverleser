/**
 * hoverleser – Background Script
 *
 * Responsibilities:
 *   • Open and manage the IndexedDB dictionary database
 *   • Handle 'lookup' messages from content scripts → instant local DB query
 *   • Handle 'db-status' messages → report ready/loading/empty state
 *   • Handle 'import-start' → stream-import a compact dictionary JSONL file
 *   • Handle 'get-settings' / 'set-settings' → persist user preferences
 *
 * DB Schema (one DB per language, named "hoverleser-{langCode}"):
 *   Object store "entries":  keyPath="k" (lowercase lemma)
 *     { k, w, p, g, s, i }
 *       k  – lowercase lookup key   (string)
 *       w  – display word           (string, original casing)
 *       p  – part of speech         (string)
 *       g  – grammatical gender     (string|null, "m"/"f"/"n")
 *       s  – senses                 (Array<{gl:string[], t:string[]}>)
 *       i  – IPA pronunciation      (string|null)
 *
 *   Object store "forms":    keyPath="f" (lowercase inflected form)
 *     { f, l }
 *       f  – lowercase form         (string)
 *       l  – array of lowercase lemma keys it maps to  (string[])
 *
 *   Object store "meta":     keyPath="k"
 *     { k: "info", lang, langCode, version, entryCount, formCount }
 */

'use strict';

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
const RAW_MAX_SENSES = 3;
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
 * Look up a word in the DB.
 *
 * Priority order — always biased toward the full word:
 *
 *   1. Exact entry match on full word (direct lemma key).
 *   2. Forms-index lookup on full word (inflected → lemma).
 *   3. Compound splitting — ONLY when:
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
/**
 * Compound-context suffix lookup.
 * Prefers the direct DB entry over forms-index expansions so compound suffixes
 * like "Suche" don't also pull in the verb "suchen" (a cross-POS forms-index hit).
 * Falls back to full lookupWord when there is no direct entry (e.g. inflected suffix).
 */
async function lookupWordAsSuffix(db, word) {
  const wordLower = word.toLowerCase();
  // If there's a real direct entry with senses, show only that.
  const direct = await lookupDirectEntry(db, wordLower);
  if (direct) return { segments: [{ matchedText: word, entries: [direct] }] };
  // No direct entry — fall back to full lookup (handles inflected suffix forms).
  return lookupWord(db, word);
}

/**
 * Restrict compound-prefix matching to direct lemma entries only.
 * Inflected forms (from the forms index) are valid words but not valid compound
 * prefixes — e.g. "Wörter" (plural of Wort) should not split "Wörterbüchsuche".
 * We also try stripping a trailing Fugen-s so "Hochzeits-" maps to "Hochzeit".
 */
async function lookupDirectEntry(db, key) {
  const entry = await idbGet(db, 'entries', key);
  // Reject missing, empty, or all-form-of entries — inflected/variant forms like
  // "Wörter" (nominative plural of Wort) must not serve as compound prefixes.
  if (!entry || (entry.s ?? []).length === 0) return null;
  if (entryIsAllFormOf(entry)) return null;
  return entry;
}

async function lookupWord(db, word) {
  const wordLower = word.toLowerCase();

  // Full-word lookup (uses forms-index + resolveFormOf for inflected forms)
  const full = await lookupCandidate(db, wordLower, word);
  if (full && full.length > 0) {
    return { segments: [{ matchedText: word, entries: full }] };
  }

  // Compound splitting — prefix must be a DIRECT lemma entry to prevent
  // false splits on inflected forms like "Wörter" (plural of Wort).
  // Suffix uses full lookup so inflected suffixes (e.g. -er, -en) still work.
  const MIN_PREFIX = 4;
  const MIN_SUFFIX = 3;
  const maxLen = wordLower.length - MIN_SUFFIX;

  for (let len = maxLen; len >= MIN_PREFIX; len--) {
    const prefixStr = wordLower.slice(0, len);

    // 1. Try prefix as-is (direct lemma)
    let prefEntry = await lookupDirectEntry(db, prefixStr);

    // 2. Strip Fugen-s (e.g. "Hochzeits" → "Hochzeit", "Tages" → "Tag")
    if (!prefEntry && prefixStr.endsWith('s') && prefixStr.length > MIN_PREFIX) {
      prefEntry = await lookupDirectEntry(db, prefixStr.slice(0, -1));
    }

    if (!prefEntry) continue;

    // Wrap the direct entry as a single-entry result for consistency
    const prefRes = [prefEntry];

    const suffixWord = word.slice(len);
    const suffixSeg  = await lookupWordAsSuffix(db, suffixWord);
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
 * Look up a (lowercase) candidate word.
 * originalWord preserves the hover casing (e.g. 'Fragen') so forms-index
 * entries can be annotated with the correct display word and gramTags.
 *
 * Forms-index entries use {k, t} objects where t = grammatical tag list.
 * When a forms-index entry is a different POS than the direct entry (or no
 * direct entry exists), we annotate it as:
 *   { ...lemmaEntry, w: originalWord, gramTags: t }
 * so the UI shows the correct surface word with its grammatical role badged.
 *
 * Same-POS forms-index entries are excluded to avoid Trainer→Trainerin noise.
 * Exception: if the direct entry is itself all-form-of, all forms-index entries
 * are included to help base-lemma resolution in resolveFormOf.
 */
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

async function lookupCandidate(db, candidate, originalWord, _depth = 0) {
  const directRaw = await idbGet(db, 'entries', candidate);
  // Expand _extra POS blocks into virtual sibling entries (e.g. Mensch noun + mensch pronoun).
  // Each sibling shares k and w with the primary entry but has its own p/g/s/i.
  const directAll = directRaw
    ? [directRaw, ...(directRaw._extra ?? []).map(e => ({
        k: directRaw.k, w: directRaw.w, ...e, _extra: undefined
      }))]
    : [];
  // The "direct" variable used by the rest of the function is the primary entry.
  const direct = directRaw ?? null;

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
    for (const {k, t} of formLemmas) {
      const fe = await idbGet(db, 'entries', k);
      if (!fe) continue;
      // Include if: direct is form-of / alt-of (needs real entry) OR POS not already covered
      if (directIsFormOf || directIsAltOf || !directPosSet.has(fe.p)) {
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
    // Morphological fallback — try common German inflectional/derivational reductions.
    // Guard with _depth so we never recurse more than one level.
    if (_depth === 0) {
      const stems = germanDeinflect(candidate);
      for (const stem of stems) {
        const r = await lookupCandidate(db, stem, originalWord, 1);
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
  // When a non-alt-of entry exists, drop any alt-of entries — they are
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
 * the forms index) pass through unchanged — their annotation is authoritative.
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
      // 3. Forms index fallback
      if (!baseEntry) {
        const bf = await idbGet(db, 'forms', key);
        const firstLemma = bf?.l?.[0];
        const lemmaKey   = typeof firstLemma === 'string' ? firstLemma : firstLemma?.k;
        if (lemmaKey) {
          const fe = await idbGet(db, 'entries', lemmaKey);
          if (fe && !entryIsAllFormOf(fe)) baseEntry = fe;
        }
      }
    }

    if (baseEntry && (baseEntry.s ?? []).length > 0 && !entryIsAllFormOf(baseEntry)) {
      // Happy path: base found with real definitions.
      // Push only the plain base lemma — the form-of entry already carries
      // the grammatical role (gramTags / PAST PARTICIPLE etc.) separately,
      // so duplicating the base senses under the surface word's header is noise.
      if (!byKey.has(baseEntry.k) || entryIsAllFormOf(byKey.get(baseEntry.k))) {
        out.push({ ...baseEntry });
      }
    } else {
      // Fallback: base not found, or base is itself a form-of (chained / stale DB).
      // Try one extra resolution level via the forms index of the base key.
      let chainEntry = null;
      if (baseWord) {
        const baseKey2 = baseWord.toLowerCase().normalize('NFC').replace(/[[\]#|]/g, '').trim();
        const bf = await idbGet(db, 'forms', baseKey2);
        const firstLemma = bf?.l?.[0];
        const lemmaKey   = typeof firstLemma === 'string' ? firstLemma : firstLemma?.k;
        if (lemmaKey) {
          const fe = await idbGet(db, 'entries', lemmaKey);
          if (fe && !entryIsAllFormOf(fe) && (fe.s ?? []).length > 0) chainEntry = fe;
        }
      }
      if (chainEntry) {
        out.push({ ...chainEntry, w: entry.w, gramTags });
      } else {
        // Nothing resolvable — silently drop this entry; the dedup filter will
        // discard it, and the deinflect fallback in lookupCandidate may still find something.
        // (Don't push an empty-senses entry — it just shows an unusable popup.)
      }
    }
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
  return result.settings ?? defaultSettings();
}

function defaultSettings() {
  return {
    enabled:  true,
    langCode: 'de',
    showIpa:  true,
  };
}

// ── Import state machine ───────────────────────────────────────────────────
// Tracks in-progress import so popup can poll progress.

let importState = {
  status:  'idle',   // 'idle' | 'running' | 'done' | 'error'
  lang:    null,
  total:   0,
  done:    0,
  error:   null,
};

// ── Message router ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, _sender) => {
  switch (msg.type) {

    // ── Word lookup ──────────────────────────────────────────────────────
    case 'lookup': {
      const { word, langCode } = msg;
      return openDb(langCode).then(db => lookupWord(db, word));
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
      return browser.storage.local.set({ settings: msg.settings }).then(() => ({ ok: true }));
    }

    // ── Import dictionary from JSONL text ────────────────────────────────
    // The popup sends chunks of the JSONL file one at a time, or the
    // background can fetch a URL itself.
    case 'import-url': {
      const { url, langCode, lang } = msg;
      return startImportFromUrl(url, langCode, lang).then(() => ({ ok: true }));
    }

    case 'import-status': {
      return Promise.resolve(importState);
    }

    // ── Clear / reset DB ─────────────────────────────────────────────────
    case 'clear-db': {
      const { langCode } = msg;
      return openDb(langCode).then(async db => {
        await idbClear(db, 'entries');
        await idbClear(db, 'forms');
        await idbClear(db, 'meta');
        return { ok: true };
      });
    }

    case 'import-file-start': {
      const { langCode, lang, totalSize } = msg;
      return startImportFromFileStream(langCode, lang, totalSize)
        .then(() => ({ ok: true }))
        .catch(err => { importState.status = 'error'; importState.error = err.message; throw err; });
    }

    case 'import-file-chunk': {
      const { langCode, data, meta, done } = msg;
      return receiveFileChunk(langCode, data, meta ?? null, done)
        .then(() => ({ ok: true }))
        .catch(err => { importState.status = 'error'; importState.error = err.message; throw err; });
    }
  }
});

// ── Import from URL ────────────────────────────────────────────────────────

async function startImportFromUrl(url, langCode, lang) {
  if (importState.status === 'running') {
    throw new Error('Import already in progress');
  }

  // Pre-set an approximate total so the progress bar is meaningful from the start.
  // German kaikki has ~1.3 M entries; other languages vary but this is harmless.
  importState = { status: 'running', lang: langCode, total: 1350000, done: 0, error: null };

  // Run async, don't await (fire-and-forget; popup polls import-status)
  runImport(url, langCode, lang).catch(err => {
    importState.status = 'error';
    importState.error  = err.message;
    console.error('hoverleser import failed:', err);
  });
}

async function runImport(url, langCode, lang) {
  const db = await openDb(langCode);

  // Clear existing data first
  await idbClear(db, 'entries');
  await idbClear(db, 'forms');
  await idbClear(db, 'meta');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

  // Decompress gzip if the URL ends in .gz or server signals it
  let body = response.body;
  const isGzip = url.endsWith('.gz') ||
    (response.headers.get('content-encoding') ?? '').includes('gzip') ||
    (response.headers.get('content-type') ?? '').includes('gzip');
  if (isGzip && typeof DecompressionStream !== 'undefined') {
    body = body.pipeThrough(new DecompressionStream('gzip'));
  }

  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';
  let   batch   = [];
  let   entryCount = 0;
  let   formCount  = 0;
  let   meta    = null;
  // Dedup: prefer real-definition entries over kaikki's standalone form-of entries.
  // Without this, a form-of "Fragen" entry can overwrite the verb "fragen".
  const streamSeen      = new Set();   // all seen keys
  const streamFormOfSet = new Set();   // keys whose current stored entry is form-of
  const streamPosSeen   = new Map();   // key → pos of the stored non-form-of entry
  const extraQueue      = [];          // {k, p, g, s, i} to merge as _extra later

  const flush = async () => {
    if (batch.length === 0) return;
    const counts = await importBatch(db, batch);
    entryCount += counts.entryCount;
    formCount  += counts.formCount;
    importState.done = entryCount;
    batch = [];
  };

  // Stream the JSONL line-by-line
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      // Support both: pre-processed compact JSONL (from build-dict.js, has 'k')
      // and raw kaikki.org JSONL (has 'word'). processRawEntry handles the latter.
      if (obj.type === 'meta') {
        meta = obj;
        importState.total = obj.entryCount ?? 0;
        continue;
      }

      const entry = obj.k ? obj : processRawEntry(obj);
      if (!entry) continue;

      // Dedup: detect whether this entry is all form-of
      const entryIsFormOfHere = (entry.s ?? []).length > 0 && (entry.s ?? []).every(s =>
        (s.gl ?? []).some(g => FORM_OF_RE.test(g.trim()))
      );

      if (streamSeen.has(entry.k)) {
        if (!entryIsFormOfHere && streamFormOfSet.has(entry.k)) {
          // Upgrade: replace the stored form-of entry with this real one.
          streamFormOfSet.delete(entry.k);
          if (entry.p) streamPosSeen.set(entry.k, entry.p);
          // fall through to push
        } else if (!entryIsFormOfHere && !streamFormOfSet.has(entry.k)) {
          // Two real (non-form-of) entries share the same key.
          const prevPos = streamPosSeen.get(entry.k);
          if (prevPos && entry.p && entry.p !== prevPos) {
            // Different POS (e.g. Mensch noun vs mensch pronoun) — queue for _extra merge.
            extraQueue.push({ k: entry.k, p: entry.p, g: entry.g, s: entry.s, i: entry.i });
          }
          continue; // don't re-push main batch entry
        } else {
          continue; // new entry is form-of or same POS duplicate — skip
        }
      } else {
        streamSeen.add(entry.k);
        if (entryIsFormOfHere) streamFormOfSet.add(entry.k);
        else if (entry.p) streamPosSeen.set(entry.k, entry.p);
      }

      batch.push(entry);
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();

  // Merge _extra POS blocks into already-stored entries.
  // These are real-definition entries that share a key with the primary entry
  // but have a different POS (e.g. Mensch noun + mensch pronoun).
  if (extraQueue.length > 0) {
    try {
      const exDb = await openDb(langCode);
      for (const extra of extraQueue) {
        const existing = await idbGet(exDb, 'entries', extra.k);
        if (!existing) continue;
        const extras = existing._extra ?? [];
        if (!extras.some(e => e.p === extra.p)) {
          extras.push({ p: extra.p, g: extra.g ?? null, s: extra.s, i: extra.i ?? null });
          existing._extra = extras;
          await idbPut(exDb, 'entries', existing);
        }
      }
    } catch (err) {
      console.warn('hoverleser: _extra merge failed:', err);
    }
  }

  await setDbMeta(db, {
    lang, langCode,
    version:    meta?.version    ?? 'unknown',
    entryCount, formCount,
    importedAt: Date.now(),
  });

  importState.status = 'done';
  importState.done   = entryCount;
}

// ── Init ───────────────────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  const settings = await getSettings();

  // Pre-open DB so first lookup is fast
  await openDb(settings.langCode).catch(() => {});

  // On fresh install open popup.html as a tab so the user sees the
  // onboarding prompt immediately. A tab (not a popup window) is the only
  // reliable way to do this from a background script — browserAction.openPopup()
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
// The popup reads a local .jsonl file in 4 MB slices and sends them here.
// We reassemble via a line buffer and process identically to a URL import.

let fileImportState = {
  langCode: null,
  lang:     null,
  db:       null,
  buffer:   '',
  batch:    [],
  entryCount: 0,
  formCount:  0,
  meta:     null,
};

async function startImportFromFileStream(langCode, lang, totalEntries) {
  if (importState.status === 'running') throw new Error('Import already in progress');

  const db = await openDb(langCode);
  await idbClear(db, 'entries');
  await idbClear(db, 'forms');
  await idbClear(db, 'meta');

  fileImportState = {
    langCode, lang, db,
    buffer: '', batch: [],
    entryCount: 0, formCount: 0, meta: null,
  };

  importState = { status: 'running', lang: langCode, total: totalEntries, done: 0, error: null };
}

// Receives batches of already-parsed entry objects from popup.js.
// 'data' is an array of entry objects; 'meta' is the metadata object (on last chunk).
async function receiveFileChunk(langCode, data, metaObj, isLast) {
  if (!Array.isArray(data) || data.length === 0) {
    if (!isLast) return;
  } else {
    const counts = await importBatch(fileImportState.db, data);
    fileImportState.entryCount += counts.entryCount;
    fileImportState.formCount  += counts.formCount;
    importState.done = fileImportState.entryCount;
  }

  if (isLast) {
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

