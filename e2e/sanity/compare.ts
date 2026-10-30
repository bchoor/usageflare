/**
 * Diff two sanity runs: every key of every probe, main against the PR. Flags a key that moved
 * 3× or more either way (past a small noise floor), a key that is new or went from 0 to more, a
 * probe main did not have, and the few absolute floors. Exit 0 PASS, 2 flagged, 3 bad input.
 *
 * Built to be read by an agent for a few hundred tokens, however many numbers were captured:
 * one PASS line, or at most 10 lines in all on FAIL ranked by how much they moved. Everything
 * else stays on disk next to pr.json: flags.txt (every flag) and keys.txt (every key captured).
 *
 *   node --experimental-strip-types e2e/sanity/compare.ts main.json pr.json
 *   … main.json pr.json --show <probe text> [key text]   one probe's numbers, both sides
 *   … main.json pr.json --keys                           every key captured, with where it shows
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Bag = Record<string, number>;
type Run = { at: string; seconds: number; dir: string; sha?: string; probes: Record<string, Bag> };
const [fa, fb, mode, ...rest] = process.argv.slice(2);
if (!fa || !fb) {
  console.error('usage: compare.ts main.json pr.json [--show <probe> [key] | --keys]');
  process.exit(3);
}
const [a, b] = [fa, fb].map((f) => JSON.parse(readFileSync(f, 'utf8')) as Run);
const FACTOR = 3;
const TOP = 7; // + header, column line and footer = 10 lines
// Below these, a change is noise (a few ms, a few rows, a few bytes). Counted calls and
// invocations are billed one by one, so one more of them is not noise.
const NOISE: [RegExp, number][] = [
  [/^(bind|inv|out)\./, 1],
  [/^(requestsAfterIdle|afterIdle\.)/, 1],
  [/^cpuMs$/, 20],
  [/^browser\..*Duration$/, 2_000],
  [/latency|Duration/, 50],
  [/^kvBytesWritten$/, 2_000],
  [/Bytes|bytes/, 20_000],
  [/JSHeap/, 5_000_000],
  [/./, 5],
];
// Pages load side by side and share the runtime's caches, so which page pays for one cached
// lookup varies from run to run: on a page, one call either way is noise.
const noise = (k: string, probe = '') => {
  const n = NOISE.find(([r]) => r.test(k))?.[1] ?? 5;
  return n === 1 && probe.startsWith('page ') ? 2 : n;
};
// Absolute floors, whatever main did: a page may not keep calling once idle, nothing may error,
// nothing may reach the network, and an idle app writes nothing to KV (the free plan's daily cap).
const FLOORS: [RegExp, RegExp, number, string][] = [
  [/^page /, /^requestsAfterIdle$/, 2, 'floor: calls after idle'],
  [/./, /^(pageErrors|consoleErrors|errors5xx)$/, 0, 'floor: errors'],
  [/./, /^outboundCalls$/, 0, 'floor: calls out'],
  [/^idle /, /^bind\.KV\.put$/, 0, 'floor: KV writes while idle'],
];

const fmt = (n: number | null) =>
  n === null
    ? '—'
    : Math.abs(n) >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : Math.abs(n) >= 1e4
        ? `${Math.round(n / 1e3)}k`
        : String(Math.round(n * 10) / 10);
const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
const row = (probe: string, key: string, main: string, pr: string, why: string) =>
  `${cut(probe, 34)} ${cut(key, 30)} ${main.padStart(7)} ${pr.padStart(7)}  ${why}`;

if (mode === '--show') {
  const [p = '', k = ''] = rest;
  const names = [...new Set([...Object.keys(a.probes), ...Object.keys(b.probes)])].filter((n) =>
    n.includes(p),
  );
  for (const n of names.slice(0, 5)) {
    console.log(n);
    const keys = [...new Set([...Object.keys(a.probes[n] ?? {}), ...Object.keys(b.probes[n] ?? {})])]
      .filter((x) => x.includes(k))
      .sort();
    for (const key of keys)
      console.log(
        `  ${cut(key, 40)} main ${fmt(a.probes[n]?.[key] ?? null).padStart(7)}  PR ${fmt(b.probes[n]?.[key] ?? null).padStart(7)}`,
      );
  }
  if (names.length > 5) console.log(`… ${names.length - 5} more probes match "${p}"`);
  process.exit(0);
}

const keyCount = new Map<string, number>();
for (const bag of Object.values(b.probes))
  for (const k of Object.keys(bag)) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
if (mode === '--keys') {
  for (const [k, n] of [...keyCount].sort()) console.log(`${cut(k, 44)} in ${n} probe${n > 1 ? 's' : ''}`);
  process.exit(0);
}

type Flag = { probe: string; key: string; main: number | null; pr: number; score: number; why: string };
const flags: Flag[] = [];
for (const [probe, bag] of Object.entries(b.probes)) {
  const base = a.probes[probe];
  for (const [key, pr] of Object.entries(bag)) {
    const main = base?.[key] ?? null;
    const floor = FLOORS.find(([p, k]) => p.test(probe) && k.test(key));
    if (floor && pr > floor[2]) flags.push({ probe, key, main, pr, score: 1e11 + pr, why: `✗ ${floor[3]}` });
    // Both sides run on the same seed; a seed that differs makes every other number suspect.
    if (probe === 'seed' && main !== null && main !== pr) {
      flags.push({ probe, key, main, pr, score: 1e10, why: '✗ seed differs' });
      continue;
    }
    const n = noise(key, probe);
    if (main === null) {
      if (pr >= n)
        flags.push({ probe, key, main, pr, score: pr / n, why: base ? 'new key ▲' : 'new probe ▲' });
      continue;
    }
    if (Math.max(main, pr) < n) continue;
    if (main === 0 && pr >= n) flags.push({ probe, key, main, pr, score: pr / n, why: '0 → more ▲' });
    else if (
      main > 0 &&
      (pr / Math.max(main, n) >= FACTOR || Math.max(main, n) / Math.max(pr, 1) >= FACTOR)
    ) {
      const r = pr / Math.max(main, 1e-9);
      flags.push({
        probe,
        key,
        main,
        pr,
        score: pr === 0 ? main / n : Math.max(r, 1 / r),
        why: pr === 0 ? 'to 0 ▼' : r > 1 ? `${fmt(r)}× ▲` : `${fmt(1 / r)}× ▼`,
      });
    }
  }
  // A key main had that the PR lost (a meter that stopped reporting) is a change too.
  for (const [key, main] of Object.entries(base ?? {}))
    if (!(key in bag) && main >= noise(key, probe))
      flags.push({ probe, key, main, pr: 0, score: main / noise(key, probe), why: 'gone ▼' });
}
for (const probe of Object.keys(a.probes))
  if (!b.probes[probe]) flags.push({ probe, key: '(probe)', main: 1, pr: 0, score: 1, why: 'probe gone' });
flags.sort((x, y) => y.score - x.score || x.probe.localeCompare(y.probe) || x.key.localeCompare(y.key));

// One line per probe and key (its worst flag), then one line per key and kind of change: the
// same change on 12 pages is one line "(+11 probes)", so the summary stays short.
const seen = new Set<string>();
const unique = flags.filter((f) => !seen.has(`${f.probe}|${f.key}`) && seen.add(`${f.probe}|${f.key}`));
const kind = (why: string) => why.replace(/[\d.,]+×/, 'N×');
const groups = new Map<string, Flag[]>();
for (const f of unique) {
  const g = `${f.key}|${kind(f.why)}`;
  groups.set(g, [...(groups.get(g) ?? []), f]);
}
const lines = [...groups.values()].map((g) =>
  row(
    g.length > 1 ? `${g[0].probe} (+${g.length - 1})` : g[0].probe,
    g[0].key,
    fmt(g[0].main),
    fmt(g[0].pr),
    g[0].why,
  ),
);
const dir = dirname(fb);
const full = unique.map((f) => row(f.probe, f.key, fmt(f.main), fmt(f.pr), f.why));
writeFileSync(join(dir, 'flags.txt'), `${row('probe', 'key', 'main', 'PR', 'change')}\n${full.join('\n')}\n`);
writeFileSync(
  join(dir, 'keys.txt'),
  `${[...keyCount]
    .sort()
    .map(([k, n]) => `${k}\t${n}`)
    .join('\n')}\n`,
);

const numbers = [...keyCount.values()].reduce((s, n) => s + n, 0);
const head = `${Object.keys(b.probes).length} probes, ${keyCount.size} keys, ${numbers} numbers; runs ${a.seconds}s + ${b.seconds}s`;
if (!unique.length) {
  console.log(`sanity PASS: nothing moved 3×, nothing new, no floor broken (${head})`);
  process.exit(0);
}
console.log(`sanity FAIL: ${unique.length} flagged in ${lines.length} groups (${head})`);
console.log(row('probe (+ more probes, same change)', 'key', 'main', 'PR', 'change'));
for (const l of lines.slice(0, TOP)) console.log(l);
console.log(
  `${lines.length > TOP ? `+${lines.length - TOP} more groups; ` : ''}every flag: ${join(dir, 'flags.txt')}; drill in: --show <probe> [key]`,
);
process.exit(2);
