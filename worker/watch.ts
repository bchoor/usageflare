/**
 * The alert check: one Durable Object (`WATCH`, name `alerts`) whose alarm reads every account's
 * usage every 15 minutes, judges each meter like the pages do (shared/judge.ts) and sends one
 * message per account whose meters crossed the alert level (worker/alerts.ts). It never pauses or
 * changes anything; it only tells.
 *
 * A Durable Object alarm, not a cron trigger: an account's free cron triggers are often all used.
 * One account per wake, a few seconds apart, so each read stays inside one invocation's subrequest
 * limit (as one account per request does in worker/index.ts). Storage (SQLite, a few rows): the
 * last status of each meter, and when it last alerted, written only when something changed.
 */
import { DurableObject } from 'cloudflare:workers';
import { METRICS } from '../shared/catalog';
import { inferPlan, judge, SEVERITY, type Status } from '../shared/judge';
import { type AlertLevel, alertsLive, type Change, getAlerts, sendAlert } from './alerts';
import type { Env } from './env';
import { accountRefs, accountUsage, getPrefs } from './usage';

const EVERY_MS = 15 * 60_000;
/** Between two accounts of one round. */
const NEXT_MS = 5_000;

/**
 * A meter's last status, and the severity and UTC day it last alerted at. It alerts again only when
 * it gets worse; back under the level it tells once and re-arms, but not on the day it alerted, so
 * a meter that flaps around the level is heard at most once a day.
 */
interface MeterState {
  st: Status;
  sent?: { day: string; sev: number };
}
type AccountState = Record<string, MeterState>;

export interface WatchState {
  /** The last round's end, and how many accounts it read. */
  checkedAt: string | null;
  accounts: number;
  /** Meters at or past the alert level now, by account. */
  firing: { acct: string; account: string; metric: string; st: Status }[];
  /** The next check, when the alarm is set. */
  nextAt: string | null;
  error: string | null;
}

interface Round {
  i: number;
  ids: { id: string; name: string }[];
}

const LEVEL_SEV: Record<AlertLevel, number> = {
  watch: SEVERITY.watch,
  soon: SEVERITY.soon,
  over: SEVERITY.over,
};
const BY_SEV = Object.fromEntries(Object.entries(SEVERITY).map(([st, n]) => [n, st as Status]));
const nextMark = (now = Date.now()) => Math.floor(now / EVERY_MS) * EVERY_MS + EVERY_MS;
const utcDay = () => new Date().toISOString().slice(0, 10);

export class Watch extends DurableObject<Env> {
  /** Turns the check on (alerts on with a target) or off; `origin` is the app link the messages carry. */
  async sync(origin: string): Promise<WatchState> {
    const live = alertsLive(await getAlerts(this.env));
    if ((await this.ctx.storage.get<string>('origin')) !== origin)
      await this.ctx.storage.put('origin', origin);
    const alarm = await this.ctx.storage.getAlarm();
    if (live && alarm === null) await this.ctx.storage.setAlarm(Date.now() + NEXT_MS);
    if (!live && alarm !== null) await this.ctx.storage.deleteAlarm();
    return this.state();
  }

  async state(): Promise<WatchState> {
    const [s, alarm] = await Promise.all([
      this.ctx.storage.get<Omit<WatchState, 'nextAt'>>('summary'),
      this.ctx.storage.getAlarm(),
    ]);
    return {
      checkedAt: s?.checkedAt ?? null,
      accounts: s?.accounts ?? 0,
      firing: s?.firing ?? [],
      error: s?.error ?? null,
      nextAt: alarm === null ? null : new Date(alarm).toISOString(),
    };
  }

  async alarm() {
    const settings = await getAlerts(this.env);
    if (!alertsLive(settings)) return;
    let round = (await this.ctx.storage.get<Round>('round')) ?? null;
    try {
      if (!round) {
        const { accounts } = await accountRefs(this.env, false, (w) => this.ctx.waitUntil(w));
        round = { i: 0, ids: accounts.map((a) => ({ id: a.id, name: a.name })) };
      }
      const ref = round.ids[round.i];
      if (ref) await this.check(ref, LEVEL_SEV[settings.level]);
      round = { ...round, i: round.i + 1 };
    } catch (e) {
      console.error('alert check', e);
      round = round ? { ...round, i: round.i + 1 } : null;
      await this.summarize({ error: e instanceof Error ? e.message : 'Check failed' });
    }
    if (round && round.i < round.ids.length) {
      await this.ctx.storage.put('round', round);
      await this.ctx.storage.setAlarm(Date.now() + NEXT_MS);
      return;
    }
    await this.ctx.storage.delete('round');
    if (round) await this.summarize({ done: round.ids });
    await this.ctx.storage.setAlarm(nextMark());
  }

