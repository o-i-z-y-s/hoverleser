#!/usr/bin/env node
/**
 * Hoverleser – Dictionary Build Script
 * ====================================
 * Downloads a language's structured Wiktionary data from kaikki.org and
 * processes it into a compact JSONL file ready for import into the extension.
 *
 * Usage (from the src/ directory):
 *   node scripts/build-dict.js --code de --compress
 *   node scripts/build-dict.js --lang German --out dist/de.jsonl
 *
 * Options:
 *   --lang <name>    Full language name as on kaikki.org (e.g. "German")
 *   --code <code>    Language code (any key of LANG_MAP below) – resolves --lang
 *   --out  <file>    Output file path (default: dist/<code>.jsonl, or .jsonl.gz
 *                    with --compress)
 *   --url  <url>     Override source URL (advanced)
 *   --in   <file>    Read kaikki JSONL from a local file (.jsonl or .jsonl.gz)
 *                    instead of downloading it
 *   --max  <n>       Stop after <n> entries (for testing)
 *   --no-forms       Skip building the inflection forms index
 *   --compress       Gzip the output
 *
 * Output format (JSONL, one JSON object per line):
 *
 *   Line 1 – metadata:
 *     { "type":"meta", "lang":"German", "langCode":"de",
 *       "version":"2026-02", "entryCount":N, "formCount":N }
 *
 *   Remaining lines – entries. A key can appear on more than one line: once
 *   per part of speech or etymology (Leben noun + leben verb), and again when
 *   a line with real definitions follows a form-of stub for the same key. The
 *   importer merges them (see dedupeStreamBatch in background.js).
 *     { "k":"hund",          // lowercase lookup key
 *       "w":"Hund",          // original display form
 *       "p":"noun",          // part of speech
 *       "g":"m",             // gender: "m"|"f"|"n"|null
 *       "s":[                // senses (up to MAX_SENSES)
 *         { "gl":["dog"], "t":["animal"] }
 *       ],
 *       "i":"/hʊnt/",        // IPA (first one found)
 *       "f":[{"f":"hundes","t":["genitive","singular"]},...]  // inflected forms with tags
 *     }
 *
 * The "f" field is consumed by the importer and stored separately in the
 * "forms" DB store; it is stripped from the entry before storing in "entries".
 *
 * Requirements: Node.js 18+ (for native fetch).
 *
 * kaikki.org data is released under CC BY-SA (same as Wiktionary).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

// ── Language map ──────────────────────────────────────────────────────────
const LANG_MAP = {
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  nl: 'Dutch',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  pl: 'Polish',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  hu: 'Hungarian',
  cs: 'Czech',
  tr: 'Turkish',
  ar: 'Arabic',
  hi: 'Hindi',
};

// Kaikki.org URL pattern for the processed JSONL per language.
// This is the "postprocessed" data extracted from English Wiktionary.
function kaikkiUrl(langName) {
  const encoded = encodeURIComponent(langName);
  return `https://kaikki.org/dictionary/${encoded}/kaikki.org-dictionary-${langName}.jsonl`;
}

// ── CLI args ──────────────────────────────────────────────────────────────
function parseArgs() {
  const args   = process.argv.slice(2);
  const opts   = { lang: null, code: null, out: null, url: null, in: null, max: Infinity, forms: true, compress: false };
  const errors = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lang':     opts.lang     = args[++i]; break;
      case '--code':     opts.code     = args[++i]; break;
      case '--out':      opts.out      = args[++i]; break;
      case '--url':      opts.url      = args[++i]; break;
      case '--in':       opts.in       = args[++i]; break;
      case '--max':      opts.max      = parseInt(args[++i], 10); break;
      case '--no-forms':  opts.forms    = false; break;
      case '--compress':  opts.compress  = true;  break;
      case '--help': case '-h': printHelp(); process.exit(0);
      default: errors.push(`Unknown option: ${args[i]}`);
    }
  }

  // Resolve lang ↔ code
  if (opts.code && !opts.lang) {
    opts.lang = LANG_MAP[opts.code];
    if (!opts.lang) errors.push(`Unknown language code: ${opts.code}`);
  } else if (opts.lang && !opts.code) {
    opts.code = Object.keys(LANG_MAP).find(k => LANG_MAP[k] === opts.lang) ?? opts.lang.slice(0, 2).toLowerCase();
  } else if (!opts.lang) {
    errors.push('Required: --lang <name> or --code <code>');
  }

  if (errors.length) {
    errors.forEach(e => console.error('Error:', e));
    process.exit(1);
  }

  opts.out = opts.out ?? path.join('dist', opts.compress ? `${opts.code}.jsonl.gz` : `${opts.code}.jsonl`);
  opts.url = opts.url ?? kaikkiUrl(opts.lang);

  return opts;
}

function printHelp() {
  console.log(`
Hoverleser – Dictionary Build Script
Usage (from src/): node scripts/build-dict.js --code <code> [--compress]

  --lang <name>   Full language name, e.g. "German", "French", "Spanish"
  --code <code>   Two-letter code (de/fr/es/…) – resolves --lang automatically
  --out  <file>   Output path     (default: dist/<code>.jsonl)
  --url  <url>    Override source URL
  --in   <file>   Read kaikki JSONL from a local file instead of downloading
  --max  <n>      Process at most <n> entries (for quick testing)
  --no-forms      Skip inflected-forms index (smaller file, worse inflection lookup)
  --compress      Gzip the output (.jsonl.gz, ~75% smaller; recommended)

Available codes: ${Object.keys(LANG_MAP).join(', ')}

Example:
  node scripts/build-dict.js --code de --compress
`);
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_SENSES   = 5;   // store 5 senses; UI max is 4, so users can change the setting without re-importing
const MAX_FORMS    = 40;  // max inflected forms stored per entry
const MAX_READINGS = 4;   // max entries written per key; matches MAX_BLOCKS in background.js

// Short names for kaikki's part-of-speech labels. A label that is not listed
// is stored as kaikki spells it.
const POS_MAP = {
  noun:     'noun', verb: 'verb', adj: 'adj',
  adv:      'adv',  prep: 'prep', pron: 'pron',
  conj:     'conj', intj: 'intj', num: 'num',
  article:  'art',  det: 'det',   particle: 'part',
  name:     'name', phrase: 'phrase', proverb: 'proverb',
  suffix:   'suf',  prefix: 'pre',
};

// Gender tags in kaikki data
const GENDER_TAGS = { masculine: 'm', feminine: 'f', neuter: 'n' };

// Sense tags about register or usage, not stored.
const NOISE_TAGS = new Set([
  'broadly', 'narrowly', 'dated', 'archaic', 'obsolete',
  'rare', 'informal', 'colloquial', 'slang', 'vulgar',
  'offensive', 'pejorative', 'derogatory', 'regional',
  'dialectal', 'nonstandard', 'proscribed', 'uncommon',
]);

// Grammatical tags worth keeping on an inflected form or a form-of sense.
const FORM_KEEP = new Set([
  'plural', 'singular', 'nominative', 'accusative', 'dative', 'genitive',
  'masculine', 'feminine', 'neuter', 'strong', 'weak', 'mixed',
  'comparative', 'superlative', 'past', 'present', 'future',
  'first-person', 'second-person', 'third-person',
  'indicative', 'subjunctive', 'imperative', 'infinitive',
  'participle', 'gerund',
]);

// kaikki's name for a tag → the name stored. German verb tables call the
// simple past "preterite"; headword lines call it "past". One name is kept so
// "sprach" and "sprachen" are badged alike.
const FORM_TAG_ALIASES = { preterite: 'past' };

// Rows of an inflection table that are not forms of the word: the name of
// the table template ("de-ndecl"), its declension class ("strong"), the
// auxiliary verb ("haben"), and compound tenses ("habe gesprochen").
const FORM_SKIP_TAGS = new Set([
  'table-tags', 'inflection-template', 'class', 'auxiliary', 'multiword-construction',
]);

/** The stored grammatical tags for a kaikki tag list. */
function keptFormTags(tags) {
  const kept = (tags ?? []).map(t => FORM_TAG_ALIASES[t] ?? t).filter(t => FORM_KEEP.has(t));
  return [...new Set(kept)];
}

