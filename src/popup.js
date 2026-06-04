/**
 * hoverleser – Popup Script (German-only)
 */
'use strict';

// Pre-built dictionary served from GitHub Releases (dict-latest tag).
// Gzip-compressed processed JSONL, ~20 MB download.
const RELEASES_DICT_URL = 'https://github.com/o-i-z-y-s/hoverleser/releases/download/dict-latest/de-latest.jsonl.gz';
const LANG_CODE = 'de';
const LANG_NAME = 'German';

document.getElementById('brand-version').textContent =
  'v' + browser.runtime.getManifest().version;

// ── Elements ──────────────────────────────────────────────────────────────
const toggleEnabled = document.getElementById('toggle-enabled');
const toggleIpa     = document.getElementById('toggle-ipa');
const toggleTags    = document.getElementById('toggle-tags');
const toggleGender  = document.getElementById('toggle-gender');
const segSenses     = document.getElementById('seg-senses');
const popupOpenTabLink = document.getElementById('popup-open-tab-link');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const dbMeta        = document.getElementById('db-meta');
const progressWrap  = document.getElementById('progress-wrap');
const progressBar   = document.getElementById('progress-bar');
const onboarding    = document.getElementById('onboarding');
const btnImport     = document.getElementById('btn-import');
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const btnClear      = document.getElementById('btn-clear');
const importMsg     = document.getElementById('import-msg');
const btnOpenTab    = document.getElementById('btn-open-tab');

let settings = { enabled: false, langCode: LANG_CODE, showIpa: true, showTags: true, showGender: true, maxSenses: 3 };
let pollTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  settings = await browser.runtime.sendMessage({ type: 'get-settings' });
  // Always enforce German regardless of stored setting
  settings.langCode = LANG_CODE;
  toggleEnabled.checked = settings.enabled;
  toggleIpa.checked     = settings.showIpa;
  toggleTags.checked    = settings.showTags   ?? true;
  toggleGender.checked  = settings.showGender ?? true;
  // Activate correct segment button
  const activeSeg = segSenses.querySelector(`[data-val="${settings.maxSenses ?? 3}"]`);
  if (activeSeg) {
    segSenses.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    activeSeg.classList.add('active');
  }
  await refreshDbStatus();
}

async function saveSettings() {
  settings.langCode = LANG_CODE; // always German
  await browser.runtime.sendMessage({ type: 'set-settings', settings });
  // Broadcast to every tab so all content scripts update immediately,
  // not just the currently active one.
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    browser.tabs.sendMessage(tab.id, { type: 'settings-changed', settings }).catch(() => {});
  }
}

// ── DB status ─────────────────────────────────────────────────────────────
async function refreshDbStatus() {
  const { ready, meta, importing } = await browser.runtime.sendMessage({
    type: 'db-status', langCode: LANG_CODE,
  });
  clearTimeout(pollTimer);

  if (importing && importing.status === 'running') {
    const pct = importing.total > 0 ? Math.round(100 * importing.done / importing.total) : 0;
    statusDot.className        = 'dot dot-loading';
    statusText.innerHTML       = `Importing… <em>${importing.done.toLocaleString()} entries</em>`;
    dbMeta.textContent         = importing.total > 0 ? `${pct}% complete` : '';
    progressWrap.style.display = 'block';
    progressBar.style.width    = `${pct}%`;
    setButtons({ importDisabled: true, clearDisabled: true });
    onboarding.classList.remove('visible');
    pollTimer = setTimeout(refreshDbStatus, 600);
    return;
  }

  progressWrap.style.display = 'none';

  if (ready && meta) {
    statusDot.className    = 'dot dot-ready';
    statusText.textContent = 'German dictionary ready';
    dbMeta.textContent     =
      `${(meta.entryCount ?? 0).toLocaleString()} entries · v${meta.version ?? '?'}`;
    btnImport.textContent  = '↻ Re-import from web';
    onboarding.classList.remove('visible');
    setButtons({ importDisabled: false, clearDisabled: false });
    setMsg('', '');
  } else if (importing && importing.status === 'error') {
    statusDot.className    = 'dot dot-empty';
    statusText.textContent = 'Import failed';
    dbMeta.textContent     = importing.error ?? '';
    onboarding.classList.add('visible');
    setButtons({ importDisabled: false, clearDisabled: true });
    setMsg('Failed.', 'err');
  } else {
    statusDot.className    = 'dot dot-empty';
    statusText.textContent = 'No dictionary loaded';
    dbMeta.textContent     = '';
    btnImport.textContent  = '⬇ Download & Import German';
    onboarding.classList.add('visible');
    setButtons({ importDisabled: false, clearDisabled: true });
    setMsg('', '');
  }
}

