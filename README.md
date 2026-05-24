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

**Firefox (unsigned):**

```sh
cd src && bash package.sh build
# output: dist/hoverleser-x.x.x.xpi
```

Load in Firefox via `about:debugging` > Load Temporary Add-on.

**Chrome (unsigned):**

```sh
cd src && bash package.sh chrome
# output: dist/hoverleser-chrome-x.x.x.zip
```

Unzip and load in Chrome via `chrome://extensions` > Load unpacked.

**Release:** push to `main`. The `release.yml` workflow signs the Firefox XPI via AMO and builds the Chrome zip, attaching both to a GitHub Release automatically.

**Bump the version** in both `src/manifest.json` and `src/manifest.chrome.json` before every push. AMO rejects duplicate versions.

---

## CI workflows

| Workflow | Trigger | Output |
|---|---|---|
| **Build & Release** (`release.yml`) | Every push to `main` | Signed Firefox XPI + Chrome zip attached to GitHub Release; `updates.json` updated for Firefox auto-updates |
| **Build Dictionary** (`dictionary.yml`) | Push touching build logic, 1st of month, or manual | `de-vX.Y.Z.jsonl.gz` and `.jsonl` attached to same Release |
| **Submit to AMO Listed** (`amo-listed.yml`) | Manual only (type `SUBMIT` to confirm) | Submits for Mozilla public listing review |

Required repository secrets (`Settings > Secrets > Actions`):

| Secret | Where to get it |
|---|---|
| `AMO_API_KEY` | addons.mozilla.org > Developers > API Keys |
| `AMO_API_SECRET` | same page |

---

## Vendored dependency

`src/lib/browser-polyfill.min.js` is the [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) library by Mozilla (v0.12.0, MPL-2.0). It is committed directly to this repository rather than fetched at build time in order to eliminate npm supply-chain risk entirely. No network requests are made during the Firefox or Chrome build.

**Verification.** The file was obtained from two independent CDN sources (cdnjs/Cloudflare and unpkg/npm) and accepted only when both produced identical SHA-256 digests.

Verified SHA-256: `918ed891c0e7f9b58b39ac32c9c3133eb2a1fbaaa27f4aa7579ae55e7572cc21`

To re-verify or re-acquire the file at any time, run from the repo root:

```bat
vendor-polyfill.bat
```

This downloads from both CDNs, computes SHA-256 via `certutil`, and saves the file only if both hashes agree. Requires `curl` (built into Windows 10+).

---

## Data

Dictionary data from [kaikki.org](https://kaikki.org) (Wiktionary, CC BY-SA 4.0)