// ── Form-of glosses ───────────────────────────────────────────────────────
// A copy of the same section in background.js: the build script and the
// extension do not share a module. tests/formof-sync.test.js fails if the two
// copies drift apart. Change both together.

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

/**
 * Parse a gloss of the shape "<relation words> of <base>".
 * See parseFormOf in background.js for the rules.
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
    if (!taggedFormOf && !clauseEnded && !/^[:;,("“„]/.test(rest)) return null;
  }
  return { lead, base, kind };
}

/** parseFormOf for a whole sense; see parseSenseFormOf in background.js. */
function parseSenseFormOf(sense) {
  const glosses = Array.isArray(sense?.gl) ? sense.gl : [];
  const parsed = parseFormOf(glosses[0], (sense?.t ?? []).includes('form-of'));
  return parsed && parsed.kind === 'lexical' && glosses.length > 1 ? null : parsed;
}

/** True when every sense of a processed entry is a form-of stub. */
function isFormOfEntry(entry) {
  const senses = entry?.s ?? [];
  return senses.length > 0 && senses.every(s => parseSenseFormOf(s) !== null);
}

/**
 * Convert a raw kaikki.org entry to our compact format.
 * Returns null if the entry should be skipped.
 */
function processEntry(raw, includeForms) {
  const word = (raw.word ?? '').trim();
  if (!word || word.length > 80) return null;

  // Skip entries with no meaningful content
  const senses = (raw.senses ?? []).filter(s =>
    Array.isArray(s.glosses) && s.glosses.some(g => g && g.length > 1)
  );
  if (senses.length === 0) return null;

  // Part of speech
  const pos = POS_MAP[raw.pos] ?? raw.pos ?? null;

  // Grammatical gender from top-level tags or first sense tags
  let gender = null;
  const allTags = [
    ...(raw.tags ?? []),
    ...(senses[0]?.tags ?? []),
  ];
  for (const tag of allTags) {
    if (GENDER_TAGS[tag]) { gender = GENDER_TAGS[tag]; break; }
  }

  // IPA – pick the first valid one
  let ipa = null;
  for (const sound of (raw.sounds ?? [])) {
    if (sound.ipa && typeof sound.ipa === 'string') {
      ipa = sound.ipa.trim();
      break;
    }
  }

  // Senses: collect glosses + useful tags (filter noise)
  const processedSenses = senses.slice(0, MAX_SENSES).map(s => {
    const gl = (s.glosses ?? [])
      .map(g => g.replace(/\s+/g, ' ').trim())
      .filter(g => g.length > 0);
    const t  = (s.tags ?? [])
      .filter(t => !NOISE_TAGS.has(t) && !GENDER_TAGS[t]);

    // Grammatical tags kaikki attaches to the form_of reference itself;
    // stored as `ft` and shown as badges when the stub is resolved.
    const ft = keptFormTags((s.form_of ?? []).flatMap(fo => fo.tags ?? []));

    return {
      gl,
      ...(t.length  ? { t }  : {}),
      ...(ft.length ? { ft } : {}),
    };
  });

  // Inflected forms stored as {f, t} objects so the lookup layer can surface
  // the grammatical relationship (e.g. "plural · nominative") as tag badges.
  let forms = [];
  if (includeForms && Array.isArray(raw.forms)) {
    const seen = new Set([word.toLowerCase().normalize('NFC')]);
    for (const f of raw.forms) {
      const form = (f.form ?? '').trim();
      // Skip placeholders ("-"), table metadata, and anything with a space in
      // it: a hover selects a single word, so a phrase could never be looked up.
      if (!form || form.length > 60 || form.includes('-') && form.length < 3) continue;
      if (/\s/.test(form) || (f.tags ?? []).some(t => FORM_SKIP_TAGS.has(t))) continue;
      const fl = form.toLowerCase().normalize('NFC');
      if (!seen.has(fl)) {
        seen.add(fl);
        forms.push({ f: fl, t: keptFormTags(f.tags) });
        if (forms.length >= MAX_FORMS) break;
      }
    }
  }

  const entry = {
    k: word.toLowerCase().normalize('NFC'),
    w: word,
    ...(pos    ? { p: pos }    : {}),
    ...(gender ? { g: gender } : {}),
    s: processedSenses,
    ...(ipa    ? { i: ipa }    : {}),
    ...(forms.length ? { f: forms } : {}),
  };

  return entry;
}

