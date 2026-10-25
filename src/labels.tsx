/**
 * Labels are projects: a colour and an optional icon, put on resources across accounts. These are
 * the mark that stands for one, the form that makes or edits one, and the picker that labels
 * several resources at once.
 */
import { ColorDot, IconPicker, iconOf, LumenSelector, lumenToast } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Checkbox } from '@columenlabs/lumen-ui/ui/checkbox';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@columenlabs/lumen-ui/ui/popover';
import { Plus, Tag, X } from 'lucide-react';
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
      {Icon ? (
        <span className="flex shrink-0" style={{ color }}>
          <Icon className="size-3.5" />
        </span>
      ) : (
        <ColorDot color={color} />
      )}
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
    try {
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
    } catch (e) {
      lumenToast.error(e instanceof Error ? e.message : 'Saving the label failed');
      return;
    }
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

type Op = 'add' | 'remove';

/**
 * Bulk labels: ticks are staged, each row says how many of the selected resources have it (or
 * what will change), and nothing is saved until Apply. A toast offers Undo.
 */
function StagedLabels({ m, ids, onDone }: { m: Model; ids: string[]; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [pend, setPend] = useState<Record<string, Op>>({});
  const have = (name: string) => ids.filter((id) => (m.labels.assign[id] ?? []).includes(name)).length;
  const query = labelSlug(q);
  const shown = m.labels.labels.filter((l) => !query || l.name.includes(query));
  const newNames = Object.keys(pend).filter((n) => !m.labels.labels.some((l) => l.name === n));
  const toggle = (name: string) =>
    setPend((p) => {
      const next = { ...p };
      if (next[name]) delete next[name];
      else next[name] = have(name) === ids.length ? 'remove' : 'add';
      return next;
    });
  const hit = (name: string, op: Op) => (op === 'add' ? ids.length - have(name) : have(name));
  const lines = Object.entries(pend).map(([name, op]) =>
    op === 'add' ? `Add ${name} to ${hit(name, op)}` : `Remove ${name} from ${hit(name, op)}`,
  );
  const apply = async () => {
    const before = structuredClone(m.labels);
    let changed = 0;
    try {
      await saveLabelDoc(m, (doc) => {
        for (const n of newNames) doc.labels.push({ name: n, c: nextColor(doc) });
        for (const id of ids) {
          const cur = new Set(doc.assign[id] ?? []);
          const was = [...cur].join();
          for (const [name, op] of Object.entries(pend)) op === 'add' ? cur.add(name) : cur.delete(name);
          doc.assign[id] = [...cur];
          if ([...cur].join() !== was) changed++;
        }
      });
    } catch (e) {
      lumenToast.error(e instanceof Error ? e.message : 'Saving labels failed');
      return;
    }
    onDone();
    lumenToast.success(`Updated labels on ${changed} resource${changed === 1 ? '' : 's'}`, {
      action: { label: 'Undo', onClick: () => void saver?.(before) },
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-xs">Labels for {ids.length} resources</span>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find or create a label"
        aria-label="Find or create a label"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query && !m.labels.labels.some((l) => l.name === query)) {
            e.preventDefault();
            setPend((p) => ({ ...p, [query]: 'add' }));
            setQ('');
          }
        }}
      />
      <div className="flex max-h-64 flex-col overflow-y-auto">
        {[...shown.map((l) => l.name), ...newNames.filter((n) => !query || n.includes(query))].map((name) => {
          const op = pend[name];
          const c = have(name);
          const state =
            op === 'add'
              ? true
              : op === 'remove'
                ? false
                : c === ids.length
                  ? true
                  : c
                    ? 'indeterminate'
                    : false;
          return (
            <div
              key={name}
              className={`flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted ${op ? 'bg-primary/5' : ''}`}
            >
              <Checkbox id={`bulk-${name}`} checked={state} onCheckedChange={() => toggle(name)} />
              <LabelMark m={m} name={name} />
              <label htmlFor={`bulk-${name}`} className="flex-1 cursor-pointer truncate">
                {name}
              </label>
              {op ? (
                <span className={`font-mono text-[11px] ${op === 'add' ? 'text-gain' : 'text-loss'}`}>
                  {op === 'add' ? `+${hit(name, op)}` : `−${hit(name, op)}`}
                </span>
              ) : (
                <span
                  className="font-mono text-[11px] text-muted-foreground"
                  title="Selected resources that have it"
                >
                  {c} of {ids.length}
                </span>
              )}
            </div>
          );
        })}
        {query && !m.labels.labels.some((l) => l.name === query) && !newNames.includes(query) && (
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
            onClick={() => {
              setPend((p) => ({ ...p, [query]: 'add' }));
              setQ('');
            }}
          >
            <Plus className="size-4" />
            Create label <b>{query}</b>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t pt-2">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {lines.length
            ? lines.map((l) => (
                <span key={l} className="block">
                  {l}
                </span>
              ))
            : 'Tick a label to add it to all selected; untick one they all have to remove it. Nothing changes until you apply.'}
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={!lines.length} onClick={() => void apply()}>
            Apply to {ids.length}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The floating bar while resources are selected: how many and from where, Select all shown, and
 * Labels… for the staged picker.
 */
export function BulkBar({
  m,
  ids,
  shown,
  onSelect,
}: {
  m: Model;
  ids: string[];
  shown: string[];
  onSelect: (ids: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!ids.length) return null;
  const rs = ids.map((id) => m.resource[id]).filter((r) => !!r);
  const accts = new Set(rs.map((r) => r.acct)).size;
  const prods = new Set(rs.map((r) => r.product)).size;
  const more = shown.filter((id) => !ids.includes(id)).length;
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="-translate-x-1/2 fixed bottom-12 left-1/2 z-50 flex max-w-[calc(100vw-24px)] items-center gap-2 whitespace-nowrap rounded-lg border bg-popover py-1.5 pr-2 pl-1.5 text-sm shadow-lg"
    >
      <Button size="icon" variant="ghost" aria-label="Clear selection" onClick={() => onSelect(new Set())}>
        <X className="size-4" />
      </Button>
      <span>
        <b className="font-mono">{ids.length}</b> selected{' '}
        <span className="text-muted-foreground text-xs">
          {accts} account{accts === 1 ? '' : 's'} · {prods} product{prods === 1 ? '' : 's'}
        </span>
      </span>
      {more > 0 && (
        <Button size="sm" variant="ghost" onClick={() => onSelect(new Set(shown))}>
          Select all {shown.length} shown
        </Button>
      )}
      <span className="h-5 w-px bg-border" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm">
            <Tag className="size-4" />
            Labels…
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-80">
          <StagedLabels m={m} ids={ids} onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
