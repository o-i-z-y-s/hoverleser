/**
 * hoverleser – Content Script
 *
 * Detects the word under the mouse cursor, highlights it, and displays a
 * floating popup (rendered in a Shadow DOM for style isolation) showing
 * the translation/definition from the local dictionary DB.
 *
 * Design mirrors 10ten Japanese Reader:
 *   • caretRangeFromPoint  → find text node + caret offset
 *   • Language-aware word boundary walk  → extract the word token
 *   • background.js owns the DB  → this script sends 'lookup' messages
 *   • Shadow DOM  → page CSS cannot affect the popup appearance
 *   • Progressive substring shortening handled by background.js
 */

(function () {
  'use strict';

  if (window.__hoverleserLoaded) return;
  window.__hoverleserLoaded = true;

  // ── Language configurations ──────────────────────────────────────────────
  // Each entry defines a regex that matches a single "word character" for
  // that language.  The content script uses the active language from settings.
  const LANG_CONFIGS = {
    de: { name: 'German',  wordChar: /[A-Za-zÄÖÜäöüß\u00C0-\u024F]/ },
    fr: { name: 'French',  wordChar: /[A-Za-zÀ-ÿœæŒÆ]/ },
    es: { name: 'Spanish', wordChar: /[A-Za-zÁÉÍÓÚáéíóúñÑüÜ]/ },
    nl: { name: 'Dutch',   wordChar: /[A-Za-zÀ-ÿ]/ },
    it: { name: 'Italian', wordChar: /[A-Za-zÀ-ÿ]/ },
    pt: { name: 'Portuguese', wordChar: /[A-Za-zÀ-ÿ]/ },
    ru: { name: 'Russian', wordChar: /[\u0400-\u04FF]/ },
    zh: { name: 'Chinese', wordChar: /[\u4E00-\u9FFF\u3400-\u4DBF]/ },
    ja: { name: 'Japanese', wordChar: /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/ },
  };

  // ── State ────────────────────────────────────────────────────────────────
  let settings    = { enabled: true, langCode: 'de', showIpa: true, showTags: true, showGender: true, maxSenses: 3 };
  let currentWord = null;   // word string currently shown
  let hoverTimer  = null;
  let lastX = 0, lastY = 0;

  // Simple LRU cache so we don't hit the background for the same word twice
  const CACHE_LIMIT = 300;
  const resultCache = new Map();

  // ── Shadow DOM setup ─────────────────────────────────────────────────────
  // We create a host element and attach a closed shadow root so page styles
  // cannot bleed in.  The host itself is styled to be non-intrusive.

  const host = document.createElement('div');
  host.id = 'hoverleser-host';
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'z-index: 2147483647',
    'pointer-events: none',
    'display: block',
    'top: 0',
    'left: 0',
    'width: 0',
    'height: 0',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'closed' });

  // ── Popup template ───────────────────────────────────────────────────────
  const POPUP_CSS = `
    :host { all: initial; }

    #popup {
      display: none;
      position: fixed;
      z-index: 2147483647;
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      max-width: 360px;
      min-width: 180px;
      background: #1e1e1e;
      color: #d4d4d4;
      border: 1px solid #333;
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7), 0 2px 8px rgba(0,0,0,0.4);
      overflow: hidden;
      pointer-events: none;
      animation: hd-in 0.12s ease;
    }
    @keyframes hd-in {
      from { opacity:0; transform: translateY(5px); }
      to   { opacity:1; transform: translateY(0); }
    }

    /* ── Header ── */
    .hd-head {
      padding: 9px 13px 7px;
      background: #181818;
      border-bottom: 1px solid #2e2e2e;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .hd-word {
      font-size: 19px;
      font-weight: 700;
      color: #f0f0f0;
      letter-spacing: 0.2px;
    }
    .hd-pos {
      font-size: 11px;
      color: #777;
      font-style: italic;
    }
    .hd-gender {
      font-size: 11px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
    }
    .hd-gender-m { background:#1e2e3d; color:#82b4e0; }
    .hd-gender-f { background:#3a1a28; color:#e8a0bc; }
    .hd-gender-n { background:#1a2a1a; color:#88d8a0; }

    /* ── IPA ── */
    .hd-ipa {
      padding: 3px 13px 0;
      font-size: 11px;
      color: #777;
      font-family: monospace;
      border-bottom: 1px solid #282828;
    }

    /* ── Senses ── */
    .hd-senses { padding: 6px 0 8px; }
    .hd-sense  { display: flex; padding: 3px 13px; gap: 9px; }
    .hd-sense-num {
      flex-shrink: 0; font-size: 10px; color: #666;
      margin-top: 3px; min-width: 14px; text-align: right;
    }
    .hd-sense-body {}
    .hd-gloss {
      color: #a8d880;
      font-weight: 500;
      font-size: 13.5px;
    }

    /* ── Separator between entries ── */
    .hd-sep {
      border: none;
      border-top: 1px solid #282828;
      margin: 4px 0;
    }

    /* ── Tag row (grammatical badges) ── */
    .hd-tags-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px 13px 6px;
    }
    .hd-gram-tag {
      display: inline-block;
      background: #2a2a2a;
      color: #888;
      border: 1px solid #3a3a3a;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      padding: 2px 5px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    /* ── Separator between compound segments ── */
    .hd-seg-sep {
      border: none;
      border-top: 2px solid #333;
      margin: 6px 0;
    }

    /* ── Compound segment label ── */
    .hd-compound-label {
      padding: 2px 13px 0;
      font-size: 10px;
      color: #888;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    /* ── Footer ── */
    .hd-foot {
      padding: 4px 13px 6px;
      font-size: 10px;
      color: #5a5a5a;
      border-top: 1px solid #2a2a2a;
    }

    /* ── Loading state ── */
    .hd-loading {
      padding: 10px 13px;
      color: #666;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hd-spinner {
      width: 11px; height: 11px;
      border: 2px solid #333;
      border-top-color: #888;
      border-radius: 50%;
      animation: hd-spin 0.7s linear infinite;
    }
    @keyframes hd-spin { to { transform: rotate(360deg); } }

    /* ── Not found ── */
    .hd-notfound { padding: 10px 13px; color: #ef4444; font-size: 12px; }

    .hd-entries { }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = POPUP_CSS;
  shadow.appendChild(styleEl);

  const popup = document.createElement('div');
  popup.id = 'popup';
  shadow.appendChild(popup);

  // ── Highlight overlay (lives on the page, not Shadow DOM) ────────────────
  const highlight = document.createElement('div');
  highlight.id = 'hoverleser-highlight';
  highlight.style.cssText = [
    'all: initial',
    'position: absolute',
    'z-index: 2147483644',
    'background: rgba(147,197,253,0.18)',
    'border-bottom: 2px solid rgba(147,197,253,0.6)',
    'border-radius: 2px',
    'pointer-events: none',
    'display: none',
  ].join(';');

  // ── Inject into DOM ──────────────────────────────────────────────────────
  function injectElements() {
    if (document.body) {
      document.body.appendChild(host);
      document.body.appendChild(highlight);
    } else {
      document.addEventListener('DOMContentLoaded', injectElements, { once: true });
    }
  }
  injectElements();

  // ── Load settings ─────────────────────────────────────────────────────────
  browser.runtime.sendMessage({ type: 'get-settings' })
    .then(s => { if (s) settings = s; })
    .catch(() => {});

  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'settings-changed') {
      settings = msg.settings;
      if (!settings.enabled) clear();
    }
  });

  // ── Word boundary detection ──────────────────────────────────────────────

  /**
   * Returns { word, range } for the text token under (clientX, clientY),
   * or null if not on a word.
   */
  function getWordAtPoint(clientX, clientY) {
    let node, offset;

    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(clientX, clientY);
      if (!r) return null;
      node   = r.startContainer;
      offset = r.startOffset;
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(clientX, clientY);
      if (!pos) return null;
      node   = pos.offsetNode;
      offset = pos.offset;
    } else {
      return null;
    }

    if (!node || node.nodeType !== Node.TEXT_NODE) return null;

    const text    = node.textContent || '';
    const langCfg = LANG_CONFIGS[settings.langCode] ?? LANG_CONFIGS.de;
    const isWord  = ch => langCfg.wordChar.test(ch);

    // If the caret landed on a non-word character (e.g. the hyphen in
    // "selbst-entwickelte"), nudge one position right before giving up.
    // caretRangeFromPoint often places the caret ON a hyphen when the mouse
    // is just past it, making the first char of the next component invisible.
    if (offset < text.length && !isWord(text[offset]) && isWord(text[offset + 1] ?? '')) {
      offset += 1;
    }
    if (offset >= text.length || !isWord(text[offset])) return null;

    // Expand left — stop at hyphens so each part of a hyphenated compound
    // is looked up independently when the cursor moves across it.
    let start = offset;
    while (start > 0 && isWord(text[start - 1])) start--;

    // Expand right
    let end = offset + 1;
    while (end < text.length && isWord(text[end])) end++;

    const word = text.slice(start, end);
    if (word.length < 2) return null;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);

    // Verify the cursor is actually over the word's bounding rect.
    // caretRangeFromPoint snaps to the nearest character even when the pointer
    // is in surrounding whitespace, causing premature triggering when approaching
    // a word from the left or right. A small horizontal tolerance (2px) handles
    // sub-pixel rendering without re-introducing the early-trigger issue.
    const wordRect = range.getBoundingClientRect();
    const TOLERANCE = 2;
    if (
      clientX < wordRect.left  - TOLERANCE ||
      clientX > wordRect.right + TOLERANCE ||
      clientY < wordRect.top   - TOLERANCE ||
      clientY > wordRect.bottom + TOLERANCE
    ) return null;

    return { word, range };
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  function cacheGet(word, langCode) {
    return resultCache.get(`${langCode}:${word}`) ?? undefined;
  }

  function cacheSet(word, langCode, value) {
    if (resultCache.size >= CACHE_LIMIT) {
      resultCache.delete(resultCache.keys().next().value);
    }
    resultCache.set(`${langCode}:${word}`, value);
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  async function lookup(word) {
    const langCode = settings.langCode;
    const cached   = cacheGet(word, langCode);
    if (cached !== undefined) return cached;

    const result = await browser.runtime.sendMessage({ type: 'lookup', word, langCode });
    cacheSet(word, langCode, result ?? null);
    return result ?? null;
  }

  // ── Popup rendering ───────────────────────────────────────────────────────

  const GENDER_LABELS = { m: 'der', f: 'die', n: 'das' };
  const GENDER_CLASS  = { m: 'hd-gender-m', f: 'hd-gender-f', n: 'hd-gender-n' };

  function renderLoading(word) {
    popup.innerHTML = `
      <div class="hd-head">
        <span class="hd-word">${esc(word)}</span>
      </div>
      <div class="hd-loading">
        <span class="hd-spinner"></span>Looking up…
      </div>`;
    popup.style.display = 'block';
  }

  function renderNotFound(word) {
    popup.innerHTML = `
      <div class="hd-head">
        <span class="hd-word">${esc(word)}</span>
      </div>
      <div class="hd-notfound">Not found in dictionary</div>`;
    popup.style.display = 'block';
  }

  // Canonical tag order for the unified tag row.
  // Earlier position = higher priority in display.
  const TAG_ORDER = [
    'plural','singular',
    'nominative','accusative','dative','genitive',
    'comparative','superlative',
    'strong','weak','mixed',
    'transitive','intransitive',
    'past','present','future',
    'indicative','subjunctive','imperative','participle',
    'first-person','second-person','third-person',
  ];

  function buildTagRow(entry) {
    // Merge gramTags (from form-of resolution) with relevant sense-level t-tags.
    // Deduplicate and sort by TAG_ORDER; unlisted tags go at the end alphabetically.
    const seen = new Set();
    const merged = [];

    const addTag = t => {
      const lt = t.toLowerCase().trim();
      if (!lt || seen.has(lt)) return;
      seen.add(lt);
      merged.push(lt);
    };

    // gramTags first (they come from authoritative form_of data)
    for (const t of (entry.gramTags ?? [])) addTag(t);

    // Sense-level t-tags — skip generic noise we don't want to badge
    const T_NOISE = new Set(['form-of','canonical','error-unknown-tag','with-dative','with-accusative','with-genitive']);
    for (const sense of (entry.s ?? [])) {
      for (const t of (sense.t ?? [])) {
        if (!T_NOISE.has(t)) addTag(t);
      }
    }

    if (merged.length === 0) return '';

    const sorted = merged.sort((a, b) => {
      const ai = TAG_ORDER.indexOf(a);
      const bi = TAG_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return  1;
      return a.localeCompare(b);
    });

    const badges = sorted.map(t => `<span class="hd-gram-tag">${esc(t)}</span>`).join('');
    return `<div class="hd-tags-row">${badges}</div>`;
  }

  function renderEntries(entries) {
    let html = '';
    entries.forEach((entry, idx) => {
      if (idx > 0) html += '<hr class="hd-sep">';

      const genderLabel = GENDER_LABELS[entry.g] ?? '';
      const genderClass = GENDER_CLASS[entry.g]  ?? '';
      html += `<div class="hd-head">
        <span class="hd-word">${esc(entry.w)}</span>
        ${(entry.g && settings.showGender !== false) ? `<span class="hd-gender ${genderClass}">${esc(genderLabel)}</span>` : ''}
        <span class="hd-pos">${esc(entry.p ?? '')}</span>
      </div>`;

      // Unified, ordered tag row — one per entry, directly below the word header
      if (settings.showTags !== false) html += buildTagRow(entry);

      if (settings.showIpa && entry.i) {
        html += `<div class="hd-ipa">${esc(entry.i)}</div>`;
      }
      if (Array.isArray(entry.s) && entry.s.length) {
        html += '<div class="hd-senses">';
        const senses = entry.s.slice(0, settings.maxSenses ?? 3);
        senses.forEach((sense, i) => {
          const gloss = Array.isArray(sense.gl) ? sense.gl.join('; ') : String(sense);
          html += `
            <div class="hd-sense">
              <span class="hd-sense-num">${senses.length > 1 ? i + 1 : ''}</span>
              <div class="hd-sense-body">
                <div class="hd-gloss">${esc(gloss)}</div>
              </div>
            </div>`;
        });
        html += '</div>';
      }
    });
    return html;
  }

  function renderResult(lookupResult) {
    // Support both { segments } (compound) and legacy { matchedText, entries }
    const segments = lookupResult.segments ?? [
      { matchedText: lookupResult.matchedText, entries: lookupResult.entries }
    ];

    let html = '';

    segments.forEach((seg, si) => {
      if (si > 0) {
        html += '<hr class="hd-seg-sep">';
      }

      html += renderEntries(seg.entries);
    });

    html += `<div class="hd-foot">Wiktionary · CC BY-SA</div>`;
    popup.innerHTML = html;
    popup.style.display = 'block';
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Popup positioning ─────────────────────────────────────────────────────

  function placePopup(clientX, clientY) {
    const PAD = 12;
    popup.style.left = '0';
    popup.style.top  = '0';
    popup.style.display = 'block';

    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = clientX + PAD;
    let y = clientY + 22 + PAD;  // below cursor

    if (x + pw > vw - PAD) x = clientX - pw - PAD;
    if (y + ph > vh - PAD) y = clientY - ph - PAD;
    x = Math.max(PAD, x);
    y = Math.max(PAD, y);

    popup.style.left = `${x}px`;
    popup.style.top  = `${y}px`;
  }

  // ── Highlight ─────────────────────────────────────────────────────────────

  function showHighlight(rect) {
    const sx = window.scrollX, sy = window.scrollY;
    highlight.style.cssText = [
      'all: initial',
      'position: absolute',
      'z-index: 2147483644',
      'background: rgba(200,200,200,0.10)',
      'border-bottom: 2px solid rgba(168,216,128,0.7)',
      'border-radius: 2px',
      'pointer-events: none',
      `left: ${rect.left + sx}px`,
      `top: ${rect.top + sy}px`,
      `width: ${rect.width}px`,
      `height: ${rect.height}px`,
      'display: block',
    ].join(';');
  }

  // ── Clear / hide ──────────────────────────────────────────────────────────

  function clear() {
    clearTimeout(hoverTimer);
    popup.style.display    = 'none';
    highlight.style.display = 'none';
    currentWord = null;
  }

  // ── Mouse event handlers ──────────────────────────────────────────────────

  document.addEventListener('mousemove', async e => {
    if (!settings.enabled) return;

    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.target?.isContentEditable) return;

    lastX = e.clientX;
    lastY = e.clientY;

    clearTimeout(hoverTimer);

    // Fast-clear if pointer is provably outside the current highlight rect —
    // no need to wait for getWordAtPoint when we can dismiss immediately.
    if (currentWord && highlight.style.display !== 'none') {
      const hr = highlight.getBoundingClientRect();
      const MARGIN = 6;
      if (
        e.clientX < hr.left   - MARGIN ||
        e.clientX > hr.right  + MARGIN ||
        e.clientY < hr.top    - MARGIN ||
        e.clientY > hr.bottom + MARGIN
      ) {
        clear();
        return;
      }
    }

    const wordInfo = getWordAtPoint(e.clientX, e.clientY);

    if (!wordInfo) {
      // Short linger so cursor can move between lines without flickering.
      hoverTimer = setTimeout(clear, 30);
      return;
    }

    // Same word — just reposition the popup if it's visible
    if (wordInfo.word === currentWord) {
      if (popup.style.display === 'block') placePopup(lastX, lastY);
      return;
    }

    currentWord = wordInfo.word;

    // Capture range rect now (valid while we still have the range object)
    const rect = wordInfo.range.getBoundingClientRect();

    // Fire lookup immediately — IndexedDB is local so results come back fast.
    // We intentionally do NOT show highlight or popup until a result is found:
    // that way only words that exist in the chosen language's dictionary are
    // ever highlighted, matching 10ten's behaviour.
    (async () => {
      const word = wordInfo.word;

      // Cache hit — synchronous path, no flicker
      const cached = cacheGet(word, settings.langCode);
      if (cached !== undefined) {
        if (currentWord !== word) return;
        if (cached) {
          if (rect.width > 0) showHighlight(rect);
          renderResult(cached);
          placePopup(lastX, lastY);
        }
        // null cache entry = known miss, show nothing
        return;
      }

      // DB lookup (fast — local IndexedDB, typically <5 ms)
      const result = await lookup(word);
      if (currentWord !== word) return; // word changed while awaiting

      if (result) {
        if (rect.width > 0) showHighlight(rect);
        renderResult(result);
        placePopup(lastX, lastY);
      }
      // No result = not in dictionary, show nothing (no highlight)
    })();
  }, { passive: true });

  document.addEventListener('mouseleave', clear);

  document.addEventListener('scroll', () => {
    popup.style.display    = 'none';
    highlight.style.display = 'none';
    currentWord = null;
  }, { passive: true, capture: true });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') clear();
  });

})();
