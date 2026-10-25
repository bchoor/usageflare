/**
 * Labels are projects: a colour and an optional icon, put on resources across accounts. These are
 * the mark that stands for one, the form that makes or edits one, and the picker that labels
 * several resources at once.
 */
import { ColorDot, IconPicker, iconOf, LumenSelector, lumenToast } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@columenlabs/lumen-ui/ui/popover';
import { Tag } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { LabelsDoc } from '../shared/catalog';
import { LABEL_COLORS, labelColor, labelSlug, type Model } from './model';

/** Applies labels to resources: `values` replaces each one's labels; new names become labels. */
export function setLabels(m: Model, ids: string[], values: string[]) {
  return saveLabelDoc(m, (doc) => {
    for (const v of values)
      if (!doc.labels.some((l) => l.name === v)) doc.labels.push({ name: v, c: nextColor(doc) });
    for (const id of ids) doc.assign[id] = values;
  });
}

export const nextColor = (doc: LabelsDoc) => doc.labels.reduce((n, l) => Math.max(n, l.c), -1) + 1;

let saver: ((doc: LabelsDoc) => Promise<unknown>) | null = null;
/** The label store's save, set by the app once (the mutation lives in React). */
export const registerLabelSaver = (fn: typeof saver) => {
  saver = fn;
};
export function saveLabelDoc(m: Model, edit: (doc: LabelsDoc) => void) {
  const doc = structuredClone(m.labels);
  edit(doc);
  return saver ? saver(doc) : Promise.resolve();
}

/** A label's icon in its colour, else its colour dot; with its name when asked. */
export function LabelMark({ m, name, withName }: { m: Model; name: string; withName?: boolean }) {
  const l = m.labels.labels.find((x) => x.name === name);
  const color = labelColor(m.labels, name);
  const Icon = l?.icon ? iconOf(l.icon, Tag) : null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {Icon ? <Icon className="size-3.5" /> : <ColorDot color={color} />}
      {withName && name}
    </span>
  );
}

/** Make a label, or change one's name, colour and icon (renaming moves its resources with it). */
export function LabelForm({
  m,
  edit,
  children,
  onDone,
}: {
  m: Model;
  edit?: string;
  children: ReactNode;
  onDone?: (name: string) => void;
}) {
  const ex = edit ? m.labels.labels.find((l) => l.name === edit) : undefined;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(ex?.name ?? '');
  const [c, setC] = useState(ex?.c ?? nextColor(m.labels));
  const [icon, setIcon] = useState<string | null>(ex?.icon ?? null);
  const slug = labelSlug(name);
  const taken = !!slug && slug !== ex?.name && m.labels.labels.some((l) => l.name === slug);
  const save = async () => {
    await saveLabelDoc(m, (doc) => {
      const label = { name: slug, c, ...(icon ? { icon } : {}) };
      const i = doc.labels.findIndex((l) => l.name === (ex?.name ?? slug));
      if (i >= 0) doc.labels[i] = label;
      else doc.labels.push(label);
      if (ex && ex.name !== slug) {
        for (const [id, names] of Object.entries(doc.assign))
          doc.assign[id] = names.map((n) => (n === ex.name ? slug : n));
      }
    });
    lumenToast.success(ex ? `Saved ${slug}` : `Made ${slug}; label resources from their Labels cell`);
    setOpen(false);
    onDone?.(slug);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setName(ex?.name ?? '');
          setC(ex?.c ?? nextColor(m.labels));
          setIcon(ex?.icon ?? null);
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-3" align="start">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (slug && !taken) void save();
          }}
        >
          <label htmlFor="label-name" className="font-semibold text-sm">
            {ex ? 'Edit label' : 'New label'}
          </label>
          <Input
            id="label-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. billing-v2"
            autoFocus
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">Colour</span>
            <div className="flex flex-wrap gap-1.5">
              {LABEL_COLORS.map((col, i) => (
                <button
                  key={col}
                  type="button"
                  aria-label={`Colour ${i + 1}`}
                  aria-pressed={c % LABEL_COLORS.length === i}
                  onClick={() => setC(i)}
                  className="size-5 rounded-full ring-1 ring-border aria-pressed:ring-2 aria-pressed:ring-foreground"
                  style={{ background: col }}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Icon (optional)</span>
            <IconPicker value={icon} onChange={setIcon} fallback={Tag} label="Label icon" variant="outline" />
          </div>
          {taken && <p className="text-destructive text-xs">A label with that name exists.</p>}
          <Button type="submit" size="sm" disabled={!slug || taken}>
            {ex ? 'Save' : 'Create'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Labels on one or more resources: ticks add a label to all of them, untick removes it. */
export function LabelPicker({
  m,
  ids,
  trigger = 'field',
}: {
  m: Model;
  ids: string[];
  trigger?: 'field' | 'chip';
}) {
  const counts = new Map<string, number>();
  for (const id of ids) for (const n of m.labels.assign[id] ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
  const all = [...counts].filter(([, n]) => n === ids.length).map(([name]) => name);
  return (
    <LumenSelector
      multiple
      trigger={trigger}
      icon={Tag}
      size="sm"
      label={ids.length > 1 ? `Labels for ${ids.length} resources` : 'Labels'}
      placeholder="Add a label"
      options={m.labels.labels.map((l) => ({
        value: l.name,
        label: l.name,
        icon: () => <LabelMark m={m} name={l.name} />,
      }))}
      value={all}
      create={(q) => labelSlug(q) || null}
      createLabel={(q) => `Create label ${labelSlug(q)}`}
      onChange={(next) =>
        saveLabelDoc(m, (doc) => {
          for (const v of next)
            if (!doc.labels.some((l) => l.name === v)) doc.labels.push({ name: v, c: nextColor(doc) });
          const added = next.filter((n) => !all.includes(n));
          const removed = all.filter((n) => !next.includes(n));
          for (const id of ids) {
            const cur = new Set(doc.assign[id] ?? []);
            for (const n of added) cur.add(n);
            for (const n of removed) cur.delete(n);
            doc.assign[id] = [...cur];
          }
        })
      }
    />
  );
}

/** Adds or removes labels on every selected resource (bulk select on Resources). */
export function BulkLabels({ m, ids, onClear }: { m: Model; ids: string[]; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-primary/5 px-3 py-1.5 text-sm">
      <b className="font-mono">{ids.length}</b> selected
      <LabelPicker m={m} ids={ids} trigger="chip" />
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
