# Hoverleser

Hover over any German word in Firefox to instantly see its translation, gender, IPA pronunciation, and grammatical forms. Fully offline after a one-time dictionary import — nothing is ever sent anywhere.

---

## Install

1. Download `hoverleser-x.x.x.xpi` from the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest)
2. Drag it onto any Firefox window and click **Add**

---

## Import the dictionary

Click the Hoverleser toolbar icon, then the **⤢** button to open the full settings tab.

### Option A — Pre-built file (recommended)

1. Download `de-vx.x.x.jsonl.gz` (~20 MB) from the [latest release](https://github.com/o-i-z-y-s/hoverleser/releases/latest)
2. Drag the file onto the import area in the settings tab
3. Wait for the status dot to turn green

### Option B — Download directly from kaikki.org

Click **Download & Import German** in the settings tab. This fetches ~930 MB of raw Wiktionary data and processes it in-browser — expect 15–30 minutes depending on your connection.

### Option C — Build your own

```sh
node src/scripts/build-dict.js --code de --out dist/de.jsonl --compress
```

Requires Node.js 18+. Then drag the output file onto the import area.

---

## Development

**Build an unsigned XPI:**

```sh
cd src && bash package.sh build
# → dist/hoverleser-x.x.x.xpi
```

Load it in Firefox via `about:debugging` → *Load Temporary Add-on*.

**Sign for distribution (unlisted):**

```sh
cd src
AMO_API_KEY=user:… AMO_API_SECRET=… bash package.sh sign
```

Get API credentials at [addons.mozilla.org/developers/addon/api/key/](https://addons.mozilla.org/developers/addon/api/key/).

**Bump the version** in `src/manifest.json` before every push — AMO rejects duplicate versions.

---

## CI workflows

| Workflow | Trigger | Output |
|---|---|---|
| **Build & Release** (`release.yml`) | Every push to `main` | Signed XPI → GitHub Release |
| **Build Dictionary** (`dictionary.yml`) | Push touching build logic · 1st of month · manual | `de-vX.Y.Z.jsonl.gz` + `.jsonl` → same Release |
| **Submit to AMO Listed** (`amo-listed.yml`) | Manual only (type `SUBMIT`) | Submits for Mozilla public listing review |

Required repository secrets (`Settings → Secrets → Actions`):

| Secret | Where to get it |
|---|---|
| `AMO_API_KEY` | addons.mozilla.org → Developers → API Keys |
| `AMO_API_SECRET` | same page |

---

## Data

Dictionary data from [kaikki.org](https://kaikki.org) (Wiktionary · CC BY-SA 4.0)