function setButtons({ importDisabled, clearDisabled }) {
  btnImport.disabled               = importDisabled;
  importDisabled ? dropZone.classList.add('dz-hidden') : dropZone.classList.remove('dz-hidden');
  dropZone.setAttribute('tabindex', importDisabled ? '-1' : '0');
  fileInput.disabled               = importDisabled;
  btnClear.disabled                = clearDisabled;
}

function setMsg(text, type) {
  importMsg.textContent = text;
  importMsg.className   = type ? `msg msg-${type}` : 'msg';
}

// ── Download & import from GitHub Releases ────────────────────────────────
async function startDictDownload() {
  setMsg('', '');
  setButtons({ importDisabled: true, clearDisabled: true });
  statusDot.className        = 'dot dot-loading';
  statusText.innerHTML       = 'Downloading dictionary…';
  progressWrap.style.display = 'block';
  progressBar.style.width    = '0%';

  try {
    const resp = await fetch(RELEASES_DICT_URL);
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

    const contentLength = resp.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        const pct = Math.round(received / total * 100);
        progressBar.style.width = pct + '%';
        dbMeta.textContent      = `Downloading… ${pct}%`;
      } else {
        dbMeta.textContent = `Downloaded ${(received / 1048576).toFixed(1)} MB`;
      }
    }

    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    // Name must end in .gz so importFile() activates DecompressionStream
    const file = new File([blob], 'de-latest.jsonl.gz', { type: 'application/octet-stream' });
    progressWrap.style.display = 'none';
    await importFile(file);
  } catch (err) {
    progressWrap.style.display = 'none';
    setMsg(err.message, 'err');
    setButtons({ importDisabled: false, clearDisabled: true });
    await refreshDbStatus();
  }
}

btnImport.addEventListener('click', () => {
  // In narrow popup mode, open the full tab with autoImport flag instead of
  // running the import inside the popup (which closes when it loses focus).
  if (window.innerWidth <= 499) {
    browser.tabs.create({ url: browser.runtime.getURL('popup.html') + '?autoImport=1' });
    window.close();
  } else {
    startDictDownload();
  }
});

// ── Import from local file (drag-and-drop or file picker) ─────────────────
const FILE_BATCH = 500;

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) await importFile(file);
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  if (!file.name.match(/\.jsonl(\.gz)?$/)) {
    setMsg('Please drop a .jsonl or .jsonl.gz file', 'err'); return;
  }
  await importFile(file);
});

async function importFile(file) {
  setButtons({ importDisabled: true, clearDisabled: true });

  try {
    // Stream the file; never load the whole thing into memory at once.
    // For .gz, pipe through DecompressionStream before decoding text.
    let stream = file.stream();
    if (file.name.endsWith('.gz')) {
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();

    // Read first chunk to find the meta line (always line 1 in build-dict output)
    // so we can report a meaningful total to the background.
    let buffer = '';
    let meta   = null;
    let total  = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += value;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const firstLine = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        try {
          const obj = JSON.parse(firstLine);
          if (obj.type === 'meta') { meta = obj; total = obj.entryCount ?? 0; }
        } catch {}
        break; // whether we found meta or not, proceed
      }
      if (done) break;
    }

    await browser.runtime.sendMessage({
      type: 'import-file-start', langCode: LANG_CODE, lang: LANG_NAME, totalSize: total,
    });

    // Start polling; status dot + entry counter now drive the UI
    pollTimer = setTimeout(refreshDbStatus, 400);

    // Stream remaining content in batches
    let batch    = [];
    let gotEntry = false;

    const flushBatch = async (isLast) => {
      if (batch.length === 0 && !isLast) return;
      await browser.runtime.sendMessage({
        type: 'import-file-chunk', langCode: LANG_CODE,
        data: batch, meta: isLast ? meta : null, done: isLast,
      });
      batch = [];
    };

    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += value;

      // Slice out all complete lines from the buffer
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'meta') { meta = obj; continue; }
        batch.push(obj);
        gotEntry = true;
        if (batch.length >= FILE_BATCH) await flushBatch(false);
      }

      if (done) break;
    }

    // Handle any trailing content without a final newline
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer.trim());
        if (obj.type !== 'meta') { batch.push(obj); gotEntry = true; }
      } catch {}
    }

    if (!gotEntry) throw new Error('No entries found. Is this a valid .jsonl dictionary file?');

    await flushBatch(true);

  } catch (err) {
    setMsg(err.message, 'err');
    setButtons({ importDisabled: false, clearDisabled: true });
  }
}

