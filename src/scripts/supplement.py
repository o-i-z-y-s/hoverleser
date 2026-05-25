#!/usr/bin/env python3
"""
Hoverleser - Dictionary Supplement Script
==========================================
Merges two processed JSONL dictionaries (primary and supplement) into one
extended JSONL.  Any key present in the primary wins; gap entries from the
supplement have their German-language glosses machine-translated to English
with Argos Translate (offline, no API keys required).

Usage:
    python scripts/supplement.py \
        --primary    dist/de-en.jsonl \
        --supplement dist/de-de.jsonl \
        --out        dist/de-extended.jsonl

Options:
    --primary     <file>   Processed JSONL from en.wiktionary (English glosses)
    --supplement  <file>   Processed JSONL from de.wiktionary (German glosses)
    --out         <file>   Output path for the merged extended JSONL
    --progress    <n>      Print progress every N glosses (default: 64)
    --no-translate         Skip MT; keep German glosses as-is
    --cache-file  <file>   Persistent JSON cache for (de->en) gloss pairs

Gap entries' inflected forms ("f" field) are preserved in the output and
will be indexed into the forms store on import, making their inflections
searchable just like primary entries.

Gap entries are marked with "mt": true (currently ignored by the renderer).
Glosses that fail to translate are kept in German rather than aborting.

Requirements:
    pip install "argostranslate>=1.9,<3"

Language pack (~100 MB) is auto-downloaded on first run to:
    ~/.local/share/argos-translate/
"""

import argparse
import json
import os
import sys
import time


def parse_args():
    p = argparse.ArgumentParser(
        description='Supplement Hoverleser dictionary with de.wiktionary gap entries'
    )
    p.add_argument('--primary',      required=True)
    p.add_argument('--supplement',   required=True)
    p.add_argument('--out',          required=True)
    p.add_argument('--progress',     type=int, default=64)
    p.add_argument('--no-translate', action='store_true')
    p.add_argument('--cache-file',   default=None,
                   help='Path to persistent JSON translation cache (loaded and updated)')
    return p.parse_args()