// ── Deduplication ─────────────────────────────────────────────────────────

/**
 * Decides, entry by entry, which processed entries are written.
 *
 * kaikki emits one entry per word, part of speech, and etymology, in no
 * useful order, so one lowercase key can arrive several times:
 *
 *   • The first entry for a key is written.
 *   • A form-of stub for a key that is already written is skipped; the forms
 *     index still links the form to its lemma.
 *   • An entry with real definitions is written after a stub for its key (the
 *     importer replaces the stub) and after other real entries for its key
 *     (the importer keeps them all as readings), up to MAX_READINGS.
 *
 * accept(entry) returns true when the entry should be written and keeps the
 * counts for the metadata line.
 */
function createDeduper() {
  const readings = new Map();   // key → real entries written; 0 = a stub holds the key
  const stubForms = new Map();  // key → form count of the stub holding the key
  const counts = { entryCount: 0, formCount: 0, readingCount: 0 };

  function accept(entry) {
    const forms = entry.f?.length ?? 0;
    const formOf = isFormOfEntry(entry);

    if (!readings.has(entry.k)) {
      readings.set(entry.k, formOf ? 0 : 1);
      if (formOf) stubForms.set(entry.k, forms);
      counts.entryCount++;
      counts.formCount += forms;
      return true;
    }
    if (formOf) return false;

    const written = readings.get(entry.k);
    if (written >= MAX_READINGS) return false;
    readings.set(entry.k, written + 1);
    if (written === 0) {
      counts.formCount -= stubForms.get(entry.k) ?? 0;   // the stub is replaced
      stubForms.delete(entry.k);
    } else {
      counts.readingCount++;
    }
    counts.formCount += forms;
    return true;
  }

  return { accept, counts };
}