// ── Remove dictionary ──────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  if (!confirm('Remove the German dictionary?')) return;
  await browser.runtime.sendMessage({ type: 'clear-db', langCode: LANG_CODE });
  setMsg('', '');
  await refreshDbStatus();
});

// ── Settings ──────────────────────────────────────────────────────────────
toggleEnabled.addEventListener('change', () => {
  settings.enabled = toggleEnabled.checked; saveSettings();
});
toggleIpa.addEventListener('change', () => {
  settings.showIpa = toggleIpa.checked; saveSettings();
});
toggleTags.addEventListener('change', () => {
  settings.showTags = toggleTags.checked; saveSettings();
});
toggleGender.addEventListener('change', () => {
  settings.showGender = toggleGender.checked; saveSettings();
});
segSenses.addEventListener('click', e => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  segSenses.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  settings.maxSenses = parseInt(btn.dataset.val, 10);
  saveSettings();
});

// ── Open in tab ───────────────────────────────────────────────────────────
const openTab = () => browser.tabs.create({ url: browser.runtime.getURL('popup.html') });
btnOpenTab.addEventListener('click', openTab);
if (popupOpenTabLink) popupOpenTabLink.addEventListener('click', openTab);

// ── Sample words panel ──────────────────────────────────────────────────────
// Renders lookup results inline when hovering .sample-word spans.
// Mirrors content.js rendering using sr-* class names (no Shadow DOM needed).

const SR_GENDER_LABELS = { m: 'der', f: 'die', n: 'das' };
const SR_GENDER_CLASS  = { m: 'sr-gender-m', f: 'sr-gender-f', n: 'sr-gender-n' };
const SR_TAG_ORDER = [
  'plural','singular','nominative','accusative','dative','genitive',
  'comparative','superlative','strong','weak','mixed',
  'transitive','intransitive',
  'past','present','future','indicative','subjunctive','imperative','participle',
  'first-person','second-person','third-person',
];
const SR_TAG_NOISE = new Set([
  'form-of','canonical','error-unknown-tag',
  'with-dative','with-accusative','with-genitive',
]);

