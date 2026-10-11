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
 *   • Compound word splitting handled by background.js (German only)
 */

(function () {
  'use strict';

  if (window.__hoverleserLoaded) return;
  window.__hoverleserLoaded = true;

  // ── Language configurations ──────────────────────────────────────────────
  // Each entry defines a regex that matches a single "word character" for
  // that language.  The content script uses the active language from settings.
  const LANG_CONFIGS = {
    de: { wordChar: /[A-Za-zÄÖÜäöüß\u00C0-\u024F]/ },
    fr: { wordChar: /[A-Za-zÀ-ÿœæŒÆ]/ },
    es: { wordChar: /[A-Za-zÁÉÍÓÚáéíóúñÑüÜ]/ },
    nl: { wordChar: /[A-Za-zÀ-ÿ]/ },
    it: { wordChar: /[A-Za-zÀ-ÿ]/ },
    pt: { wordChar: /[A-Za-zÀ-ÿ]/ },
    ru: { wordChar: /[\u0400-\u04FF]/ },
    zh: { wordChar: /[\u4E00-\u9FFF\u3400-\u4DBF]/ },
    ja: { wordChar: /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/ },
  };

  // ── State ────────────────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    enabled: false, langCode: 'de', showIpa: true, showTags: true, showGender: true,
    maxSenses: 3, keepOpen: false, showLeo: true,
  };
  let settings    = { ...DEFAULT_SETTINGS };
  let currentWord = null;   // cache key (see cacheKey) of the word currently shown
  let hoverTimer  = null;
  let lastX = 0, lastY = 0;
  let frozen      = false;  // Shift is held over a shown popup

  // Simple FIFO cache so we don't hit the background for the same word twice
  const CACHE_LIMIT = 300;
  const resultCache = new Map();

  // ── Shadow DOM setup ─────────────────────────────────────────────────────
  // The popup lives in a shadow root so page styles cannot bleed in; the root
  // is closed so page scripts cannot reach into it. The host itself is styled
  // to be non-intrusive.

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
    .hd-gloss {
      color: #a8d880;
      font-weight: 500;
      font-size: 13.5px;
    }

    /* ── Derivation: the base a derived word was built from ── */
    .hd-derivation {
      padding: 2px 13px 0;
      font-size: 12px;
      color: #9a9a9a;
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
    /* A match the dictionary does not record (entry.inferred) */
    .hd-inferred {
      border-style: dashed;
      color: #b8a05a;
    }

    /* ── Separator between compound segments ── */
    .hd-seg-sep {
      border: none;
      border-top: 2px solid #333;
      margin: 6px 0;
    }

    /* ── Footer ── */
    .hd-foot {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      padding: 4px 13px 6px;
      font-size: 10px;
      color: #5a5a5a;
      border-top: 1px solid #2a2a2a;
    }
    .hd-leo {
      all: unset;
      cursor: pointer;
      font-size: 11px;
      color: #7aa7d8;
    }
    .hd-leo:hover { text-decoration: underline; }

  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = POPUP_CSS;
  shadow.appendChild(styleEl);

  const popup = document.createElement('div');
  popup.id = 'popup';
  shadow.appendChild(popup);
  // Pages often close menus or start drags on mousedown anywhere; a press on
  // the popup should not reach them.
  popup.addEventListener('mousedown', e => e.stopPropagation());

  // ── Highlight overlay (lives on the page, not Shadow DOM) ────────────────
  // Hidden until showHighlight gives it its position and appearance.
  const highlight = document.createElement('div');
  highlight.id = 'hoverleser-highlight';
  highlight.style.cssText = 'all: initial; display: none';

  // ── Inject into / remove from DOM ───────────────────────────────────────
  function injectElements() {
    if (host.parentNode) return; // already injected
    if (document.body) {
      document.body.appendChild(host);
      document.body.appendChild(highlight);
    } else {
      document.addEventListener('DOMContentLoaded', injectElements, { once: true });
    }
  }

  function removeElements() {
    host.remove();
    highlight.remove();
    clear();
  }

  // ── Load settings ─────────────────────────────────────────────────────────
  // Inject into the DOM only if the extension is enabled; this avoids
  // polluting pages with extension elements when the user has disabled it.
  browser.runtime.sendMessage({ type: 'get-settings' })
    .then(s => {
      if (s) settings = s;
      if (settings.enabled) injectElements();
    })
    .catch(() => {});

  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'settings-changed') {
      const wasEnabled = settings.enabled;
      settings = msg.settings;
      if (settings.enabled && !wasEnabled) injectElements();
      if (!settings.enabled && wasEnabled) removeElements();
    }
  });

  // Fast-path settings sync: react to storage writes directly so the update
  // is visible before popup.js finishes its tab-query + broadcast loop.
  // This closes the timing window where a mousemove between toggle-click and
  // message delivery can show the popup for a shared EN/DE word (Motor, Job…).
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const wasEnabled = settings.enabled;
    const next = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue ?? {}) };
    settings = next;
    if (settings.enabled && !wasEnabled) injectElements();
    if (!settings.enabled && wasEnabled) removeElements();
  });

  // ── Word boundary detection ──────────────────────────────────────────────

  // Characters that can stand between the end of one sentence and the first
  // word of the next: spaces, quotes, brackets, and dashes.
  const SENTENCE_GAP = /[\s"'„“”‚‘’«»‹›()[\]\u2013\u2014-]+$/;

  /**
   * True when the word that starts at `start` may be the first word of a
   * sentence, where German capitalizes every word, noun or not. A text node
   * also begins after inline markup (a link, bold text), so the start of the
   * node counts as a possible sentence start.
   */
  function startsSentence(text, start) {
    const before = text.slice(0, start).replace(SENTENCE_GAP, '');
    return before === '' || /[.!?:…]$/.test(before);
  }

  /**
   * Returns { word, range, sentenceInitial } for the text token under
   * (clientX, clientY), or null if not on a word.
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

    // Expand left; stop at hyphens so each part of a hyphenated compound
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
    // a word from the left or right. A small tolerance (2px) handles
    // sub-pixel rendering without re-introducing the early-trigger issue.
    const wordRect = range.getBoundingClientRect();
    const TOLERANCE = 2;
    if (
      clientX < wordRect.left  - TOLERANCE ||
      clientX > wordRect.right + TOLERANCE ||
      clientY < wordRect.top   - TOLERANCE ||
      clientY > wordRect.bottom + TOLERANCE
    ) return null;

    return { word, range, sentenceInitial: startsSentence(text, start) };
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  /**
   * The position in the sentence changes the answer only for a capitalized
   * word (see caseHint in background.js), so only then is it part of the key.
   */
  function cacheKey({ word, sentenceInitial }) {
    const capitalized = word[0] !== word[0].toLowerCase();
    return `${settings.langCode}:${sentenceInitial && capitalized ? '^' : ''}${word}`;
  }

  function cacheSet(key, value) {
    if (resultCache.size >= CACHE_LIMIT) {
      resultCache.delete(resultCache.keys().next().value);
    }
    resultCache.set(key, value);
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  async function lookup(wordInfo) {
    const key = cacheKey(wordInfo);
    const result = await browser.runtime.sendMessage({
      type: 'lookup',
      word: wordInfo.word,
      langCode: settings.langCode,
      sentenceInitial: wordInfo.sentenceInitial,
    });
    cacheSet(key, result ?? null);
    return result ?? null;
  }

  // ── Popup rendering ───────────────────────────────────────────────────────

  const GENDER_LABELS = { m: 'der', f: 'die', n: 'das' };
  const GENDER_CLASS  = { m: 'hd-gender-m', f: 'hd-gender-f', n: 'hd-gender-n' };

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

  // Sense tags that describe the word as a whole (its inflection class, its
  // valency, the form a stub stands for) and so belong in the tag row. Tags
  // about a single meaning ("figuratively", "Austria", "usually") are left
  // out: on the row they would read as true of every sense.
  const ROW_SENSE_TAGS = new Set([
    ...TAG_ORDER,
    'preterite', 'subjunctive-i', 'subjunctive-ii', 'infinitive', 'gerund',
    'irregular', 'class-1', 'class-2', 'class-3', 'class-4', 'class-5', 'class-6', 'class-7',
    'reflexive', 'impersonal', 'ditransitive',
    'not-comparable', 'indeclinable', 'no-plural', 'plural-only', 'uncountable',
    'diminutive', 'definite', 'indefinite', 'cardinal', 'ordinal',
  ]);

  /**
   * Minimal element builder. Everything below constructs DOM nodes rather than
   * HTML strings: dictionary glosses are third-party text, and building nodes
   * means no markup in that text can ever be parsed. It also clears AMO's
   * "Unsafe assignment to innerHTML" review warning.
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== '') node.textContent = String(text);
    return node;
  }

  /**
   * The tag row for one entry: how the hovered word relates to the entry
   * (gramTags), then word-level tags of the senses actually shown.
   * Deduplicated and sorted by TAG_ORDER; unlisted tags go at the end
   * alphabetically. An inferred entry leads with an "inferred" badge.
   */
  function buildTagRow(entry, shownSenses) {
    const seen = new Set();
    const merged = [];

    const addTag = t => {
      const lt = t.toLowerCase().trim();
      if (!lt || seen.has(lt)) return;
      seen.add(lt);
      merged.push(lt);
    };

    for (const t of (entry.gramTags ?? [])) addTag(t);
    for (const sense of shownSenses) {
      for (const t of (sense.t ?? [])) {
        if (ROW_SENSE_TAGS.has(t)) addTag(t);
      }
    }

    if (merged.length === 0 && !entry.inferred) return null;

    const sorted = merged.sort((a, b) => {
      const ai = TAG_ORDER.indexOf(a);
      const bi = TAG_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return  1;
      return a.localeCompare(b);
    });

    const row = el('div', 'hd-tags-row');
    if (entry.inferred) row.append(el('span', 'hd-gram-tag hd-inferred', 'inferred'));
    for (const t of sorted) row.append(el('span', 'hd-gram-tag', t));
    return row;
  }

  function renderEntries(entries) {
    const frag = document.createDocumentFragment();
    // Distribute sense budget across all POS entries in this segment.
    // Each entry gets at least 1 sense; surplus goes to earlier entries.
    // This prevents a word with many POS blocks (e.g. verb + pronoun) from
    // exceeding the user-chosen maxSenses total.
    const maxTotal = settings.maxSenses ?? 3;
    const n      = entries.length;
    const base   = Math.floor(maxTotal / n);
    const extras = maxTotal % n;
    const budgets = entries.map((_, i) => Math.max(1, base + (i < extras ? 1 : 0)));

    entries.forEach((entry, idx) => {
      if (idx > 0) frag.append(el('hr', 'hd-sep'));

      // A derived word (börslich from Börse + -lich) is headed by itself; the
      // senses, pronunciation, and sense tags below belong to its base.
      const derived = entry.derivation;
      const shown   = derived ? { w: derived.word, p: derived.p, g: derived.g } : entry;

      const genderLabel = GENDER_LABELS[shown.g] ?? '';
      const genderClass = GENDER_CLASS[shown.g]  ?? '';
      const head = el('div', 'hd-head');
      head.append(el('span', 'hd-word', shown.w));
      if (shown.g && settings.showGender !== false) {
        head.append(el('span', `hd-gender ${genderClass}`, genderLabel));
      }
      head.append(el('span', 'hd-pos', shown.p ?? ''));
      frag.append(head);

      const senses = (Array.isArray(entry.s) ? entry.s : []).slice(0, budgets[idx]);

      // Unified, ordered tag row; one per entry, directly below the word header
      if (settings.showTags !== false) {
        const tagRow = buildTagRow(entry, derived ? [] : senses);
        if (tagRow) frag.append(tagRow);
      }

      if (derived) {
        frag.append(el('div', 'hd-derivation', `from ${entry.w} + -${derived.suffix}`));
      } else if (settings.showIpa && entry.i) {
        frag.append(el('div', 'hd-ipa', entry.i));
      }
      if (senses.length) {
        const sensesBox = el('div', 'hd-senses');
        senses.forEach((sense, i) => {
          const gloss = Array.isArray(sense.gl) ? sense.gl.join('; ') : String(sense);
          const row = el('div', 'hd-sense');
          row.append(el('span', 'hd-sense-num', senses.length > 1 ? String(i + 1) : ''));
          row.append(el('div', 'hd-gloss', gloss));
          sensesBox.append(row);
        });
        frag.append(sensesBox);
      }
    });
    return frag;
  }

  /** @param {string} word  the hovered word, for the LEO button */
  function renderResult(lookupResult, word) {
    const { segments } = lookupResult;
    const frag = document.createDocumentFragment();

    segments.forEach((seg, si) => {
      if (si > 0) {
        frag.append(el('hr', 'hd-seg-sep'));
      }

      frag.append(renderEntries(seg.entries));
    });

    const foot = el('div', 'hd-foot');
    foot.append(el('span', null, 'Wiktionary · CC BY-SA'));
    if (settings.showLeo !== false) {
      // Opens LEO's own result page for the whole hovered word in a new tab.
      // Clickable only while the popup takes the pointer: Shift held, or keepOpen.
      const leo = el('button', 'hd-leo', 'Look up on LEO ↗');
      leo.type = 'button';
      leo.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        browser.runtime.sendMessage({ type: 'open-leo', word }).catch(() => {});
        clear();
      });
      foot.append(leo);
    }
    frag.append(foot);
    popup.replaceChildren(frag);
    popup.style.display = 'block';
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

  /**
   * Place the popup directly against the word, below it or else above, so the
   * pointer can move from the word onto the popup without crossing the page.
   */
  function placePopupAtWord(rect) {
    const PAD = 12;
    popup.style.left = '0';
    popup.style.top  = '0';
    popup.style.display = 'block';

    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;

    let y = rect.bottom;
    if (y + ph > window.innerHeight - PAD) y = rect.top - ph;
    const x = Math.min(rect.left, window.innerWidth - pw - PAD);

    popup.style.left = `${Math.max(PAD, x)}px`;
    popup.style.top  = `${Math.max(PAD, y)}px`;
  }

  /**
   * Show the rendered popup for a word. By default it follows the cursor and
   * ignores the pointer. With keepOpen it sits against the word and takes the
   * pointer, so it can be moved onto and clicked.
   */
  function showPopup(rect) {
    if (settings.keepOpen) placePopupAtWord(rect);
    else placePopup(lastX, lastY);
    popup.style.pointerEvents = settings.keepOpen ? 'auto' : '';
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
    popup.style.pointerEvents = '';
    highlight.style.display = 'none';
    currentWord = null;
    frozen = false;
  }

  /**
   * Holding Shift freezes a shown popup where it is and lets it take the
   * pointer, so it can be reached from any direction and clicked.
   */
  function freeze() {
    frozen = true;
    popup.style.pointerEvents = 'auto';
  }

  /**
   * End a freeze. Without keepOpen the popup goes back to ignoring the pointer
   * and closes unless the pointer is still on the word. Returns true if it
   * closed.
   */
  function unfreeze() {
    frozen = false;
    popup.style.pointerEvents = settings.keepOpen ? 'auto' : '';
    if (settings.keepOpen || !awayFromWord(lastX, lastY)) return false;
    clear();
    return true;
  }

  /** True when (x, y) is outside the highlighted word, with a small margin. */
  function awayFromWord(x, y) {
    const hr = highlight.getBoundingClientRect();
    const MARGIN = 6;
    return x < hr.left - MARGIN || x > hr.right + MARGIN ||
           y < hr.top  - MARGIN || y > hr.bottom + MARGIN;
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

    const popupShown = popup.style.display === 'block';
    if (e.shiftKey && popupShown) {
      freeze();
      return;
    }
    if (frozen && unfreeze()) return;

    // The pointer is on the popup itself, which only happens while the popup
    // takes the pointer: keep it open.
    if (e.target === host) return;

    // Fast-clear if pointer is provably outside the current highlight rect;
    // no need to wait for getWordAtPoint when we can dismiss immediately.
    if (currentWord && highlight.style.display !== 'none' && awayFromWord(e.clientX, e.clientY)) {
      clear();
      return;
    }

    const wordInfo = getWordAtPoint(e.clientX, e.clientY);

    if (!wordInfo) {
      // Short linger so cursor can move between lines without flickering.
      hoverTimer = setTimeout(clear, 30);
      return;
    }

    // Same word: a cursor-following popup follows; one placed against the
    // word stays put
    const key = cacheKey(wordInfo);
    if (key === currentWord) {
      if (popupShown && !settings.keepOpen) placePopup(lastX, lastY);
      return;
    }

    currentWord = key;

    // Capture range rect now (valid while we still have the range object)
    const rect = wordInfo.range.getBoundingClientRect();

    // Fire lookup immediately; IndexedDB is local so results come back fast.
    // We intentionally do NOT show highlight or popup until a result is found:
    // that way only words that exist in the chosen language's dictionary are
    // ever highlighted, matching 10ten's behavior.
    (async () => {
      // Cache hit: synchronous path, no flicker
      const cached = resultCache.get(key);
      if (cached !== undefined) {
        if (currentWord !== key || !settings.enabled) return;
        if (cached) {
          if (rect.width > 0) showHighlight(rect);
          renderResult(cached, wordInfo.word);
          showPopup(rect);
        }
        // null cache entry = known miss, show nothing
        return;
      }

      // DB lookup (local IndexedDB, typically <5 ms)
      const result = await lookup(wordInfo);
      // Guard: word changed or extension was disabled while awaiting
      if (currentWord !== key || !settings.enabled) return;

      if (result) {
        if (rect.width > 0) showHighlight(rect);
        renderResult(result, wordInfo.word);
        showPopup(rect);
      }
      // No result = not in dictionary, show nothing (no highlight)
    })();
  }, { passive: true });

  document.addEventListener('mouseleave', clear);

  document.addEventListener('scroll', () => { clear(); }, { passive: true, capture: true });

  // Shift takes effect on press and release, not only on the next mousemove.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') clear();
    else if (e.key === 'Shift' && popup.style.display === 'block') freeze();
  });

  document.addEventListener('keyup', e => {
    if (e.key === 'Shift' && frozen) unfreeze();
  });

})();