// ── Stream helpers ────────────────────────────────────────────────────────

/** Lines of a local .jsonl or .jsonl.gz file. */
async function* fileLines(file) {
  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  yield* readline.createInterface({ input, crlfDelay: Infinity });
}

async function* streamLines(url) {
  console.log(`Downloading: ${url}`);
  console.log('(This may take a while for large language files…)\n');

  // Node 18+ native fetch; set User-Agent so kaikki.org does not block CI runners
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Hoverleser-BuildScript/1.0 (https://github.com/o-i-z-y-s/hoverleser)' }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);

  const reader = resp.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) { if (buf.trim()) yield buf; break; }
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log(`\nHoverleser build-dict`);
  console.log(`Language : ${opts.lang} (${opts.code})`);
  console.log(`Source   : ${opts.in ?? opts.url}`);
  console.log(`Output   : ${opts.out}\n`);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });

  // Output stream: plain or gzip-compressed
  const rawStream = fs.createWriteStream(opts.out);
  const outStream = opts.compress
    ? (() => { const gz = zlib.createGzip({ level: 6 }); gz.pipe(rawStream); return gz; })()
    : rawStream;
  const write = line => new Promise((res, rej) =>
    outStream.write(line + '\n', err => err ? rej(err) : res())
  );

  let skipped = 0;
  const { accept, counts } = createDeduper();
  const t0 = Date.now();

  // Entries are written to a temp file first; the final output is the metadata
  // line followed by the streamed temp contents (assembled after the loop).
  const tmpPath = opts.out + '.tmp';
  const tmp     = fs.createWriteStream(tmpPath, 'utf8');
  const writeTmp = line => new Promise((res, rej) =>
    tmp.write(line + '\n', err => err ? rej(err) : res())
  );

  console.log('Processing entries…');

  try {
    for await (const line of (opts.in ? fileLines(opts.in) : streamLines(opts.url))) {
      if (!line.trim()) continue;

      let raw;
      try { raw = JSON.parse(line); }
      catch { skipped++; continue; }

      if (counts.entryCount >= opts.max) break;

      const entry = processEntry(raw, opts.forms);
      if (!entry || !accept(entry)) { skipped++; continue; }

      await writeTmp(JSON.stringify(entry));

      if (counts.entryCount % 10000 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`  ${counts.entryCount.toLocaleString()} entries (${elapsed}s)…\r`);
      }
    }
  } catch (err) {
    tmp.end();
    throw err;
  }

  await new Promise(res => tmp.end(res));

  // Write output: metadata line first, then all entries
  const version = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const meta    = { type: 'meta', lang: opts.lang, langCode: opts.code,
                    version, entryCount: counts.entryCount, formCount: counts.formCount };
  await write(JSON.stringify(meta));

  // Append tmp content by streaming so peak memory stays flat regardless of
  // dictionary size (avoids buffering the entire processed file as one string).
  await new Promise((res, rej) => {
    const rs = fs.createReadStream(tmpPath);
    rs.on('error', rej);
    rs.on('end', res);
    rs.pipe(outStream, { end: false });
  });
  fs.unlinkSync(tmpPath);

  await new Promise((res, rej) => {
    outStream.on('finish', res);
    outStream.on('error', rej);
    outStream.end();
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeKb  = Math.round(fs.statSync(opts.out).size / 1024);

  console.log(`\n\n✓ Done in ${elapsed}s`);
  console.log(`  Entries : ${counts.entryCount.toLocaleString()}`);
  console.log(`  Readings: ${counts.readingCount.toLocaleString()} more for keys with several`);
  console.log(`  Forms   : ${counts.formCount.toLocaleString()}`);
  console.log(`  Skipped : ${skipped.toLocaleString()}`);
  console.log(`  Output  : ${opts.out} (${sizeKb.toLocaleString()} KB)`);
  console.log(`\nNext step: open the extension's settings tab and drop ${opts.out}`);
  console.log(`onto its import area.\n`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  processEntry, createDeduper, parseFormOf, parseSenseFormOf, isFormOfEntry,
  INFLECTION_WORDS, LEXICAL_WORDS, MAX_READINGS,
};
