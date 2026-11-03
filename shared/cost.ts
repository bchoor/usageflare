/**
 * Over budget: the watchdog's money alarm. A Paid account's bill for the month, forecast from
 * what it has used so far (the $5 base plus every meter's forecast overage, as the pages show it),
 * passing the budget set in Settings ▸ Alerts. Names the resource that drives the most of the
 * usage charges. Judged on the read the watchdog already makes: no extra call, no KV.
 * Pure: no I/O.
 */
import { type Account, METRICS, PRODUCT, type Resource } from './catalog';
import { type AccountView, judge } from './judge';
import type { WatchEvent } from './watchdog';

export interface CostSettings {
  on: boolean;
  /** The month's budget per Paid account, in USD, the $5 base included. */
  budget: number;
}

export const PAID_BASE = 5;
export const COST_DEFAULT: CostSettings = { on: true, budget: 10 };

export const usd = (v: number) => `$${v.toFixed(2)}`;

export interface CostInput {
  account: Account;
  resources: Resource[];
  now?: number;
  settings?: CostSettings;
}

/** The account's month-end bill forecast, and who drives its usage charges. */
export function costNow({ account: a, resources, now = Date.now() }: Omit<CostInput, 'settings'>) {
  const d = new Date(now);
  const view: AccountView = {
    ...a,
    color: '',
    day: d.getUTCDate(),
    monthDays: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(),
  };
  const rs = resources.filter((r) => r.acct === a.id);
  let usage = 0;
  const byRes = new Map<string, number>();
  const byMetric = new Map<string, number>();
  for (const m of METRICS) {
    const u = judge(view, m, rs, 75);
    if (!u || !(u.fcost > 0)) continue;
    usage += u.fcost;
    byMetric.set(m.key, (byMetric.get(m.key) ?? 0) + u.fcost);
    const total = u.parts.reduce((s, p) => s + p.v, 0);
    if (total > 0)
      for (const p of u.parts) byRes.set(p.r.id, (byRes.get(p.r.id) ?? 0) + (u.fcost * p.v) / total);
  }
  const top = [...byRes].sort((x, y) => y[1] - x[1])[0];
  const metric = [...byMetric].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
  return { bill: PAID_BASE + usage, usage, top, metric };
}

/** The over-budget alarm for one account's read: at most one a day while the forecast stays over. */
export function cost({
  account: a,
  resources,
  now = Date.now(),
  settings = COST_DEFAULT,
}: CostInput): (WatchEvent & { text: string })[] {
  if (!settings.on || a.plan !== 'paid' || !(settings.budget > 0)) return [];
  const c = costNow({ account: a, resources, now });
  if (c.bill < settings.budget) return [];
  const r = c.top ? resources.find((x) => x.id === c.top?.[0]) : undefined;
  const share = c.top && c.usage > 0 ? c.top[1] / c.usage : 0;
  const m = METRICS.find((x) => x.key === c.metric);
  const meter = m ? `${PRODUCT[m.product]?.label ?? m.product} ${m.label}` : '';
  const who = r?.name === 'Whole account' ? 'account-wide use' : r?.name;
  const by = r
    ? ` ${Math.round(share * 100)}% of the usage charges from ${who}${meter ? ` (mostly ${meter})` : ''}.`
    : '';
  return [
    {
      key: `cost:${a.id}:${new Date(now).toISOString().slice(0, 10)}`,
      kind: 'cost',
      acct: a.id,
      rid: r?.id,
      name: `${a.name}: this month's bill`,
      metric: c.metric,
      at: new Date(now).toISOString(),
      value: c.bill,
      normal: settings.budget,
      x: c.bill / settings.budget,
      by: r ? { name: r.name, share } : undefined,
      text: `${a.name}: this month's bill is on pace for ${usd(c.bill)} (${usd(PAID_BASE)} base + ${usd(c.usage)} usage), over your ${usd(settings.budget)} budget.${by}`,
    },
  ];
}
