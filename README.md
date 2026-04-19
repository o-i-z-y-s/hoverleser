# Hoverleser

Hover over any German word in Firefox to instantly see its translation, gender, IPA pronunciation, and grammatical forms. Fully offline after a one-time dictionary import, with nothing ever sent anywhere.

---

## Install

1. Go to the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest) and click `hoverleser-x.x.x-signed.xpi`
2. Firefox will prompt "Allow github.com to install an add-on?" Click **Continue to Installation**, then **Add**
3. The setup tab opens automatically. Import the dictionary before first use (see below)

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

**Build an unsigned XPI:**

```sh
cd src && bash package.sh build
# output: dist/hoverleser-x.x.x.xpi
```

Load it in Firefox via `about:debugging` > Load Temporary Add-on.

**Sign for distribution (unlisted):**

```sh
cd src
AMO_API_KEY=user:… AMO_API_SECRET=… bash package.sh sign
```

Get API credentials at [addons.mozilla.org/developers/addon/api/key/](https://addons.mozilla.org/developers/addon/api/key/).

**Bump the version** in `src/manifest.json` before every push. AMO rejects duplicate versions.

---

## CI workflows

| Workflow | Trigger | Output |
|---|---|---|
| **Build & Release** (`release.yml`) | Every push to `main` | Signed XPI attached to GitHub Release |
| **Build Dictionary** (`dictionary.yml`) | Push touching build logic, 1st of month, or manual | `de-vX.Y.Z.jsonl.gz` and `.jsonl` attached to same Release |
| **Submit to AMO Listed** (`amo-listed.yml`) | Manual only (type `SUBMIT` to confirm) | Submits for Mozilla public listing review |

Required repository secrets (`Settings > Secrets > Actions`):

| Secret | Where to get it |
|---|---|
| `AMO_API_KEY` | addons.mozilla.org > Developers > API Keys |
| `AMO_API_SECRET` | same page |

---

## Data

Dictionary data from [kaikki.org](https://kaikki.org) (Wiktionary, CC BY-SA 4.0)
