/**
 * Settings ▸ Alerts ▸ Burning fast: the dials of the watchdog's main alarm (shared/burn.ts). A
 * share of a day's budget used within a window; a monthly limit's day is the limit over 30. Each
 * line reads as a sentence: "Runaway: 10% in 15 min".
 */
import { apiJson, ErrorLine, LumenSelector, lumenToast, SaveButton, SettingRow } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { Switch } from '@columenlabs/lumen-ui/ui/switch';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BURN_DEFAULT, BURN_WINDOWS, type BurnDial, type BurnSettings, windowText } from '../shared/burn';

const API = '/api/notifications';
const KEY = ['notifications', API];
const WINDOWS = BURN_WINDOWS.map((w) => ({ value: String(w), label: windowText(w) }));
const PER: { id: 'day'; label: string; note: string }[] = [
  {
    id: 'day',
    label: 'Per day',
    note: "Share of a day's budget; a monthly limit's day is 1/30 of it",
  },
];
const LINE = ['Runaway', 'Climbing', 'Third'];

export function BurnSettingsBlock({ value }: { value: BurnSettings | undefined }) {
  const qc = useQueryClient();
  const saved = value ?? BURN_DEFAULT;
  const [d, setD] = useState<BurnSettings>(saved);
  const stamp = JSON.stringify(saved);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` is the saved dials' content.
  useEffect(() => setD(saved), [stamp]);
  const save = useMutation({
    mutationFn: (b: BurnSettings) =>
      apiJson<unknown>(
        `${API}/burn`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) },
        'notifications.burn',
      ),
    onSuccess: (r) => {
      qc.setQueryData(KEY, r);
      lumenToast.success('Saved the burning fast dials');
    },
  });
  const dirty = JSON.stringify(d) !== stamp;
  const setDial = (per: 'day', i: number, p: Partial<BurnDial>) =>
    setD((x) => ({ ...x, [per]: x[per].map((g, j) => (j === i ? { ...g, ...p } : g)) }));
  const issues = (['day'] as const).flatMap((per) =>
    d[per].flatMap((g, i) =>
      Number.isFinite(g.pct) && g.pct > 0 && g.pct <= 100
        ? []
        : [
            {
              where: LINE[i] ?? 'Dial',
              message: 'A % from 0.01 to 100',
              target: `burn-${per}-${i}`,
            },
          ],
    ),
  );
  return (
    <div className="flex flex-col gap-3">
      <SettingRow
        label="Burning fast"
        htmlFor="burn-on"
        description="Alert when a day's budget is used up too fast"
      >
        <Switch
          id="burn-on"
          checked={d.on}
          disabled={save.isPending}
          onCheckedChange={(on) => {
            setD((x) => ({ ...x, on }));
            save.mutate({ ...d, on });
          }}
        />
      </SettingRow>
      {d.on &&
        PER.map((p) => (
          <SettingRow key={p.id} label={p.label} description={p.note}>
            <div className="flex flex-col items-end gap-1.5">
              {d[p.id].map((g, i) => (
                <div key={`${p.id}-${LINE[i]}`} className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-muted-foreground text-xs">{LINE[i]}</span>
                  <Input
                    id={`burn-${p.id}-${i}`}
                    aria-label={`${p.label}, ${LINE[i]}: % of the limit`}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    className="num w-20"
                    value={Number.isFinite(g.pct) ? g.pct : ''}
                    onChange={(e) =>
                      setDial(p.id, i, { pct: e.target.value === '' ? Number.NaN : Number(e.target.value) })
                    }
                  />
                  <span className="text-muted-foreground text-sm">% in</span>
                  <LumenSelector
                    label={`${p.label}, ${LINE[i]}: window`}
                    size="sm"
                    options={WINDOWS}
                    value={String(g.mins)}
                    onChange={(v) => setDial(p.id, i, { mins: Number(v) })}
                  />
                </div>
              ))}
            </div>
          </SettingRow>
        ))}
      <ErrorLine error={save.error} />
      {d.on && (
        <div className="flex items-center justify-end gap-2">
          {JSON.stringify(d.day) !== JSON.stringify(BURN_DEFAULT.day) && (
            <Button size="sm" variant="ghost" onClick={() => setD((x) => ({ ...x, day: BURN_DEFAULT.day }))}>
              Defaults
            </Button>
          )}
          <SaveButton
            issues={issues}
            busy={save.isPending}
            disabled={!dirty}
            label="Save dials"
            onSave={() => save.mutate(d)}
          />
        </div>
      )}
    </div>
  );
}
