/**
 * hoverleser – Popup Script (German-only)
 */
'use strict';

// Direct kaikki.org German dictionary URL.
// This is the raw Wiktionary JSONL (~300–400 MB uncompressed).
// background.js processes it with processRawEntry() on the fly.
const KAIKKI_DE_URL = 'https://kaikki.org/dictionary/German/kaikki.org-dictionary-German.jsonl';
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

let settings = { enabled: true, langCode: LANG_CODE, showIpa: true, showTags: true, showGender: true, maxSenses: 3 };
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

  if (importing && (importing.status === 'running' || importing.status === 'downloading')) {
    const downloading = importing.status === 'downloading';
    const pct = importing.total > 0 ? Math.round(100 * importing.done / importing.total) : 0;
    statusDot.className        = 'dot dot-loading';
    if (downloading && importing.done === 0) {
      statusText.innerHTML     = 'Downloading…';
      dbMeta.textContent       = 'Connecting to kaikki.org';
    } else if (downloading) {
      statusText.innerHTML     = `Downloading & importing… <em>${importing.done.toLocaleString()} entries</em>`;
      dbMeta.textContent       = importing.total > 0 ? `${pct}% complete` : '';
    } else {
      statusText.innerHTML     = `Importing… <em>${importing.done.toLocaleString()} entries</em>`;
      dbMeta.textContent       = importing.total > 0 ? `${pct}% complete` : '';
    }
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

// ── Download & import from kaikki.org ─────────────────────────────────────
async function startKaikkiImport() {
  setMsg('', '');
  setButtons({ importDisabled: true, clearDisabled: true });
  
  try {
    await browser.runtime.sendMessage({
      type: 'import-url',
      url:      KAIKKI_DE_URL,
      langCode: LANG_CODE,
      lang:     LANG_NAME,
    });
        pollTimer = setTimeout(refreshDbStatus, 800);
  } catch (err) {
    setMsg(err.message, 'err');
    setButtons({ importDisabled: false, clearDisabled: true });
  }
}

btnImport.addEventListener('click', () => {
  // In narrow popup mode, open the full tab with autoImport flag instead of
  // running the import inside the popup (which closes when it loses focus).
  if (window.innerWidth <= 499) {
    browser.tabs.create({ url: browser.runtime.getURL('popup.html') + '?autoImport=1' });
    window.close();
  } else {
    startKaikkiImport();
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
    // Stream the file — never load the whole thing into memory at once.
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
    while (!meta) {
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

    // Start polling — status dot + entry counter now drive the UI
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

    if (!gotEntry) throw new Error('No entries found — is this a valid .jsonl dictionary file?');

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

// ── Boot ──────────────────────────────────────────────────────────────────
init().then(() => {
  // Auto-trigger kaikki import if opened from the popup button
  if (new URLSearchParams(window.location.search).get('autoImport') === '1') {
    startKaikkiImport();
  }
}).catch(console.error);
