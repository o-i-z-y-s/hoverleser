# Hoverleser

Hover over any German word to instantly see its translation, gender, IPA pronunciation, and grammatical forms. Fully offline after a one-time dictionary import, with nothing ever sent anywhere.

Supports **Firefox** and **Chromium-based browsers** (Chrome, Edge, Brave, etc.).

---

## Install

### Firefox

1. Go to the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest) and click `hoverleser-x.x.x-firefox.xpi`
2. Firefox will prompt "Allow github.com to install an add-on?" Click **Continue to Installation**, then **Add**
3. The setup tab opens automatically. Import the dictionary before first use (see below)

Once installed, **updates are automatic.** Firefox checks for new versions roughly every 24 hours and installs them silently in the background.

### Chrome / Chromium

1. Go to the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest) and download `hoverleser-x.x.x-chrome.zip`
2. Unzip it to a permanent folder on your computer
3. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select that folder
4. The setup tab opens automatically. Import the dictionary before first use (see below)

Chrome does not support automatic updates for sideloaded extensions. Check the releases page periodically for new versions.

---

## Import the dictionary

The extension ships without a dictionary. After installing, the setup tab opens automatically. You can also reach it any time by clicking the Hoverleser toolbar icon, then **⤢** in the top-right corner of the popup.

### Option A: Pre-built file (recommended)

1. Download `de-latest.jsonl.gz` (~20 MB) from the [dictionary release](https://github.com/o-i-z-y-s/hoverleser/releases/tag/dict-latest)
2. Drag the file onto the import area in the settings tab
3. Wait for the status dot to turn green

### Option B: One-click download

Click **⬇ Download & Import German** in the settings tab. This fetches the same pre-built dictionary (~20 MB) directly from GitHub Releases and imports it automatically, no manual download needed.

### Option C: Build your own

Requires Node.js 18+:

```sh
cd src
node scripts/build-dict.js --code de --compress
```

Then drag the output file (`src/dist/de.jsonl.gz`) onto the import area.

---

## Development

The browser loads the extension from `src/`, and expects the manifest to be named `manifest.json`. That file is not committed: copy the one for your browser first.

**Test in Firefox:**

```sh
cp src/manifest.firefox.json src/manifest.json
```

1. Go to `about:debugging` > This Firefox > Load Temporary Add-on
2. Select `src/manifest.json`

**Test in Chrome:**

```sh
cp src/manifest.chrome.json src/manifest.json
```

1. Go to `chrome://extensions` and enable Developer mode
2. Click Load unpacked and select the `src/` folder

Open the Hoverleser toolbar popup and click **⤢** for the settings tab. Its sample panel looks up any word you type and shows a set of words that exercise each kind of lookup.

**Run the tests** (Node.js 18.15+, no dependencies to install):

```sh
npm test
```

This prints one line per group of tests, and the expected and actual result of anything that failed. Every check, with the result each test word produced, goes to `tests/last-run.log`. Plain `node --test` runs the same tests with Node's own output.

The tests load `src/background.js` with a stand-in for the browser APIs and look up the words in `tests/fixtures/lookups.json` against a small excerpt of the dictionary. After changing the lookup code, the build script, or the fixture words, regenerate the excerpt and review the changed expectations:

```sh
node tests/make-fixture.js --dict src/dist/de.jsonl.gz --update
```

**Release:** bump `version` in both manifests and push to `main`.
