#!/usr/bin/env node
/**
 * Hoverleser – Dictionary Build Script
 * ====================================
 * Downloads a language's structured Wiktionary data from kaikki.org and
 * processes it into a compact JSONL file ready for import into the extension.
 *
 * Usage:
 *   node scripts/build-dict.js --lang German --out dist/de.jsonl
 *   node scripts/build-dict.js --lang French  --out dist/fr.jsonl
 *   node scripts/build-dict.js --lang Spanish --out dist/es.jsonl
 *
 *   # Or using short codes:
 *   node scripts/build-dict.js --code de --out dist/de.jsonl
 *
 * Options:
 *   --lang <name>    Full language name as on kaikki.org (e.g. "German")
 *   --code <code>    Language code (de/fr/es/nl/it/pt/ru) – resolves --lang
 *   --out  <file>    Output file path (default: dist/<code>.jsonl)
 *   --url  <url>     Override source URL (advanced)
 *   --max  <n>       Stop after <n> entries (for testing)
 *   --no-forms       Skip building the inflection forms index
 *
 * Output format (JSONL, one JSON object per line):
 *
 *   Line 1 – metadata:
 *     { "type":"meta", "lang":"German", "langCode":"de",
 *       "version":"2026-02", "entryCount":N, "formCount":N }
 *
 *   Remaining lines – entries:
 *     { "k":"hund",          // lowercase lookup key
 *       "w":"Hund",          // original display form
 *       "p":"noun",          // part of speech
 *       "g":"m",             // gender: "m"|"f"|"n"|null
 *       "s":[                // senses (up to MAX_SENSES)
 *         { "gl":["dog"], "t":["animal"] }
 *       ],
 *       "i":"/hʊnt/",        // IPA (first one found)
 *       "f":["hundes","hunde","hunden"]  // lowercase inflected forms
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
const { Readable } = require('stream');

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
  const opts   = { lang: null, code: null, out: null, url: null, max: Infinity, forms: true, compress: false };
  const errors = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lang':     opts.lang     = args[++i]; break;
      case '--code':     opts.code     = args[++i]; break;
      case '--out':      opts.out      = args[++i]; break;
      case '--url':      opts.url      = args[++i]; break;
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
Usage: node scripts/build-dict.js --lang <Language> --out dist/<code>.jsonl

  --lang <name>   Full language name, e.g. "German", "French", "Spanish"
  --code <code>   Two-letter code (de/fr/es/…) – resolves --lang automatically
  --out  <file>   Output path     (default: dist/<code>.jsonl)
  --url  <url>    Override source URL
  --max  <n>      Process at most <n> entries (for quick testing)
  --no-forms      Skip inflected-forms index (smaller file, worse inflection lookup)
  --compress      Gzip the output (.jsonl.gz, ~75% smaller — recommended)

Available codes: ${Object.keys(LANG_MAP).join(', ')}

Example:
  node scripts/build-dict.js --code de --out dist/de.jsonl
`);
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_SENSES = 3;   // top 3 senses per entry — keeps files lean
const MAX_FORMS  = 40;  // max inflected forms stored per entry

// Parts of speech that are useful
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

/**
 * Convert a raw kaikki.org entry to our compact format.
 * Returns null if the entry should be skipped.
 */
function processEntry(raw, includeforms) {
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
  const NOISE_TAGS = new Set([
    'broadly', 'narrowly', 'dated', 'archaic', 'obsolete',
    'rare', 'informal', 'colloquial', 'slang', 'vulgar',
    'offensive', 'pejorative', 'derogatory', 'regional',
    'dialectal', 'nonstandard', 'proscribed', 'uncommon',
  ]);
  // Grammatical tags from kaikki's form_of field (e.g. ["plural","nominative","strong"])
  // These describe how the word relates to its lemma and are stored as `ft`.
  // We keep only the tags that are meaningful for display, dropping gender/noise.
  const FORM_NOISE = new Set([
    'error-unknown-tag', 'include-suffix', 'canonical',
  ]);
  const FORM_KEEP = new Set([
    'plural', 'singular', 'nominative', 'accusative', 'dative', 'genitive',
    'masculine', 'feminine', 'neuter', 'strong', 'weak', 'mixed',
    'comparative', 'superlative', 'past', 'present', 'future',
    'first-person', 'second-person', 'third-person',
    'indicative', 'subjunctive', 'imperative', 'infinitive',
    'participle', 'gerund',
  ]);

  const processedSenses = senses.slice(0, MAX_SENSES).map(s => {
    const gl = (s.glosses ?? [])
      .map(g => g.replace(/\s+/g, ' ').trim())
      .filter(g => g.length > 0);
    const t  = (s.tags ?? [])
      .filter(t => !NOISE_TAGS.has(t) && !GENDER_TAGS[t]);

    // Capture form_of tags — the grammatical relationship info kaikki stores separately
    const formOfTags = (s.form_of ?? [])
      .flatMap(fo => fo.tags ?? [])
      .filter(t => FORM_KEEP.has(t) && !FORM_NOISE.has(t));
    const ft = [...new Set(formOfTags)]; // deduplicate

    return {
      gl,
      ...(t.length  ? { t }  : {}),
      ...(ft.length ? { ft } : {}),
    };
  });

  // Inflected forms
  let forms = [];
  if (includeforms && Array.isArray(raw.forms)) {
    const seen = new Set([word.toLowerCase()]);
    for (const f of raw.forms) {
      const form = (f.form ?? '').trim();
      // Skip template/placeholder forms
      if (!form || form.length > 60 || form.includes('-') && form.length < 3) continue;
      if (/^[a-z][a-z-]+$/.test(form) && form.length < 5) continue; // template names
      const fl = form.toLowerCase();
      if (!seen.has(fl)) {
        seen.add(fl);
        forms.push(fl);
        if (forms.length >= MAX_FORMS) break;
      }
    }
  }

  const entry = {
    k: word.toLowerCase(),
    w: word,
    ...(pos    ? { p: pos }    : {}),
    ...(gender ? { g: gender } : {}),
    s: processedSenses,
    ...(ipa    ? { i: ipa }    : {}),
    ...(forms.length ? { f: forms } : {}),
  };

  return entry;
}

