# Hoverleser

Hover over any German word to instantly see its translation, gender, IPA pronunciation, and grammatical forms. Fully offline after a one-time dictionary import, with nothing ever sent anywhere.

Supports **Firefox** and **Chromium-based browsers** (Chrome, Edge, Brave, etc.).

---

## Install

### Firefox

1. Go to the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest) and click `hoverleser-x.x.x-signed.xpi`
2. Firefox will prompt "Allow github.com to install an add-on?" Click **Continue to Installation**, then **Add**
3. The setup tab opens automatically. Import the dictionary before first use (see below)

Once installed, **updates are automatic.** Firefox checks for new versions roughly every 24 hours and installs them silently in the background.

### Chrome / Chromium

1. Go to the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest) and download `hoverleser-chrome-x.x.x.zip`
2. Unzip it to a permanent folder on your computer
3. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select that folder
4. The setup tab opens automatically. Import the dictionary before first use (see below)

Chrome does not support automatic updates for sideloaded extensions. Check the releases page periodically for new versions.

---

## Import the dictionary

The extension ships without a dictionary. After installing, the setup tab opens automatically. You can also reach it any time by clicking the Hoverleser toolbar icon, then **⤢** in the top-right corner of the popup.

### Option A: Pre-built file (recommended)

1. Download `de-vx.x.x.jsonl.gz` (~20 MB) from the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest)
2. Drag the file onto the import area in the settings tab
3. Wait for the status dot to turn green

### Option B: Download directly from kaikki.org

Click **⬇ Download & Import German** in the settings tab. This fetches ~930 MB of raw Wiktionary data and processes it entirely in-browser. Expect 15-30 minutes depending on your connection.

### Option C: Build your own

Requires Node.js 18+:

```sh
node src/scripts/build-dict.js --code de --out dist/de.jsonl --compress
```

Then drag the output file onto the import area.

---

## Development

**Test in Firefox:** load the source directory directly, no packaging needed:

1. Go to `about:debugging` > This Firefox > Load Temporary Add-on
2. Select any file inside `src/`

**Test in Chrome:** build a local zip and load it unpacked:

```sh
cd src && bash package.sh chrome
# output: dist/hoverleser-x.x.x-chrome.zip
```

Unzip and load via `chrome://extensions` > Developer mode > Load unpacked.

**Release:** push to `main`.