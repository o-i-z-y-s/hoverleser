#!/usr/bin/env node
// Download the signed XPI for a version from the AMO API v5.
//
// `web-ext sign` cannot resume: once a version exists on AMO, re-signing fails
// with "Version already exists", so a version held for manual review can only
// be collected by looking it up.
//
// Usage:
//   node scripts/amo-fetch-signed.mjs --version 1.1.0 --out src/dist
//
// Env: AMO_API_KEY (user:NNNNNNN:NNN), AMO_API_SECRET
//
// Exit codes: 0 downloaded, 10 not approved yet, 20 no such version, 1 error

import { createHmac, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const AMO_BASE = process.env.AMO_BASE_URL ?? 'https://addons.mozilla.org/api/v5';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// AMO tokens are HS256 and may not live longer than 5 minutes.
function makeJwt(issuer, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: issuer,
    jti: randomUUID(),
    iat: now,
    exp: now + 240,
  }));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

async function amoGet(url, issuer, secret) {
  const res = await fetch(url, {
    headers: {
      Authorization: `JWT ${makeJwt(issuer, secret)}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  const version = arg('version');
  const outDir  = arg('out', 'src/dist');
  const manifestPath = arg('manifest', 'src/manifest.firefox.json');

  if (!version) throw new Error('--version is required');

  const key    = process.env.AMO_API_KEY;
  const secret = process.env.AMO_API_SECRET;
  if (!key || !secret) throw new Error('AMO_API_KEY and AMO_API_SECRET must be set');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const addonId  = manifest?.browser_specific_settings?.gecko?.id;
  if (!addonId) throw new Error(`no gecko.id in ${manifestPath}`);

  console.log(`addon:   ${addonId}`);
  console.log(`version: ${version}`);

  // Without filter=all_with_unlisted, unlisted versions are not returned.
  const listUrl = `${AMO_BASE}/addons/addon/${encodeURIComponent(addonId)}`
    + `/versions/?filter=all_with_unlisted&page_size=50`;
  const list = await amoGet(listUrl, key, secret);

  const match = (list.results ?? []).find(v => v.version === version);
  if (!match) {
    const seen = (list.results ?? []).slice(0, 10).map(v => v.version).join(', ');
    console.log(`::warning title=Version not on AMO::${version} not found. Recent versions: ${seen || '(none)'}`);
    process.exit(20);
  }

  const detail = await amoGet(
    `${AMO_BASE}/addons/addon/${encodeURIComponent(addonId)}/versions/${match.id}/`,
    key, secret,
  );
  const file = detail.file ?? {};
  console.log(`version id: ${match.id}`);
  console.log(`file status: ${file.status ?? '(unknown)'}`);

  // 'public' is AMO's status for a signed file, on both channels.
  if (file.status !== 'public' || !file.url) {
    console.log(
      `::notice title=Awaiting AMO approval::version ${version} (id ${match.id}) is `
      + `"${file.status ?? 'unknown'}", not yet signed. AMO is holding it for review; `
      + `re-run this workflow later. Do not bump the version, and do not re-sign: `
      + `the version already exists on AMO.`,
    );
    process.exit(10);
  }

  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, `hoverleser-${version}-firefox.xpi`);

  const res = await fetch(file.url, {
    headers: { Authorization: `JWT ${makeJwt(key, secret)}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download ${file.url} -> ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));

  const { size } = await stat(target);
  if (size < 1024) throw new Error(`downloaded file is only ${size} bytes; refusing it`);

  console.log(`downloaded ${size} bytes`);
  console.log(target);
}

main().catch(err => {
  console.log(`::error title=amo-fetch-signed::${err.message}`);
  process.exit(1);
});