def iter_jsonl(path):
    with open(path, 'r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def read_jsonl(path):
    objs = list(iter_jsonl(path))
    if not objs:
        return None, []
    meta = objs[0] if objs[0].get('type') == 'meta' else None
    start = 1 if meta else 0
    return meta, objs[start:]


def ensure_argos_package(src_lang='de', tgt_lang='en'):
    try:
        from argostranslate import package as pkg
        from argostranslate import translate
    except ImportError:
        print('ERROR: argostranslate not installed.', file=sys.stderr)
        print('Run: pip install "argostranslate>=1.9,<3"', file=sys.stderr)
        sys.exit(1)

    installed = translate.get_installed_languages()
    src_obj = next((l for l in installed if l.code == src_lang), None)
    tgt_obj = next((l for l in installed if l.code == tgt_lang), None)

    if src_obj and tgt_obj and src_obj.get_translation(tgt_obj):
        print(f'[argos] {src_lang}->{tgt_lang} package already installed.')
        return

    print(f'[argos] Downloading {src_lang}->{tgt_lang} language package (~100 MB)...')
    pkg.update_package_index()
    available = pkg.get_available_packages()
    target = next(
        (p for p in available if p.from_code == src_lang and p.to_code == tgt_lang),
        None,
    )
    if target is None:
        print(f'ERROR: No argostranslate package found for {src_lang}->{tgt_lang}',
              file=sys.stderr)
        sys.exit(1)
    pkg.install_from_path(target.download())
    print('[argos] Package installed.')


def make_translator():
    from argostranslate import translate
    installed = translate.get_installed_languages()
    de = next((l for l in installed if l.code == 'de'), None)
    en = next((l for l in installed if l.code == 'en'), None)
    if de is None or en is None:
        raise RuntimeError('de or en language not available in argostranslate')
    translation = de.get_translation(en)
    if translation is None:
        raise RuntimeError('No de->en translation path found')
    return translation.translate


def translate_glosses(entries, translator, cache_file=None, progress_interval=64):
    """
    Translate all gloss strings in-place; add mt=True to each entry.

    Two layers of efficiency:
      1. Persistent cache: a JSON file stores (German -> English) pairs across
         runs.  Glosses seen in a previous run are never re-translated.
      2. In-run dedup: identical strings within this run are translated once
         and the result reused for every duplicate slot.

    Per-gloss exceptions keep the original German rather than aborting.
    """
    # Load persistent cache from disk
    cache = {}
    if cache_file and os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as fh:
                cache = json.load(fh)
            print(f'[translate] Loaded {len(cache)} cached translations from {cache_file}')
        except Exception as exc:
            print(f'[translate] WARNING: could not load cache ({exc!r}); starting fresh')

    # Phase 1: collect (ei, si, gi, text) positions; build unique-uncached queue
    positions    = []   # (ei, si, gi, original_text)
    to_translate = []   # unique strings not yet in cache
    queued       = set()

    for ei, entry in enumerate(entries):
        for si, sense in enumerate(entry.get('s', [])):
            for gi, gl in enumerate(sense.get('gl', [])):
                if gl and isinstance(gl, str):
                    positions.append((ei, si, gi, gl))
                    if gl not in cache and gl not in queued:
                        queued.add(gl)
                        to_translate.append(gl)

    total      = len(to_translate)
    in_cache   = sum(1 for pos in positions if pos[3] in cache)
    duplicates = len(positions) - in_cache - total

    print(f'[translate] {len(positions)} gloss slots across {len(entries)} gap entries')
    print(f'[translate] {total} to translate  |  {in_cache} from cache  |  {duplicates} in-run duplicates')

    # Phase 2: translate unique uncached strings
    errors = 0
    for idx, text in enumerate(to_translate):
        try:
            cache[text] = translator(text)
        except Exception as exc:
            cache[text] = text
            errors += 1
            print(f'\n[translate] WARNING: gloss {idx} failed ({exc!r}); keeping original',
                  flush=True)
        if (idx + 1) % progress_interval == 0 or (idx + 1) == total:
            pct = (idx + 1) / total * 100
            print(f'[translate] {idx + 1}/{total} ({pct:.1f}%)', end='\r', flush=True)

    if total:
        print()
    else:
        print('[translate] All glosses served from cache, no inference needed')
    if errors:
        print(f'[translate] {errors} glosses kept in German due to translation errors')

    # Save updated cache to disk
    if cache_file:
        try:
            cache_dir = os.path.dirname(os.path.abspath(cache_file))
            if cache_dir:
                os.makedirs(cache_dir, exist_ok=True)
            with open(cache_file, 'w', encoding='utf-8') as fh:
                json.dump(cache, fh, ensure_ascii=False)
            print(f'[translate] Saved {len(cache)} translations to {cache_file}')
        except Exception as exc:
            print(f'[translate] WARNING: could not save cache ({exc!r})')

    # Phase 3: write translations back using the cache
    for ei, si, gi, text in positions:
        entries[ei]['s'][si]['gl'][gi] = cache.get(text, text)

    for entry in entries:
        entry['mt'] = True

    return entries


def main():
    args = parse_args()

    print(f'[load] Reading primary: {args.primary}')
    primary_meta, primary_entries = read_jsonl(args.primary)
    print(f'[load] Primary: {len(primary_entries)} entries')

    print(f'[load] Reading supplement: {args.supplement}')
    _supp_meta, supplement_entries = read_jsonl(args.supplement)
    print(f'[load] Supplement: {len(supplement_entries)} entries')

    # Dedup on (k, p) pairs so same-word different-POS supplement entries
    # (e.g. 'sein' verb vs 'sein' possessive det) are NOT excluded -- they
    # flow through dedupeStreamBatch in background.js and land in _extra.
    primary_kp  = {(e['k'], e.get('p')) for e in primary_entries}
    gap_entries = [e for e in supplement_entries
                   if (e.get('k'), e.get('p')) not in primary_kp]
    print(f'[diff] Gap entries (supplement only): {len(gap_entries)}')

    if args.no_translate:
        print('[translate] Skipping MT (--no-translate)')
        for e in gap_entries:
            e['mt'] = True
    else:
        ensure_argos_package('de', 'en')
        translator = make_translator()
        t0 = time.time()
        gap_entries = translate_glosses(gap_entries, translator,
                                        cache_file=args.cache_file,
                                        progress_interval=args.progress)
        print(f'[translate] Done in {time.time() - t0:.1f}s')

    all_entries = primary_entries + gap_entries
    total_entries = len(all_entries)

    # Gap entries' 'f' fields ARE preserved and WILL be indexed by the importer.
    gap_form_count = sum(len(e.get('f', [])) for e in gap_entries)

    if primary_meta:
        out_meta = dict(primary_meta)
    else:
        out_meta = {'type': 'meta', 'lang': 'German', 'langCode': 'de'}

    out_meta['entryCount'] = total_entries
    out_meta['formCount'] = out_meta.get('formCount', 0) + gap_form_count

    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    print(f'[write] Writing {total_entries} entries to {args.out}')
    with open(args.out, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(out_meta, ensure_ascii=False) + '\n')
        for entry in all_entries:
            fh.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f'[done] Extended dictionary: {total_entries} entries '
          f'({len(primary_entries)} primary + {len(gap_entries)} gap/translated)')


if __name__ == '__main__':
    main()
