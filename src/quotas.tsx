/**
 * An account's Limits: each meter's pooled quota, and which label uses how much of it. A meter's
 * quota is the account's, shared by every resource that uses it, so a row here is one label's
 * slice of one account meter. Grouped by product; each meter folds its labels under one rolled-up
 * line (the kit's sub-group) that reads the pool again from its rows (`poolShare`).
 */
import {
  iconOf,
  meterValueTone,
  type PaceWindow,
  poolShare,
  ShareMeter,
  UnitValue,
  type ViewDomain,
} from '@columenlabs/lumen-ui';
import { Box, ChartColumn, DollarSign, Gauge, Server, Tag, Timer, TriangleAlert } from 'lucide-react';
import { PRODUCT, PRODUCTS, type Resource } from '../shared/catalog';
import { amountParts } from './domains';
import { labelColor, type Model, pctText, perText, STATUS_LABEL, shareOf, type Usage } from './model';
import { hitting, MeterPaceCell } from './pace';
import { PRODUCT_ICON, ProductIcon } from './products';

export const NO_LABEL = 'No label';

/** One label's slice of an account meter. */
export interface QuotaRow {
  u: Usage;
  label: string;
  used: number;
  /** Its share of the account's whole quota (0 to 1; the labels of a meter add up to the meter). */
  share: number;
  /** Its share of the forecast, on the same quota. */
  fshare: number;
  fcost: number;
  parts: { r: Resource; v: number }[];
}

export const meterName = (u: Usage) => `${PRODUCT[u.m.product].label} · ${u.m.label}`;

/**
 * Every meter of `us` split by label. A resource with several labels is split evenly between
 * them, so a meter's labels add up to the meter; one with none counts under "No label".
 */
export function quotaRows(m: Model, us: Usage[]): QuotaRow[] {
  const out: QuotaRow[] = [];
  for (const u of us) {
    const by = new Map<string, { v: number; parts: { r: Resource; v: number }[] }>();
    for (const p of u.parts) {
      if (!(p.v > 0)) continue;
      const ls = m.labelsOf(p.r);
      const names = ls.length ? ls : [NO_LABEL];
      for (const l of names) {
        const e = by.get(l) ?? { v: 0, parts: [] };
        e.v += p.v / names.length;
        e.parts.push({ r: p.r, v: p.v / names.length });
        by.set(l, e);
      }
    }
    for (const [label, e] of by) {
      const of = u.used > 0 ? e.v / u.used : 0;
      out.push({
        u,
        label,
        used: e.v,
        share: u.payg ? 0 : shareOf(u, e.v),
        fshare: u.payg ? 0 : u.fpct * of,
        fcost: u.hard ? 0 : u.fcost * of,
        parts: e.parts.sort((a, b) => b.v - a.v),
      });
    }
  }
  return out;
}

const productOf = new Map(PRODUCTS.map((p) => [p.label, p]));
const poolKey = (q: QuotaRow) => `${q.u.a.id}|${q.u.m.key}`;
const colorOf = (m: Model, label: string) =>
  label === NO_LABEL
    ? 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)'
    : labelColor(m.labels, label);

/** Its share of the quota: a bar in the kit's meter colours and the number. */
function QuotaShare({ share, payg }: { share: number; payg?: boolean }) {
  if (payg) return <span className="text-muted-foreground text-xs">Pay as you go</span>;
  return <ShareMeter value={share} label={pctText(share)} />;
}

