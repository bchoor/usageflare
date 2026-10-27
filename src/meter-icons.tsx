/**
 * Settings ▸ Meter icons: one line per meter in the kit's table, grouped by product, its icon
 * picked in place. A meter shows its family's icon until the person picks one.
 */
import { IconPicker, LumenViewCard, type ViewDomain } from '@columenlabs/lumen-ui';
import { Box, Gauge, Shapes, SwatchBook } from 'lucide-react';
import { useMemo } from 'react';
import { FAMILY, METRICS, type Metric, PRODUCT, PRODUCTS } from '../shared/catalog';
import { view } from './domains';
import { useModel, useSavePrefs } from './model';
import { FAMILY_ICON, PRODUCT_ICON } from './products';

const productOf = new Map(PRODUCTS.map((p) => [p.label, p]));

const METERS = view({
  name: 'Meters',
  columns: ['meter', 'kind', 'icon'],
  group: { fields: ['product', 'kind', 'icon'], default: 'product' },
  subgroup: null,
});

export function MeterIconsSettings() {
  const m = useModel();
  const save = useSavePrefs();
  // The meters the accounts use, else every meter (before the first token).
  const used = new Set(m.usage.map((u) => u.m.key));
  const rows = METRICS.filter((x) => !used.size || used.has(x.key));
  const domain = useMemo<ViewDomain<Metric>>(() => {
    const icons = m.prefs.meterIcons ?? {};
    const pick = (x: Metric, icon: string | null) => {
      const next = { ...icons };
      if (icon) next[x.key] = icon;
      else delete next[x.key];
      save.mutate({ ...m.prefs, meterIcons: next });
    };
    return {
      id: 'meter-icons',
      rowKey: (x) => x.key,
      text: (x) => [x.label, PRODUCT[x.product].label, FAMILY[x.family].label],
      fields: [
        {
          key: 'meter',
          label: 'Meter',
          icon: Gauge,
          format: 'text',
          value: (x) => x.label,
          // The icon is its picker: a click opens it in place.
          render: (x) => (
            <span className="flex min-w-0 items-center gap-1.5" style={{ color: PRODUCT[x.product].color }}>
              <IconPicker
                value={icons[x.key]}
                fallback={FAMILY_ICON[x.family]}
                label={`${PRODUCT[x.product].label} ${x.label} icon`}
                onChange={(icon) => pick(x, icon)}
              />
              <span className="truncate text-foreground" title={`${PRODUCT[x.product].label} · ${x.label}`}>
                {x.label}
              </span>
            </span>
          ),
        },
        {
          key: 'product',
          label: 'Product',
          icon: Box,
          format: 'text',
          value: (x) => PRODUCT[x.product].label,
          color: (v) => productOf.get(v)?.color,
          iconOf: (v) => {
            const p = productOf.get(v);
            return p ? PRODUCT_ICON[p.id] : undefined;
          },
          filterable: true,
          groupable: true,
        },
        {
          key: 'kind',
          label: 'Kind',
          icon: Shapes,
          format: 'text',
          value: (x) => FAMILY[x.family].label,
          filterable: true,
          groupable: true,
          hideOnPhone: true,
        },
        {
          key: 'icon',
          label: 'Icon',
          icon: SwatchBook,
          format: 'text',
          value: (x) => (icons[x.key] ? 'Yours' : 'Default'),
          render: (x) => (
            <span className={icons[x.key] ? 'text-xs' : 'text-muted-foreground text-xs'}>
              {icons[x.key] ? 'Yours' : 'Default'}
            </span>
          ),
          filterable: true,
          groupable: true,
        },
      ],
    };
  }, [m.prefs, save.mutate]);
  return <LumenViewCard id="meter-icons" domain={domain} config={METERS} rows={rows} title="Meters" />;
}
