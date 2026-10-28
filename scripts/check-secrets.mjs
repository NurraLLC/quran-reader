#!/usr/bin/env node
// Keeps keys out of the public repository. Compares what is about to be committed (--staged, run by
// the pre-commit hook) or every version of every file ever committed (--history) with the actual
// secret values in this machine's own env files (.env, deploy/production.env: git ignores both) and
// with well-known key formats. Prints only names and paths, never a value.
//
//   npm run secrets:hook    install the pre-commit hook in this checkout (once per clone)
//   npm run secrets:check   scan the whole history
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const git = (args, input) => execFileSync('git', args, { input, maxBuffer: 1 << 30 });
const root = git(['rev-parse', '--show-toplevel']).toString().trim();
const argv = process.argv.slice(2);

if (argv.includes('--install')) {
  const hooks = path.resolve(root, git(['rev-parse', '--git-path', 'hooks']).toString().trim());
  const hook = path.join(hooks, 'pre-commit');
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes('check-secrets.mjs')) {
    console.error(`A different pre-commit hook is already installed (${hook}); add this line to it:\n  node scripts/check-secrets.mjs --staged`);
    process.exit(1);
  }
  writeFileSync(hook, '#!/bin/sh\n# Installed by npm run secrets:hook: no key reaches the public repository.\nexec node scripts/check-secrets.mjs --staged\n');
  chmodSync(hook, 0o755);
  console.log(`Installed ${path.relative(root, hook)}: every commit is checked for keys first.`);
  process.exit(0);
}

/** Values of secret-looking settings in the local env files (never committed). */
function secretValues() {
  const files = ['.env', 'deploy/production.env'].map((f) => path.join(root, f));
  for (const a of argv) if (a.startsWith('--env=')) files.push(a.slice(6));
  const out = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || !/(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL)/i.test(m[1])) continue;
      const value = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
      if (value.length >= 12) out.push({ name: `${m[1]} (from ${path.basename(file)})`, value: Buffer.from(value) });
    }
  }
  return out;
}

const FORMATS = [
  ['a Soniox key', /\bsnx_(?:proj|org)_[A-Za-z0-9._-]{24,}/],
  ['a Quran Foundation client secret', /\bqfcs_[A-Za-z0-9_-]{24,}/],
  ['a Stripe secret key', /\b[rs]k_(live|test)_[0-9A-Za-z]{16,}/],
  ['a Stripe webhook secret', /\bwhsec_[0-9A-Za-z]{16,}/],
  ['an OpenRouter key', /\bsk-or-v1-[0-9a-f]{32,}/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/],
  ['a DigitalOcean token', /\bdo[opr]_v1_[0-9a-f]{40,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a private key', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
/** Files that hold secrets or private records by nature. */
const NEVER = /(^|\/)\.env(\.local)?$|(^|\/)production\.env$|\.pem$|(^|\/)id_(rsa|ed25519)$|^data\/(state|captures)\//;

const secrets = secretValues();
const problems = [];
function check(where, body) {
  for (const s of secrets) if (body.includes(s.value)) problems.push(`your ${s.name} in ${where}`);
  if (body.includes(0)) return; // binary: only exact values are looked for
  const text = body.toString('utf8');
  for (const [what, rx] of FORMATS) if (rx.test(text)) problems.push(`${what} in ${where}`);
}

if (argv.includes('--history')) {
  const paths = new Map();
  for (const line of git(['rev-list', '--all', '--objects']).toString().split('\n')) {
    const [sha, ...rest] = line.split(' ');
    if (sha && rest.length && !paths.has(sha)) paths.set(sha, rest.join(' '));
  }
  const data = git(['cat-file', '--batch'], [...paths.keys()].join('\n') + '\n');
  let i = 0;
  let blobs = 0;
  while (i < data.length) {
    const nl = data.indexOf(10, i);
    const [sha, kind, size] = data.subarray(i, nl).toString().split(' ');
    i = nl + 1;
    const body = data.subarray(i, i + Number(size));
    i += Number(size) + 1;
    if (kind !== 'blob') continue;
    blobs++;
    const where = paths.get(sha);
    if (NEVER.test(where)) problems.push(`the file ${where}, which should never be committed`);
    check(`${where} (in history)`, body);
  }
  console.log(`Checked ${blobs} file versions in the whole history against ${secrets.length} local key values and ${FORMATS.length} key formats.`);
} else {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString().split('\0').filter(Boolean);
  for (const file of staged) {
    if (NEVER.test(file)) problems.push(`the file ${file}, which should never be committed`);
    check(file, git(['show', `:${file}`]));
  }
}

if (problems.length) {
  console.error(`Stopped: ${[...new Set(problems)].length} key${problems.length === 1 ? '' : 's'} would reach the public repository:`);
  for (const p of new Set(problems)) console.error(`  - ${p}`);
  console.error('Keys belong in .env or deploy/production.env, which git ignores. Remove them and commit again.');
  process.exit(1);
}
if (argv.includes('--history')) console.log('No keys found.');
