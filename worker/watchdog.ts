/**
 * The watchdog: a Durable Object whose alarm checks one account a step (every 5 minutes, so three
 * accounts are each read every 15), judges the read with `shared/watchdog.ts` and tells the person
 * what is abnormal: here (the Watchdog page, the status bar) and on the targets they turned on in
 * Settings ▸ Notifications (email through the hub's relay, ntfy, webhooks). Never on a request: a
 * page only reads what the alarm wrote. The account's free cron triggers are all taken, so the
 * alarm is the schedule; any API call makes sure one is set.
 *
 * SQLite: `events` (one row per thing that happened, kept 30 days; INSERTs name their columns) and
 * `state` (the bookmark, each account's last check, the notification targets). Writes happen
 * only when something changes; KV is never written here (its 1,000 writes a day are the page's).
 * Every call out has a timeout, and a failed one is recorded, never thrown.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  describe,
  KIND_DETAIL,
  KIND_LABEL,
  KINDS,
  type WatchEvent,
  type WatchKind,
  watch,
} from '../shared/watchdog';
import { historyDates } from './cloudflare';
import type { Env } from './env';
import { fixtureRefs, fixtureUsage } from './fixtures';
import { seal, unseal } from './secrets';
import { accountRefs, accountUsage, getPrefs } from './usage';

/** One step a while: each account is read every `STEP_MS × accounts`. */
const STEP_MS = 5 * 60_000;
/** After Check now: the next account follows at once. */
const NOW_MS = 2_000;
/** An account unreadable this long is reported (once a day). */
const BLIND_MS = 60 * 60_000;
const KEEP_DAYS = 30;
const SEND_MS = 8_000;
/** The hub's relay takes longer: it may go out over a tunnel. */
const MAIL_MS = 20_000;

export interface KeyTest {
  at: string;
  ok: boolean;
  detail?: string | null;
  error?: string | null;
}

export interface Webhook {
  id: string;
  name: string;
  /** Sealed (`hook:<id>:url`). */
  url: string;
  /** Shown masked: origin and the path's last characters. */
  shown: string;
  /** Values sealed (`hook:<id>:h:<name>`). */
  headers: { name: string; value: string }[];
  created_at: string;
  last_test: KeyTest | null;
}

interface Targets {
  email?: { address: string; created_at: string; last_test: KeyTest | null };
  ntfy?: {
    server: string;
    topic: string;
    token?: string;
    last4?: string;
    created_at: string;
    last_test: KeyTest | null;
  };
  webhooks: Webhook[];
  /** Event kind → targets it is off for (`email`, `ntfy`, a webhook id). */
  off: Partial<Record<WatchKind, string[]>>;
}

export interface AccountCheck {
  name: string;
  at: string;
  ok: boolean;
  error?: string;
  /** Since when it could not be read (ms), while it can't. */
  down?: number;
  /** When the data judged was read from Cloudflare (`account.syncedAt`). */
  readAt?: string;
}

export interface StoredEvent extends WatchEvent {
  /** When the watchdog first saw it (ms). */
  seen: number;
  text: string;
  /** Targets it went to, and those that failed. */
  sent: string[];
  failed: string[];
}

export interface WatchdogStatus {
  /** When the next step runs (ms); null when no alarm is set. */
  next: number | null;
  accounts: Record<string, AccountCheck>;
  events: StoredEvent[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, acct TEXT NOT NULL, rid TEXT, name TEXT NOT NULL,
  metric TEXT NOT NULL, at TEXT NOT NULL, value REAL NOT NULL, normal REAL NOT NULL, x REAL NOT NULL,
  level REAL, seen INTEGER NOT NULL, text TEXT NOT NULL, sent TEXT NOT NULL DEFAULT '[]',
  failed TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS events_seen ON events(seen);
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const json = <T>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, no) =>
      setTimeout(() => no(new Error(`${what} did not answer in ${ms / 1000} s`)), ms),
    ),
  ]);