// ── Stream helpers ────────────────────────────────────────────────────────

async function* streamLines(url) {
  console.log(`Downloading: ${url}`);
  console.log('(This may take a while for large language files…)\n');

  // Node 18+ native fetch — set User-Agent so kaikki.org doesn't block CI runners
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Hoverleser-BuildScript/1.0 (https://github.com/o-i-z-y-s/hoverleser)' }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);

  // Check if gzip-encoded; fetch() auto-decompresses when Content-Encoding is set,
  // but kaikki.org serves raw JSONL, so we may need to handle .gz URLs separately.
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
  console.log(`Source   : ${opts.url}`);
  console.log(`Output   : ${opts.out}\n`);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });

  // Output stream — plain or gzip-compressed
  const rawStream = fs.createWriteStream(opts.out);
  const outStream = opts.compress
    ? (() => { const gz = zlib.createGzip({ level: 6 }); gz.pipe(rawStream); return gz; })()
    : rawStream;
  const write = line => new Promise((res, rej) =>
    outStream.write(line + '\n', err => err ? rej(err) : res())
  );

  let entryCount = 0;
  let formCount  = 0;
  let skipped    = 0;
  let lineNum    = 0;
  const seenKeys    = new Set(); // all seen lowercase keys
  const formOfKeys  = new Set(); // keys whose stored entry is currently form-of
  const formOfEntries = new Map(); // key → form count for form-of entries (for rollback)
  const t0       = Date.now();

  // Reserve line 0 for metadata (we'll rewrite the file header at the end)
  // Strategy: write entries first, then prepend metadata.
  // Easier: write to a temp file then prepend.
  const tmpPath = opts.out + '.tmp';
  const tmp     = fs.createWriteStream(tmpPath, 'utf8');
  const writeTmp = line => new Promise((res, rej) =>
    tmp.write(line + '\n', err => err ? rej(err) : res())
  );

  console.log('Processing entries…');

  try {
    for await (const line of streamLines(opts.url)) {
      lineNum++;
      if (!line.trim()) continue;

      let raw;
      try { raw = JSON.parse(line); }
      catch { skipped++; continue; }

      if (entryCount >= opts.max) break;

      const entry = processEntry(raw, opts.forms);
      if (!entry) { skipped++; continue; }

      // Deduplicate: prefer entries with real definitions over form-of entries.
      // Kaikki emits entries in arbitrary order; if the first entry for a key
      // is a form-of (e.g. "plural of X"), we store it, but if a later entry
      // for the same key has real senses we upgrade to that instead.
      const isFormOf = entry.s.every(s =>
        (s.gl ?? []).some(g => /^(\w[\w.()/-]*\s+)*of\s+\S/i.test(g))
      );
      if (seenKeys.has(entry.k)) {
        // Only upgrade if new entry has real senses and stored one was form-of
        if (!isFormOf && formOfKeys.has(entry.k)) {
          // Replace: write updated entry to tmp stream (will overwrite in DB)
          formOfKeys.delete(entry.k);
          formCount -= (formOfEntries.get(entry.k) ?? 0);
          formCount += (entry.f?.length ?? 0);
          formOfEntries.delete(entry.k);
          await writeTmp(JSON.stringify(entry));
        } else {
          skipped++;
        }
        continue;
      }
      seenKeys.add(entry.k);
      if (isFormOf) {
        formOfKeys.add(entry.k);
        formOfEntries.set(entry.k, entry.f?.length ?? 0);
      }

      formCount += (entry.f?.length ?? 0);
      entryCount++;

      await writeTmp(JSON.stringify(entry));

      if (entryCount % 10000 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`  ${entryCount.toLocaleString()} entries (${elapsed}s)…\r`);
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
                    version, entryCount, formCount };
  await write(JSON.stringify(meta));

  // Append tmp content
  const tmpContent = fs.readFileSync(tmpPath, 'utf8');
  await write(tmpContent.trimEnd());
  fs.unlinkSync(tmpPath);

  await new Promise((res, rej) => {
    outStream.on('finish', res);
    outStream.on('error', rej);
    outStream.end();
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeKb  = Math.round(fs.statSync(opts.out).size / 1024);

  console.log(`\n\n✓ Done in ${elapsed}s`);
  console.log(`  Entries : ${entryCount.toLocaleString()}`);
  console.log(`  Forms   : ${formCount.toLocaleString()}`);
  console.log(`  Skipped : ${skipped.toLocaleString()}`);
  console.log(`  Output  : ${opts.out} (${sizeKb.toLocaleString()} KB)`);
  const compressNote = opts.compress ? ' (gzip compressed)' : '';
  console.log(`\nNext steps:`);
  console.log(`  Drag ${opts.out} onto the extension popup to import, or`);
  console.log(`  host it somewhere and click "Download & Import".\n`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
