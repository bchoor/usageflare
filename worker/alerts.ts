/**
 * Alerts: a message when a limit's status gets worse (or recovers), by email through a
 * Resend-style API (`POST {url}/emails` with a Bearer key: Resend itself or a self-hosted server
 * that speaks its API) and by a webhook that gets the change as JSON. The check itself runs on a
 * Durable Object alarm (worker/watch.ts); this file holds its settings and the sending.
 *
 * KV: `alerts:v1` → AlertsDoc. The email key and the webhook address are sealed under SETTINGS_KEY
 * (worker/secrets.ts) and never come back through the API: only their last four characters.
 */
import { PRODUCT } from '../shared/catalog';
import { SEVERITY, STATUS_LABEL, type Status } from '../shared/judge';
import type { Env } from './env';
import { type Sealed, seal, unseal } from './secrets';

/** The lowest status that sends a message: Watch, Will exceed (the default) or Over (and Blocked). */
export type AlertLevel = 'watch' | 'soon' | 'over';

export interface TestResult {
  at: string;
  ok: boolean;
  detail?: string | null;
  error?: string | null;
}

interface AlertsDoc {
  v: 1;
  on: boolean;
  level: AlertLevel;
  email: { url: string; from: string; to: string; key: Sealed; last4: string } | null;
  webhook: { url: Sealed; hint: string } | null;
  test: TestResult | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What the Settings section shows: nothing sealed. */
export interface AlertsView {
  on: boolean;
  level: AlertLevel;
  email: { url: string; from: string; to: string; keyHint: string } | null;
  webhook: { hint: string } | null;
  test: TestResult | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A save: a key or webhook address left out keeps the saved one; `null` removes that target. */
export interface AlertsInput {
  on: boolean;
  level: AlertLevel;
  email?: { url: string; from: string; to: string; key?: string } | null;
  webhook?: { url?: string } | null;
}

/** One meter whose status crossed the alert level, one way or the other. */
export interface Change {
  acct: string;
  account: string;
  metric: string;
  label: string;
  product: string;
  from: Status;
  to: Status;
  /** Share of the allowance used, and forecast for the period. */
  pct: number;
  fpct: number;
  /** What `pct` counts: today, this month so far, or a size now. */
  basis: 'today' | 'mtd' | 'now';
}

const KEY = 'alerts:v1';
const EMAIL_AAD = 'alerts:email';
const HOOK_AAD = 'alerts:webhook';
/** Every send gives up after this, so an email API that hangs never holds the alarm. */
const SEND_MS = 10_000;

const EMPTY: AlertsDoc = {
  v: 1,
  on: false,
  level: 'soon',
  email: null,
  webhook: null,
  test: null,
  updatedAt: null,
  updatedBy: null,
};

async function readDoc(env: Env): Promise<AlertsDoc> {
  return { ...EMPTY, ...(await env.KV.get<AlertsDoc>(KEY, 'json')) };
}

const viewOf = (d: AlertsDoc): AlertsView => ({
  on: d.on,
  level: d.level,
  email: d.email ? { url: d.email.url, from: d.email.from, to: d.email.to, keyHint: d.email.last4 } : null,
  webhook: d.webhook ? { hint: d.webhook.hint } : null,
  test: d.test,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

export const getAlerts = async (env: Env) => viewOf(await readDoc(env));

/** True when alerts are on and something can receive them: the alarm runs only then. */
export const alertsLive = (v: AlertsView) => v.on && (!!v.email || !!v.webhook);

export async function putAlerts(env: Env, input: AlertsInput, by: string): Promise<AlertsView> {
  const prev = await readDoc(env);
  let email = prev.email;
  if (input.email === null) email = null;
  else if (input.email) {
    const key = input.email.key?.trim();
    if (!key && !prev.email) throw new Error('The email API key is missing');
    email = {
      url: input.email.url.replace(/\/+$/, ''),
      from: input.email.from,
      to: input.email.to,
      key: key ? await seal(env, EMAIL_AAD, key) : (prev.email?.key as Sealed),
      last4: key ? key.slice(-4) : (prev.email?.last4 ?? ''),
    };
  }
  let webhook = prev.webhook;
  if (input.webhook === null) webhook = null;
  else if (input.webhook?.url) {
    const url = input.webhook.url.trim();
    webhook = { url: await seal(env, HOOK_AAD, url), hint: `${new URL(url).host} …${url.slice(-4)}` };
  }
  const changedTargets =
    JSON.stringify([email?.url, email?.from, email?.to, email?.last4, webhook?.hint]) !==
    JSON.stringify([
      prev.email?.url,
      prev.email?.from,
      prev.email?.to,
      prev.email?.last4,
      prev.webhook?.hint,
    ]);
  const doc: AlertsDoc = {
    v: 1,
    on: input.on,
    level: input.level,
    email,
    webhook,
    // A test of other targets says nothing about these.
    test: changedTargets ? null : prev.test,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
  await env.KV.put(KEY, JSON.stringify(doc));
  return viewOf(doc);
}

// ---------- Sending ----------

const pctText = (p: number) => `${Math.round(p * 100)}%`;
const worse = (c: Change) => SEVERITY[c.to] > SEVERITY[c.from];

function lineOf(c: Change) {
  const what = `${PRODUCT[c.product as keyof typeof PRODUCT]?.label ?? c.product} ${c.label}`;
  const period =
    c.basis === 'today' ? 'used today' : c.basis === 'now' ? 'of the allowance now' : 'used this month';
  return worse(c)
    ? `${what}: ${STATUS_LABEL[c.to]} · ${pctText(c.pct)} ${period}, ${pctText(c.fpct)} forecast`
    : `${what}: back to ${STATUS_LABEL[c.to]} (was ${STATUS_LABEL[c.from]}) · ${pctText(c.pct)} ${period}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** One message for one account's changes: worst first. */
export function messageOf(account: string, changes: Change[], appUrl: string) {
  const sorted = [...changes].sort((x, y) => SEVERITY[y.to] - SEVERITY[x.to]);
  const bad = sorted.filter(worse);
  const subject = bad.length
    ? `${account}: ${bad.length === 1 ? `${lineOf(bad[0] as Change).split(':')[0]} is ${STATUS_LABEL[(bad[0] as Change).to]}` : `${bad.length} limits need a look`}`
    : `${account}: ${sorted.length === 1 ? 'a limit is' : `${sorted.length} limits are`} back under the alert level`;
  const lines = sorted.map(lineOf);
  const text = `${lines.join('\n')}\n\nOpen usageflare: ${appUrl}`;
  const html = `<p>${lines.map(esc).join('<br>')}</p><p><a href="${esc(appUrl)}">Open usageflare</a></p>`;
  return { subject: `usageflare · ${subject}`, text, html };
}

/** A POST with a time limit; a network failure says which host it could not reach. */
async function post(url: string, init: RequestInit) {
  try {
    return await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(SEND_MS) });
  } catch (e) {
    const host = new URL(url).host;
    throw new Error(
      e instanceof Error && e.name === 'TimeoutError'
        ? `${host} did not answer in 10 s`
        : `could not reach ${host}`,
    );
  }
}

async function sendEmail(env: Env, d: NonNullable<AlertsDoc['email']>, msg: ReturnType<typeof messageOf>) {
  const key = await unseal(env, EMAIL_AAD, d.key);
  const res = await post(`${d.url}/emails`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: d.from, to: [d.to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!res.ok) throw new Error(`Email API answered ${res.status}`);
}

async function sendHook(env: Env, d: NonNullable<AlertsDoc['webhook']>, body: unknown) {
  const url = await unseal(env, HOOK_AAD, d.url);
  const res = await post(url, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
}

/** Sends to every target; a target that fails is named, never thrown past the others. */
async function deliver(env: Env, d: AlertsDoc, msg: ReturnType<typeof messageOf>, hook: unknown) {
  const sent: string[] = [];
  const failed: string[] = [];
  await Promise.all([
    d.email &&
      sendEmail(env, d.email, msg).then(
        () => sent.push('email'),
        (e) => failed.push(`email: ${e instanceof Error ? e.message : 'failed'}`),
      ),
    d.webhook &&
      sendHook(env, d.webhook, hook).then(
        () => sent.push('webhook'),
        (e) => failed.push(`webhook: ${e instanceof Error ? e.message : 'failed'}`),
      ),
  ]);
  return { sent, failed };
}

/** The alarm's send: one account's changes. Failures are logged; the next change sends again. */
export async function sendAlert(env: Env, account: string, changes: Change[], appUrl: string) {
  const d = await readDoc(env);
  if (!d.on) return;
  const msg = messageOf(account, changes, appUrl);
  const r = await deliver(env, d, msg, { kind: 'usageflare.alert', account, changes, url: appUrl });
  if (r.failed.length) console.error('alert send failed', r.failed.join('; '));
}

/** Settings' Test: one sample message to every target, its result kept. */
export async function testAlerts(env: Env, appUrl: string): Promise<AlertsView> {
  const d = await readDoc(env);
  const sample: Change = {
    acct: '0'.repeat(32),
    account: 'Test account',
    metric: 'test',
    label: 'requests',
    product: 'workers',
    from: 'ok',
    to: d.level,
    pct: 0.82,
    fpct: 1.12,
    basis: 'today',
  };
  const msg = messageOf('Test account', [sample], appUrl);
  msg.subject = `usageflare · Test alert`;
  const r = await deliver(env, d, msg, { kind: 'usageflare.test', changes: [sample], url: appUrl });
  const test: TestResult = r.failed.length
    ? { at: new Date().toISOString(), ok: false, error: r.failed.join('; ') }
    : r.sent.length
      ? { at: new Date().toISOString(), ok: true, detail: `Sent by ${r.sent.join(' and ')}` }
      : { at: new Date().toISOString(), ok: false, error: 'Add an email or a webhook first' };
  const doc = { ...d, test };
  await env.KV.put(KEY, JSON.stringify(doc));
  return viewOf(doc);
}