function srEsc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildSrTagRow(entry) {
  const seen = new Set();
  const merged = [];
  const add = t => {
    const lt = t.toLowerCase().trim();
    if (!lt || seen.has(lt)) return;
    seen.add(lt); merged.push(lt);
  };
  for (const t of (entry.gramTags ?? [])) add(t);
  for (const sense of (entry.s ?? []))
    for (const t of (sense.t ?? []))
      if (!SR_TAG_NOISE.has(t)) add(t);
  if (merged.length === 0) return '';
  const sorted = merged.sort((a, b) => {
    const ai = SR_TAG_ORDER.indexOf(a), bi = SR_TAG_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1; if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  return '<div class="sr-tags-row">' +
    sorted.map(t => `<span class="sr-gram-tag">${srEsc(t)}</span>`).join('') +
    '</div>';
}

function renderSrEntries(entries) {
  let html = '';
  const maxTotal = settings.maxSenses ?? 3;
  const n      = entries.length;
  const base   = Math.floor(maxTotal / n);
  const extras = maxTotal % n;
  const budgets = entries.map((_, i) => Math.max(1, base + (i < extras ? 1 : 0)));

  entries.forEach((entry, idx) => {
    if (idx > 0) html += '<hr class="sr-sep">';
    const gc = SR_GENDER_CLASS[entry.g]  ?? '';
    const gl = SR_GENDER_LABELS[entry.g] ?? '';
    html += '<div class="sr-head">' +
      `<span class="sr-word">${srEsc(entry.w)}</span>` +
      (entry.g && settings.showGender !== false
        ? `<span class="sr-gender ${gc}">${srEsc(gl)}</span>` : '') +
      `<span class="sr-pos">${srEsc(entry.p ?? '')}</span>` +
      '</div>';
    if (settings.showTags !== false) html += buildSrTagRow(entry);
    if (settings.showIpa && entry.i)
      html += `<div class="sr-ipa">${srEsc(entry.i)}</div>`;
    if (Array.isArray(entry.s) && entry.s.length) {
      html += '<div class="sr-senses">';
      const senses = entry.s.slice(0, budgets[idx]);
      senses.forEach((sense, i) => {
        const gloss = Array.isArray(sense.gl) ? sense.gl.join('; ') : String(sense);
        html += '<div class="sr-sense">' +
          `<span class="sr-sense-num">${senses.length > 1 ? i + 1 : ''}</span>` +
          `<div class="sr-gloss">${srEsc(gloss)}</div>` +
          '</div>';
      });
      html += '</div>';
    }
  });
  return html;
}

function renderSrResult(result) {
  let html = '';
  result.segments.forEach((seg, si) => {
    if (si > 0) html += '<hr class="sr-seg-sep">';
    html += renderSrEntries(seg.entries);
  });
  html += '<div class="sr-foot">Wiktionary · CC BY-SA</div>';
  return html;
}

function initSamplePanel() {
  const resultDiv = document.getElementById('sample-result');
  if (!resultDiv) return;

  // Mirror content.js placePopup: position below and to the right of the cursor,
  // flipping left/up when the tooltip would overflow the viewport.
  const SR_PAD = 12;
  function placeSampleResult(clientX, clientY) {
    resultDiv.style.left = '0';
    resultDiv.style.top  = '0';
    const pw = resultDiv.offsetWidth;
    const ph = resultDiv.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clientX + SR_PAD;
    let y = clientY + 22 + SR_PAD;
    if (x + pw > vw - SR_PAD) x = clientX - pw - SR_PAD;
    if (y + ph > vh - SR_PAD) y = clientY - ph - SR_PAD;
    resultDiv.style.left = Math.max(SR_PAD, x) + 'px';
    resultDiv.style.top  = Math.max(SR_PAD, y) + 'px';
  }

  document.querySelectorAll('.sample-word').forEach(span => {
    span.addEventListener('mouseenter', async e => {
      const word = span.textContent.trim();
      resultDiv.style.display = 'block';
      placeSampleResult(e.clientX, e.clientY);

      try {
        const result = await browser.runtime.sendMessage({
          type: 'lookup', word, langCode: LANG_CODE,
        });
        if (result) {
          resultDiv.innerHTML = renderSrResult(result);
        } else {
          resultDiv.innerHTML =
            `<span class="sr-miss">Not found in dictionary: ${srEsc(word)}</span>`;
        }
      } catch (err) {
        resultDiv.innerHTML =
          `<span class="sr-miss">Lookup error: ${srEsc(err.message)}</span>`;
      }
      placeSampleResult(e.clientX, e.clientY);
    });

    span.addEventListener('mousemove', e => {
      if (resultDiv.style.display === 'block') placeSampleResult(e.clientX, e.clientY);
    });
  });

  document.getElementById('sample-panel').addEventListener('mouseleave', () => {
    resultDiv.style.display = 'none';
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
init().then(() => {
  initSamplePanel();
  // Auto-trigger download if opened from the popup button in narrow mode
  if (new URLSearchParams(window.location.search).get('autoImport') === '1') {
    startDictDownload();
  }
}).catch(console.error);