export class Watchdog extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private get<T>(k: string, d: T): T {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM state WHERE k = ?', k).toArray()[0];
    return json(row?.v, d);
  }

  private put(k: string, v: unknown) {
    const s = JSON.stringify(v);
    const row = this.sql.exec<{ v: string }>('SELECT v FROM state WHERE k = ?', k).toArray()[0];
    if (row?.v === s) return;
    this.sql.exec('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, s);
  }

  /** Sets the alarm when none is set; remembers where the app is, for links in what it sends. */
  async ensure(origin?: string): Promise<void> {
    if (origin && /^https?:\/\/[^/]+$/.test(origin)) this.put('origin', origin);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + NOW_MS);
  }

  /** Check now: every account in turn, one step each, starting at once. */
  async run(): Promise<WatchdogStatus> {
    this.put('rush', true);
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return this.status();
  }

  async status(): Promise<WatchdogStatus> {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    const rows = this.sql
      .exec<Record<string, string | number | null>>(
        // Newest first; within one check, the moves before the limits.
        `SELECT key, kind, acct, rid, name, metric, at, value, normal, x, level, seen, text, sent, failed FROM events WHERE seen >= ?
         ORDER BY seen DESC, CASE kind WHEN 'blind' THEN 0 WHEN 'spike' THEN 1 WHEN 'surge' THEN 2 WHEN 'new' THEN 3 WHEN 'runsOut' THEN 4 ELSE 5 END LIMIT 500`,
        cutoff,
      )
      .toArray();
    return {
      next: await this.ctx.storage.getAlarm(),
      accounts: this.get<Record<string, AccountCheck>>('accounts', {}),
      events: rows.map((r) => ({
        key: String(r.key),
        kind: r.kind as WatchKind,
        acct: String(r.acct),
        rid: r.rid === null ? undefined : String(r.rid),
        name: String(r.name),
        metric: String(r.metric),
        at: String(r.at),
        value: Number(r.value),
        normal: Number(r.normal),
        x: Number(r.x),
        level: r.level === null ? undefined : Number(r.level),
        seen: Number(r.seen),
        text: String(r.text),
        sent: json<string[]>(String(r.sent), []),
        failed: json<string[]>(String(r.failed), []),
      })),
    };
  }

  // ---------- The step ----------

  async alarm(): Promise<void> {
    const refs =
      this.env.FIXTURES === '1' ? fixtureRefs().accounts : (await accountRefs(this.env, false)).accounts;
    const ids = refs.map((a) => a.id).sort();
    const checks = this.get<Record<string, AccountCheck>>('accounts', {});
    const rush = this.get<boolean | string[]>('rush', false);
    let left: string[] = rush === true ? ids : Array.isArray(rush) ? rush : [];
    // The next account after the bookmark, or the first of a Check now.
    const mark = this.get<string>('mark', '');
    const id = left[0] ?? ids.find((x) => x > mark) ?? ids[0];
    try {
      if (id) {
        this.put('mark', id);
        left = left.filter((x) => x !== id);
        await this.check(id, refs.find((a) => a.id === id)?.name ?? id, checks);
      }
      // Accounts no token reaches any more are forgotten.
      for (const k of Object.keys(checks)) if (!ids.includes(k)) delete checks[k];
      this.put('accounts', checks);
      this.trim();
    } finally {
      this.put('rush', left.length ? left : false);
      await this.ctx.storage.setAlarm(Date.now() + (left.length ? NOW_MS : STEP_MS));
    }
  }

  private async check(id: string, name: string, checks: Record<string, AccountCheck>) {
    const now = Date.now();
    const prev = checks[id];
    let usage: Awaited<ReturnType<typeof accountUsage>> | ReturnType<typeof fixtureUsage>;
    let error: string | undefined;
    try {
      usage =
        this.env.FIXTURES === '1'
          ? fixtureUsage(id, historyDates())
          : await accountUsage(this.env, id, true, (w) => this.ctx.waitUntil(w), { persist: false });
    } catch (e) {
      usage = null;
      error = e instanceof Error ? e.message.slice(0, 200) : 'Read failed';
    }
    // A copy older than the blind window counts as unread: Cloudflare answered with the last one.
    const readAt = usage?.account.syncedAt;
    const fresh = !!usage && !!readAt && now - Date.parse(readAt) < BLIND_MS;
    if (!fresh && !error) error = 'Cloudflare served no new read';
    const down = fresh ? undefined : (prev?.down ?? now);
    checks[id] = {
      name,
      at: new Date(now).toISOString(),
      ok: fresh,
      error: fresh ? undefined : error,
      down,
      readAt,
    };
    const found: WatchEvent[] = [];
    if (usage && fresh) {
      const { warn } = await getPrefs(this.env);
      found.push(
        ...watch({ account: usage.account, resources: usage.resources, dates: usage.dates, warn, now }),
      );
    } else if (down !== undefined && now - down >= BLIND_MS) {
      const since = new Date(down).toISOString();
      found.push({
        key: `blind:${id}:${day(now)}`,
        kind: 'blind',
        acct: id,
        name,
        metric: '',
        at: since,
        value: 0,
        normal: 0,
        x: 0,
      });
    }
    await this.record(found, now, name);
  }

  /** Keeps what is new, and sends each to the targets that want it. */
  private async record(found: WatchEvent[], now: number, account: string) {
    if (!found.length) return;
    const known = new Set<string>();
    for (let i = 0; i < found.length; i += 50) {
      const keys = found.slice(i, i + 50).map((e) => e.key);
      for (const r of this.sql
        .exec<{ key: string }>(
          `SELECT key FROM events WHERE key IN (${keys.map(() => '?').join(',')})`,
          ...keys,
        )
        .toArray())
        known.add(r.key);
    }
    const fresh = found.filter((e) => !known.has(e.key));
    if (!fresh.length) return;
    const targets = this.targets();
    const origin = this.get<string>('origin', '');
    for (const e of fresh) {
      const text = describe(e, fmt, account);
      this.sql.exec(
        'INSERT INTO events (key, kind, acct, rid, name, metric, at, value, normal, x, level, seen, text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        e.key,
        e.kind,
        e.acct,
        e.rid ?? null,
        e.name,
        e.metric,
        e.at,
        e.value,
        e.normal,
        e.x,
        e.level ?? null,
        now,
        text,
      );
      // One send a day per thing and kind: a spike every hour on one Worker tells once.
      const thing = `${e.kind}:${e.rid ?? e.acct}:${e.metric}:${day(now)}`;
      const told = this.get<string[]>('told', []).filter((t) => t.endsWith(day(now)));
      if (told.includes(thing)) continue;
      const out = await this.send(targets, e.kind, { ...e, text }, origin);
      if (out.sent.length || out.failed.length)
        this.sql.exec(
          'UPDATE events SET sent = ?, failed = ? WHERE key = ?',
          JSON.stringify(out.sent),
          JSON.stringify(out.failed),
          e.key,
        );
      if (out.sent.length) this.put('told', [...told, thing]);
    }
  }

  /** Events older than 30 days go, a few hundred a step. */
  private trim() {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    this.sql.exec(
      'DELETE FROM events WHERE key IN (SELECT key FROM events WHERE seen < ? LIMIT 200)',
      cutoff,
    );
  }

  // ---------- Sending ----------

  private targets(): Targets {
    return this.get<Targets>('targets', { webhooks: [], off: {} });
  }

  private async send(t: Targets, kind: WatchKind, e: WatchEvent & { text: string }, origin: string) {
    const off = new Set(t.off[kind] ?? []);
    const link = origin ? `${origin}/app/watchdog` : '';
    const title = `${KIND_LABEL[kind]}: ${e.name}`;
    const sent: string[] = [];
    const failed: string[] = [];
    const go = async (id: string, f: () => Promise<KeyTest>) => {
      const r = await f().catch((x) => ({ at: '', ok: false, error: String(x) }));
      (r.ok ? sent : failed).push(id);
      if (!r.ok) console.error(JSON.stringify({ event: 'watchdog_send', target: id, error: r.error }));
    };
    const { email, ntfy } = t;
    await Promise.all([
      email && !off.has('email')
        ? go('email', () => this.mail(email.address, title, e.text, link, kind))
        : null,
      ntfy && !off.has('ntfy') ? go('ntfy', () => this.push(ntfy, title, e.text, link, kind)) : null,
      ...t.webhooks
        .filter((h) => !off.has(h.id))
        .map((h) =>
          go(h.id, () =>
            this.post(h, kind, `${KIND_LABEL[kind]} in ${e.metric || 'an account'}`, link, e.at),
          ),
        ),
    ]);
    return { sent, failed };
  }

  private async mail(
    to: string,
    title: string,
    text: string,
    link: string,
    kind: WatchKind | 'test',
  ): Promise<KeyTest> {
    const at = new Date().toISOString();
    if (!this.env.MAIL) return { at, ok: false, error: 'Email is not set up on this server' };
    const r = await within(
      this.env.MAIL.alert({
        to,
        subject: `usageflare · ${title}`,
        brand: { name: 'usageflare', color: '#f38020', mark: 'u' },
        tag: kind === 'test' ? 'Test' : KIND_LABEL[kind],
        title,
        lines: [text],
        links: link ? [{ text: 'Open the watchdog', href: link }] : undefined,
        footer: { text: 'Sent by the usageflare watchdog. Turn it off in Settings ▸ Notifications.' },
      }),
      MAIL_MS,
      'The email relay',
    );
    return r.ok ? { at, ok: true, detail: r.detail } : { at, ok: false, error: r.detail };
  }

  private async push(
    n: NonNullable<Targets['ntfy']>,
    title: string,
    text: string,
    link: string,
    kind: WatchKind | 'test',
  ): Promise<KeyTest> {
    const at = new Date().toISOString();
    const token = n.token ? await unseal(this.env, 'ntfy:token', JSON.parse(n.token)) : null;
    const res = await fetch(`${n.server}/${encodeURIComponent(n.topic)}`, {
      method: 'POST',
      headers: {
        Title: `usageflare · ${title}`.replace(/[^\x20-\x7e]/g, ''),
        Tags:
          kind === 'test'
            ? 'white_check_mark'
            : kind === 'blind'
              ? 'see_no_evil'
              : 'chart_with_upwards_trend',
        Priority: kind === 'level' || kind === 'runsOut' || kind === 'spike' ? '4' : '3',
        ...(link ? { Click: link } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: text,
      signal: AbortSignal.timeout(SEND_MS),
    });
    return res.ok
      ? { at, ok: true, detail: `ntfy answered ${res.status}` }
      : { at, ok: false, error: `ntfy answered ${res.status}` };
  }

  private async post(
    h: Webhook,
    event: string,
    message: string,
    click: string,
    when: string,
  ): Promise<KeyTest> {
    const at = new Date().toISOString();
    const url = await unseal(this.env, `hook:${h.id}:url`, JSON.parse(h.url));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const x of h.headers)
      headers[x.name] = await unseal(this.env, `hook:${h.id}:h:${x.name}`, JSON.parse(x.value));
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event, title: `usageflare: ${event}`, message, click, at: when }),
      signal: AbortSignal.timeout(SEND_MS),
    });
    return res.ok
      ? { at, ok: true, detail: `Answered ${res.status}` }
      : { at, ok: false, error: `Answered ${res.status}` };
  }

  // ---------- Settings ▸ Notifications (Lumen's NotificationsSettings contract) ----------

  async notifications() {
    const t = this.targets();
    const testing = !!this.env.MAIL;
    return {
      email: t.email
        ? {
            available: testing,
            connected: true as const,
            address: t.email.address,
            created_at: t.email.created_at,
            last_test: t.email.last_test,
          }
        : { available: testing, connected: false as const },
      ntfy: t.ntfy
        ? {
            connected: true as const,
            server: t.ntfy.server,
            topic: t.ntfy.topic,
            token: t.ntfy.last4 ? `••••${t.ntfy.last4}` : null,
            created_at: t.ntfy.created_at,
            last_test: t.ntfy.last_test,
          }
        : { connected: false as const },
      webhooks: t.webhooks.map((h) => ({
        id: h.id,
        name: h.name,
        url: h.shown,
        headers: h.headers.map((x) => ({ name: x.name, value: '••••' })),
        created_at: h.created_at,
        last_test: h.last_test,
      })),
      events: KINDS.map((k) => ({
        key: k,
        label: KIND_LABEL[k],
        detail: KIND_DETAIL[k],
        off: t.off[k] ?? [],
      })),
    };
  }

  private save(t: Targets) {
    this.put('targets', t);
    return this.notifications();
  }

  async emailOn(address: string) {
    const t = this.targets();
    if (!this.env.MAIL) throw new Error('Email is not set up on this server');
    t.email = { address, created_at: new Date().toISOString(), last_test: null };
    return this.save(t);
  }

  async emailOff() {
    const t = this.targets();
    delete t.email;
    return this.save(t);
  }

  async emailTest() {
    const t = this.targets();
    if (!t.email) throw new Error('Email is off');
    const origin = this.get<string>('origin', '');
    t.email.last_test = await this.mail(
      t.email.address,
      'Test',
      'The watchdog can reach you here. It writes when usage moves far from its normal, or an allowance runs low.',
      origin ? `${origin}/app/watchdog` : '',
      'test',
    ).catch((e) => ({ at: new Date().toISOString(), ok: false, error: String(e) }));
    return this.save(t);
  }

  async ntfyOn() {
    const t = this.targets();
    const topic = `usageflare-${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    t.ntfy = { server: 'https://ntfy.sh', topic, created_at: new Date().toISOString(), last_test: null };
    return this.save(t);
  }

  async ntfyOff() {
    const t = this.targets();
    delete t.ntfy;
    return this.save(t);
  }

  async ntfyToken(token: string) {
    const t = this.targets();
    if (!t.ntfy) throw new Error('ntfy is off');
    t.ntfy.token = JSON.stringify(await seal(this.env, 'ntfy:token', token));
    t.ntfy.last4 = token.slice(-4);
    t.ntfy.last_test = null;
    return this.save(t);
  }

  async ntfyTest() {
    const t = this.targets();
    if (!t.ntfy) throw new Error('ntfy is off');
    t.ntfy.last_test = await this.push(
      t.ntfy,
      'Test',
      'The watchdog can reach this phone.',
      '',
      'test',
    ).catch((e) => ({
      at: new Date().toISOString(),
      ok: false,
      error: e instanceof Error ? e.message : 'ntfy not reachable',
    }));
    return this.save(t);
  }

  async hookAdd(input: { name: string; url: string; headers: { name: string; value: string }[] }) {
    const t = this.targets();
    if (t.webhooks.length >= 10) throw new Error('Ten webhooks at most');
    const id = `wh_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const u = new URL(input.url);
    const headers = [];
    for (const h of input.headers)
      headers.push({
        name: h.name,
        value: JSON.stringify(await seal(this.env, `hook:${id}:h:${h.name}`, h.value)),
      });
    t.webhooks.push({
      id,
      name: input.name,
      url: JSON.stringify(await seal(this.env, `hook:${id}:url`, input.url)),
      shown: `${u.origin}/…${(u.pathname + u.search).slice(-4)}`,
      headers,
      created_at: new Date().toISOString(),
      last_test: null,
    });
    return this.save(t);
  }

  async hookRemove(id: string) {
    const t = this.targets();
    t.webhooks = t.webhooks.filter((h) => h.id !== id);
    for (const k of KINDS) if (t.off[k]) t.off[k] = t.off[k]?.filter((x) => x !== id);
    return this.save(t);
  }

  async hookTest(id: string) {
    const t = this.targets();
    const h = t.webhooks.find((x) => x.id === id);
    if (!h) throw new Error('No such webhook');
    h.last_test = await this.post(
      h,
      'test',
      'A test from the usageflare watchdog',
      '',
      new Date().toISOString(),
    ).catch((e) => ({
      at: new Date().toISOString(),
      ok: false,
      error: e instanceof Error ? e.message : 'Not reachable',
    }));
    return this.save(t);
  }

  async setEvent(kind: WatchKind, target: string, on: boolean) {
    const t = this.targets();
    const off = new Set(t.off[kind] ?? []);
    if (on) off.delete(target);
    else off.add(target);
    t.off[kind] = [...off];
    return this.save(t);
  }
}

/** `9,252`, `1.4K`, `2.1M`: short enough for a phone notification. */
function fmt(v: number, unit: string) {
  const a = Math.abs(v);
  const n =
    a >= 1e9
      ? `${(v / 1e9).toFixed(1)}B`
      : a >= 1e6
        ? `${(v / 1e6).toFixed(1)}M`
        : a >= 1e4
          ? `${(v / 1e3).toFixed(1)}K`
          : a >= 10
            ? `${Math.round(v).toLocaleString('en-US')}`
            : v.toFixed(2);
  return unit ? `${n} ${unit}` : n;
}

/** The one watchdog. */
export const watchdog = (env: Env) => env.WATCHDOG.get(env.WATCHDOG.idFromName('watchdog'));