export function quotaDomain(m: Model, w: PaceWindow): ViewDomain<QuotaRow> {
  // A meter line or group reads its pools again from its rows: one pool splits by label, several
  // read the fullest.
  const pools = (qs: QuotaRow[]) =>
    poolShare(qs, { pool: poolKey, used: (q) => q.used, cap: (q) => (q.u.payg ? 0 : q.u.limit) });
  return {
    id: 'quotas',
    rowKey: (q) => `${poolKey(q)}|${q.label}`,
    text: (q) => [q.label, q.u.m.label, PRODUCT[q.u.m.product].label],
    fields: [
      {
        key: 'label',
        label: 'Label',
        icon: Tag,
        format: 'text',
        value: (q) => q.label,
        color: (v) => colorOf(m, v),
        iconOf: (v) => {
          const icon = m.labels.labels.find((l) => l.name === v)?.icon;
          return icon ? iconOf(icon, Tag) : undefined;
        },
        filterable: true,
        groupable: true,
      },
      {
        key: 'product',
        label: 'Product',
        icon: Box,
        format: 'text',
        value: (q) => PRODUCT[q.u.m.product].label,
        color: (v) => productOf.get(v)?.color,
        iconOf: (v) => {
          const p = productOf.get(v);
          return p ? PRODUCT_ICON[p.id] : undefined;
        },
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'meter',
        label: 'Meter',
        icon: Gauge,
        format: 'text',
        value: (q) => meterName(q.u),
        filterable: true,
        hideOnPhone: true,
      },
      {
        key: 'used',
        label: 'Used',
        icon: ChartColumn,
        format: 'number',
        value: (q) => q.used,
        aggregate: 'sum',
        hideOnPhone: true,
        render: (q) => {
          const [n, unit] = amountParts(q.used, q.u.m.unit);
          return <UnitValue value={n} unit={unit} />;
        },
        // One meter sums with its unit; a product's meters count different things, so stay blank.
        rollRender: (qs) => {
          const ps = pools(qs).pools;
          if (ps.length !== 1 || !qs[0]) return null;
          const [n, unit] = amountParts(ps[0]?.used ?? 0, qs[0].u.m.unit);
          return <UnitValue value={n} unit={unit} />;
        },
      },
      {
        key: 'quota',
        label: 'Quota',
        icon: Server,
        format: 'number',
        value: (q) => (q.u.payg ? null : q.u.limit),
        empty: 'None',
        aggregate: 'max',
        hideOnPhone: true,
        render: (q) => {
          if (q.u.payg) return null;
          const [n, unit] = amountParts(q.u.limit, q.u.m.unit);
          return <UnitValue value={n} unit={`${unit}${perText(q.u)}`} />;
        },
        rollRender: (qs) => {
          const ps = pools(qs).pools;
          const q = qs[0];
          if (ps.length !== 1 || !q || q.u.payg) return null;
          const [n, unit] = amountParts(q.u.limit, q.u.m.unit);
          return <UnitValue value={n} unit={`${unit}${perText(q.u)}`} />;
        },
      },
      {
        key: 'pct',
        label: '% of quota',
        icon: Gauge,
        format: 'percent',
        value: (q) => q.share * 100,
        aggregate: 'max',
        render: (q) => <QuotaShare share={q.share} payg={q.u.payg} />,
        // A meter: its labels stacked on the quota. A product: its fullest meter.
        rollRender: (qs, level) => {
          const { share, top } = pools(qs);
          if (!top) return null;
          if (top.cap <= 0) return <QuotaShare share={0} payg />;
          // A product or label (and the Total): its fullest meter's %, no bar; bars are per meter.
          if (level !== 'fold') {
            const t = meterValueTone(share);
            const tone = t === 'loss' ? 'text-loss' : t === 'warning' ? 'text-warning' : '';
            return <span className={`num text-xs ${tone}`}>{pctText(share)}</span>;
          }
          const segs = [...top.rows]
            .sort((a, b) => b.used - a.used)
            .map((q) => ({ value: q.share, color: colorOf(m, q.label), label: q.label }));
          return <ShareMeter value={share} label={pctText(share)} segments={segs} />;
        },
      },
      {
        key: 'fpct',
        label: 'Forecast',
        icon: ChartColumn,
        format: 'percent',
        value: (q) => (q.u.payg ? null : q.fshare * 100),
        aggregate: 'max',
        hideOnPhone: true,
        render: (q) => (q.u.payg ? null : <UnitValue value={pctText(q.fshare).slice(0, -1)} unit="%" />),
        rollRender: (qs) => {
          const { share, top } = poolShare(qs, {
            pool: poolKey,
            used: (q) => q.fshare,
            cap: (q) => (q.u.payg ? 0 : 1),
          });
          return top && top.cap > 0 ? <UnitValue value={pctText(share).slice(0, -1)} unit="%" /> : null;
        },
      },
      {
        key: 'cost',
        label: 'Extra cost',
        icon: DollarSign,
        format: 'price',
        value: (q) => (q.u.hard ? null : q.fcost),
        empty: 'Hard limit',
        aggregate: 'sum',
        hideOnPhone: true,
      },
      {
        key: 'pace',
        label: 'Hits limit',
        icon: Timer,
        format: 'number',
        // The pool hits its cap, not a label: only meter lines and groups show it.
        value: () => null,
        empty: '',
        aggregate: 'min',
        hideOnPhone: true,
        rollRender: (qs) => {
          const us = [...new Map(qs.map((q) => [poolKey(q), q.u])).values()];
          const first = hitting(us, w)[0]?.u ?? (us.length === 1 ? us[0] : undefined);
          return first ? <MeterPaceCell u={first} w={w} /> : null;
        },
      },
      {
        key: 'top',
        label: 'Biggest resource',
        icon: Server,
        format: 'text',
        value: (q) => q.parts[0]?.r.name ?? null,
        render: (q) => (
          <span className="text-muted-foreground text-xs">
            {q.parts[0]?.r.name}
            {q.parts.length > 1 ? ` +${q.parts.length - 1}` : ''}
          </span>
        ),
        hideOnPhone: true,
      },
      {
        key: 'status',
        label: 'Status',
        icon: TriangleAlert,
        format: 'text',
        value: (q) => STATUS_LABEL[q.u.st],
        filterable: true,
        hideOnPhone: true,
      },
    ],
    subgroups: [
      {
        key: 'meter',
        label: 'Meter',
        icon: Gauge,
        under: (q) => meterName(q.u),
        always: true,
        open: true,
        mark: (_k, qs) =>
          qs[0] ? <ProductIcon id={qs[0].u.m.product} className="size-3.5 shrink-0" /> : null,
        flat: ['label'],
      },
    ],
  };
}
