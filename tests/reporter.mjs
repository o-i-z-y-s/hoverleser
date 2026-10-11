/**
 * Hoverleser tests: a node:test reporter that prints a short summary and
 * writes every result to tests/last-run.log.
 *
 *   npm test
 *
 * The summary shows one line per test file, or per group of a file that has
 * groups, with failures in full. The log lists every check, and for each word
 * the lookup tests try, the result it produced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const LOG   = path.join(TESTS, 'last-run.log');
const WIDTH = 60;

const leaves = node => (node.children.length === 0 ? [node] : node.children.flatMap(leaves));
const pad    = (text, width) => (text.length >= width ? `${text} ` : text.padEnd(width));
const status = node => (node.skipped ? 'skip' : node.ok ? ' ok ' : 'FAIL');

/** Expected and actual values of a failed assertion, or its message. */
function describeFailure(error, indent) {
  const cause = error?.cause ?? error;
  if (cause && 'expected' in cause && 'actual' in cause) {
    const show = v => (typeof v === 'string' ? v : JSON.stringify(v));
    return [`${indent}expected: ${show(cause.expected)}`, `${indent}actual:   ${show(cause.actual)}`];
  }
  const message = String(cause?.message ?? cause ?? 'failed').split('\n').slice(0, 6);
  return message.map(line => `${indent}${line}`);
}

export default async function* reporter(source) {
  const files = new Map();     // file → { roots, pending: nesting → finished nodes }
  const lastFinished = new Map();
  const output = [];
  const begun = Date.now();

  for await (const { type, data } of source) {
    const file = data.file ? path.relative(process.cwd(), data.file) : '(no file)';
    if (!files.has(file)) files.set(file, { roots: [], pending: new Map() });
    const state = files.get(file);

    if (type === 'test:pass' || type === 'test:fail') {
      const node = {
        name: data.name,
        ok: type === 'test:pass',
        skipped: Boolean(data.skip || data.todo),
        error: data.details?.error,
        notes: [],
        children: state.pending.get(data.nesting + 1) ?? [],
      };
      state.pending.delete(data.nesting + 1);
      if (data.nesting === 0) state.roots.push(node);
      else state.pending.set(data.nesting, [...(state.pending.get(data.nesting) ?? []), node]);
      lastFinished.set(`${file}\u0000${data.nesting}`, node);
    } else if (type === 'test:diagnostic' && data.file) {
      // A test's own diagnostics arrive just after its result.
      lastFinished.get(`${file}\u0000${data.nesting}`)?.notes.push(data.message);
    } else if (type === 'test:stdout' || type === 'test:stderr') {
      output.push(`${file}: ${data.message.trimEnd()}`);
    }
  }

  const all = [...files.values()].flatMap(f => f.roots.flatMap(leaves));
  const failed = all.filter(n => !n.ok && !n.skipped).length;
  const header = `Hoverleser tests, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}: `
    + `${all.length - failed} passed, ${failed} failed (${((Date.now() - begun) / 1000).toFixed(1)} s)`;

  const summary = [header, ''];
  const log = [header, ''];

  // One log line per check, indented under the groups that contain it.
  const write = (node, depth) => {
    const indent = '  '.repeat(depth);
    if (node.children.length > 0) {
      log.push(`${indent}${node.name}`);
      for (const child of node.children) write(child, depth + 1);
      return;
    }
    log.push(`${indent}${status(node)}  ${node.notes.length ? pad(node.name, 36) + node.notes.join(' | ') : node.name}`);
    if (!node.ok && !node.skipped) log.push(...describeFailure(node.error, `${indent}        `));
  };

  for (const [file, { roots }] of [...files].filter(([, f]) => f.roots.length > 0)) {
    const checks = roots.flatMap(leaves);
    const bad = checks.filter(n => !n.ok && !n.skipped);
    const grouped = roots.some(r => r.children.length > 0);

    summary.push(`${pad(file, WIDTH)}${checks.length - bad.length}/${checks.length}`);
    log.push(file);

    // In a file with groups, each group gets a line and the single checks
    // share one; failures are listed under the line they belong to.
    const singles = roots.filter(r => r.children.length === 0);
    const lines = grouped
      ? [...roots.filter(r => r.children.length > 0).map(r => [r.name, leaves(r)]),
         ...(singles.length ? [['other checks', singles]] : [])]
      : [[null, checks]];
    for (const [name, group] of lines) {
      const groupBad = group.filter(n => !n.ok && !n.skipped);
      if (name) summary.push(`  ${pad(`${groupBad.length ? 'FAIL ' : ''}${name}`, WIDTH - 2)}${group.length - groupBad.length}/${group.length}`);
      for (const node of groupBad) {
        summary.push(`      ${node.name}`, ...describeFailure(node.error, '        '));
      }
    }

    for (const root of roots) write(root, 1);
    log.push('');
  }

  if (output.length > 0) log.push('Output written by the tests:', ...output, '');
  fs.writeFileSync(LOG, log.join('\n') + '\n');

  summary.push('', `Every check and every lookup result: ${path.relative(process.cwd(), LOG)}`);
  yield summary.join('\n') + '\n';
}