  /** One account: judge every meter, then alert on what crossed the level since the last look. */
  private async check(ref: { id: string; name: string }, level: number) {
    let read = await accountUsage(this.env, ref.id, false, (w) => this.ctx.waitUntil(w));
    // The cached copy is past its 10 minutes: read Cloudflare now (the pages' Refresh does the same).
    if (read?.stale) read = await accountUsage(this.env, ref.id, true, (w) => this.ctx.waitUntil(w));
    if (!read) return;
    const prefs = await getPrefs(this.env);
    const now = new Date();
    const view = {
      ...inferPlan(read),
      color: '',
      day: now.getUTCDate(),
      monthDays: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate(),
    };
    const key = `acct:${ref.id}`;
    const prev = (await this.ctx.storage.get<AccountState>(key)) ?? {};
    const next: AccountState = {};
    const changes: Change[] = [];
    const day = utcDay();
    for (const m of METRICS) {
      const u = judge(view, m, read.resources, prefs.warn);
      if (!u) continue;
      const was = prev[m.key];
      const sev = SEVERITY[u.st];
      const state: MeterState = { st: u.st, sent: was?.sent };
      const change = (from: Status): Change => ({
        acct: ref.id,
        account: ref.name,
        metric: m.key,
        label: m.label,
        product: m.product,
        from,
        to: u.st,
        pct: u.pct,
        fpct: u.fpct,
        basis: u.basis,
      });
      if (sev >= level && (!state.sent || sev > state.sent.sev)) {
        // Worse than its last alert: tell (a first look tells too, so a meter already over is heard).
        changes.push(change(was?.st ?? 'ok'));
        state.sent = { day, sev };
      } else if (sev < level && state.sent && state.sent.day !== day) {
        // Back under the level after an alert on an earlier day: tell once, and arm it again.
        changes.push(change(BY_SEV[state.sent.sev] ?? 'ok'));
        state.sent = undefined;
      }
      next[m.key] = state;
    }
    if (changes.length) {
      const origin = (await this.ctx.storage.get<string>('origin')) ?? '';
      await sendAlert(this.env, ref.name, changes, `${origin}/app/a/${ref.id}`);
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) await this.ctx.storage.put(key, next);
  }

  /** The round's summary for Settings, written only when it says something new. */
  private async summarize(r: { done?: { id: string; name: string }[]; error?: string }) {
    const prev = await this.ctx.storage.get<Omit<WatchState, 'nextAt'>>('summary');
    const settings = await getAlerts(this.env);
    const level = LEVEL_SEV[settings.level];
    let firing = prev?.firing ?? [];
    if (r.done) {
      const states = await this.ctx.storage.get<AccountState>(r.done.map((a) => `acct:${a.id}`));
      firing = r.done.flatMap((a) =>
        Object.entries(states.get(`acct:${a.id}`) ?? {})
          .filter(([, s]) => SEVERITY[s.st] >= level)
          .map(([metric, s]) => ({ acct: a.id, account: a.name, metric, st: s.st })),
      );
    }
    const summary = {
      checkedAt: r.done ? new Date().toISOString() : (prev?.checkedAt ?? null),
      accounts: r.done ? r.done.length : (prev?.accounts ?? 0),
      firing,
      error: r.error ?? (r.done ? null : (prev?.error ?? null)),
    };
    // `checkedAt` moves every round: kept at most hourly unless something else changed.
    const same =
      prev &&
      JSON.stringify({ ...summary, checkedAt: null }) === JSON.stringify({ ...prev, checkedAt: null }) &&
      prev.checkedAt &&
      Date.now() - Date.parse(prev.checkedAt) < 60 * 60_000;
    if (!same) await this.ctx.storage.put('summary', summary);
  }
}
