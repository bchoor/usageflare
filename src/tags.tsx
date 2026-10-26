/**
 * Tags are projects: a colour and an optional icon, put on resources, and kept in Cloudflare (its
 * resource tags) where the account has a tags token. Each account keeps its own tags, as Cloudflare
 * does; the same name in two accounts is two tags that a filter by name finds together. These are the mark that stands
 * for one, the form that makes or edits one, and the pickers that tag one or several resources.
 */
import { ColorDot, IconPicker, iconOf, LumenSelector, lumenToast } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Checkbox } from '@columenlabs/lumen-ui/ui/checkbox';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@columenlabs/lumen-ui/ui/popover';
import { Plus, Tag as TagIcon, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { acctOf, CF_TAG_TYPE, PRODUCT, type Resource, type TagsDoc, type TagsState } from '../shared/catalog';
import { findTag, type Model, TAG_COLORS, tagColor, tagNames, tagSlug } from './model';

/** Applies tags to resources: `values` replaces each one's tags; new names become tags in its account. */
export function setTags(m: Model, ids: string[], values: string[]) {
  return saveTagDoc(m, (doc) => {
    for (const id of ids) {
      for (const v of values) ensureTag(doc, acctOf(id), v);
      doc.assign[id] = values;
    }
  });
}

/** The next colour in an account's own palette order. */
export const nextColor = (doc: TagsDoc, acct: string) =>
  doc.tags.filter((l) => l.acct === acct).reduce((n, l) => Math.max(n, l.c), -1) + 1;

/** Makes `name` a tag of `acct` if it isn't one; the same name elsewhere lends its colour and icon. */
export function ensureTag(doc: TagsDoc, acct: string, name: string) {
  if (doc.tags.some((l) => l.acct === acct && l.name === name)) return;
  const like = doc.tags.find((l) => l.name === name);
  doc.tags.push(like ? { ...like, acct } : { acct, name, c: nextColor(doc, acct) });
}

/** The accounts of some resources, each once. */
const acctsOf = (ids: string[]) => [...new Set(ids.map(acctOf))];

let saver: ((doc: TagsDoc, base: TagsDoc, push?: boolean) => Promise<TagsState>) | null = null;
/** The tag store's save, set by the app once (the mutation lives in React). */
export const registerTagSaver = (fn: typeof saver) => {
  saver = fn;
};
/**
 * Saves an edited copy of the tags (only what the edit changed is sent); resources Cloudflare
 * refused are named in a toast. Answers both copies, so an Undo can send the change back.
 */
export async function saveTagDoc(m: Model, edit: (doc: TagsDoc) => void, push?: boolean) {
  const base: TagsDoc = structuredClone({ tags: m.tags.tags, assign: m.tags.assign });
  const doc: TagsDoc = structuredClone(base);
  edit(doc);
  if (!saver) return null;
  const out = await saver(doc, base, push);
  reportFailed(m, out);
  return { out, base, doc };
}

/** Undo for a save: takes the resources back from `doc` to `base`. */
export function undoTags(m: Model, saved: { base: TagsDoc; doc: TagsDoc } | null) {
  if (saved && saver) void saver(saved.base, saved.doc).then((out) => reportFailed(m, out));
}

/** One toast for the writes Cloudflare refused, naming the first few resources and why. */
export function reportFailed(m: Model, out: TagsState) {
  const failed = out.failed ?? [];
  if (!failed.length) return;
  const name = (id: string) => m.resource[id]?.name ?? id.split(':').slice(2).join(':');
  const first = failed[0] as { id: string; error: string };
  lumenToast.error(
    failed.length === 1
      ? `Cloudflare didn't take the tags on ${name(first.id)}: ${first.error}`
      : `Cloudflare didn't take the tags on ${failed.length} resources (${failed
          .slice(0, 3)
          .map((f) => name(f.id))
          .join(', ')}${failed.length > 3 ? ', …' : ''}): ${first.error}`,
  );
}

/** A tag's icon in its colour, else its colour dot; with its name when asked. */
export function TagMark({
  m,
  name,
  acct,
  withName,
}: {
  m: Model;
  name: string;
  /** Its account; without one, the first account that has the name. */
  acct?: string;
  withName?: boolean;
}) {
  const l = findTag(m.tags, name, acct);
  const color = tagColor(m.tags, name, acct);
  const Icon = l?.icon ? iconOf(l.icon, TagIcon) : null;
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

/**
 * Make a tag in an account, or change one's name, colour and icon (renaming moves that account's
 * resources with it). Without `acct` the form asks which account.
 */
export function TagForm({
  m,
  acct,
  edit,
  children,
  onDone,
}: {
  m: Model;
  acct?: string;
  edit?: string;
  children: ReactNode;
  onDone?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(acct ?? m.accounts[0]?.id ?? '');
  const a = acct ?? pick;
  const ex = edit ? m.tags.tags.find((l) => l.name === edit && l.acct === a) : undefined;
  const [name, setName] = useState(ex?.name ?? '');
  const [c, setC] = useState(ex?.c ?? nextColor(m.tags, a));
  const [icon, setIcon] = useState<string | null>(ex?.icon ?? null);
  // A Cloudflare `key=value` tag keeps its name here; only its colour and icon change.
  const fixed = !!ex?.name.includes('=');
  const slug = fixed ? (ex?.name ?? '') : tagSlug(name);
  const taken = !!slug && slug !== ex?.name && m.tags.tags.some((l) => l.name === slug && l.acct === a);
  const save = async () => {
    try {
      await saveTagDoc(m, (doc) => {
        const tag = { acct: a, name: slug, c, ...(icon ? { icon } : {}) };
        const i = doc.tags.findIndex((l) => l.acct === a && l.name === (ex?.name ?? slug));
        if (i >= 0) doc.tags[i] = tag;
        else doc.tags.push(tag);
        if (ex && ex.name !== slug) {
          for (const [id, names] of Object.entries(doc.assign))
            if (acctOf(id) === a) doc.assign[id] = names.map((n) => (n === ex.name ? slug : n));
        }
      });
    } catch (e) {
      lumenToast.error(e instanceof Error ? e.message : 'Saving the tag failed');
      return;
    }
    lumenToast.success(ex ? `Saved ${slug}` : `Made ${slug}; tag resources from their Tags cell`);
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
          setC(ex?.c ?? nextColor(m.tags, a));
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
          <label htmlFor="tag-name" className="font-semibold text-sm">
            {ex ? 'Edit tag' : 'New tag'}
            {acct && m.accounts.length > 1 && (
              <span className="font-normal text-muted-foreground"> in {m.account[acct]?.name ?? acct}</span>
            )}
          </label>
          {!acct && !ex && m.accounts.length > 1 && (
            <LumenSelector
              size="sm"
              label="Account"
              options={m.accounts.map((x) => ({ value: x.id, label: x.name }))}
              value={pick}
              onChange={(v) => v && setPick(v)}
            />
          )}
          <Input
            id="tag-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. billing-v2"
            disabled={fixed}
            autoFocus
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">Colour</span>
            <div className="flex flex-wrap gap-1.5">
              {TAG_COLORS.map((col, i) => (
                <button
                  key={col}
                  type="button"
                  aria-label={`Colour ${i + 1}`}
                  aria-pressed={c % TAG_COLORS.length === i}
                  onClick={() => setC(i)}
                  className="size-5 rounded-full ring-1 ring-border aria-pressed:ring-2 aria-pressed:ring-foreground"
                  style={{ background: col }}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Icon (optional)</span>
            <IconPicker
              value={icon}
              onChange={setIcon}
              fallback={TagIcon}
              label="Tag icon"
              variant="outline"
            />
          </div>
          {taken && <p className="text-destructive text-xs">This account has a tag with that name.</p>}
          <Button type="submit" size="sm" disabled={!slug || taken}>
            {ex ? 'Save' : 'Create'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Tags on one or more resources: ticks add a tag to all of them, untick removes it. */
export function TagPicker({
  m,
  ids,
  trigger = 'field',
}: {
  m: Model;
  ids: string[];
  trigger?: 'field' | 'chip';
}) {
  const counts = new Map<string, number>();
  for (const id of ids) for (const n of m.tags.assign[id] ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
  const all = [...counts].filter(([, n]) => n === ids.length).map(([name]) => name);
  const accts = acctsOf(ids);
  const one = accts.length === 1 ? accts[0] : undefined;
  return (
    <LumenSelector
      multiple
      trigger={trigger}
      icon={TagIcon}
      size="sm"
      label={ids.length > 1 ? `Tags for ${ids.length} resources` : 'Tags'}
      placeholder="Add a tag"
      options={tagNames(m.tags, accts).map((n) => ({
        value: n,
        label: n,
        icon: () => <TagMark m={m} name={n} acct={one} />,
      }))}
      value={all}
      create={(q) => tagSlug(q) || null}
      createLabel={(q) => `Create tag ${tagSlug(q)}`}
      onChange={(next) =>
        saveTagDoc(m, (doc) => {
          const added = next.filter((n) => !all.includes(n));
          const removed = all.filter((n) => !next.includes(n));
          for (const id of ids) {
            for (const n of added) ensureTag(doc, acctOf(id), n);
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
 * Bulk tags: ticks are staged, each row says how many of the selected resources have it (or
 * what will change), and nothing is saved until Apply. A toast offers Undo.
 */
function StagedTags({
  m,
  ids,
  onDone,
  onApplied,
}: {
  m: Model;
  ids: string[];
  onDone: () => void;
  /** After Apply: the bulk bar clears the selection and goes away (Undo restores the tags). */
  onApplied?: () => void;
}) {
  const [q, setQ] = useState('');
  const [pend, setPend] = useState<Record<string, Op>>({});
  const have = (name: string) => ids.filter((id) => (m.tags.assign[id] ?? []).includes(name)).length;
  const query = tagSlug(q);
  const accts = acctsOf(ids);
  const one = accts.length === 1 ? accts[0] : undefined;
  const names = tagNames(m.tags, accts);
  const shown = names.filter((n) => !query || n.includes(query));
  const newNames = Object.keys(pend).filter((n) => !names.includes(n));
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
    let changed = 0;
    let saved: Awaited<ReturnType<typeof saveTagDoc>> = null;
    try {
      saved = await saveTagDoc(m, (doc) => {
        for (const id of ids) {
          for (const [name, op] of Object.entries(pend)) if (op === 'add') ensureTag(doc, acctOf(id), name);
          const cur = new Set(doc.assign[id] ?? []);
          const was = [...cur].join();
          for (const [name, op] of Object.entries(pend)) op === 'add' ? cur.add(name) : cur.delete(name);
          doc.assign[id] = [...cur];
          if ([...cur].join() !== was) changed++;
        }
      });
    } catch (e) {
      lumenToast.error(e instanceof Error ? e.message : 'Saving tags failed');
      return;
    }
    onDone();
    onApplied?.();
    lumenToast.success(`Updated tags on ${changed} resource${changed === 1 ? '' : 's'}`, {
      action: { label: 'Undo', onClick: () => undoTags(m, saved) },
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-xs">Tags for {ids.length} resources</span>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find or create a tag"
        aria-label="Find or create a tag"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query && !names.includes(query)) {
            e.preventDefault();
            setPend((p) => ({ ...p, [query]: 'add' }));
            setQ('');
          }
        }}
      />
      <div className="flex max-h-64 flex-col overflow-y-auto">
        {[...shown, ...newNames.filter((n) => !query || n.includes(query))].map((name) => {
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
              <TagMark m={m} name={name} acct={one} />
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
        {query && !names.includes(query) && !newNames.includes(query) && (
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
            onClick={() => {
              setPend((p) => ({ ...p, [query]: 'add' }));
              setQ('');
            }}
          >
            <Plus className="size-4" />
            Create tag <b>{query}</b>
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
            : 'Tick a tag to add it to all selected; untick one they all have to remove it. Nothing changes until you apply.'}
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
 * Tags… for the staged picker.
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
            <TagIcon className="size-4" />
            Tags…
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-80">
          <StagedTags m={m} ids={ids} onDone={() => setOpen(false)} onApplied={() => onSelect(new Set())} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Where a resource's tags live: Cloudflare, usageflare (and why), or the Workers that bind it. */
export function TagSource({ m, r }: { m: Model; r: Resource }) {
  const from = m.inherited(r);
  const workers = m.resources.filter((w) => w.binds?.includes(r.id) && m.tagsOf(w).length);
  const text = from.length
    ? `From ${workers.map((w) => w.name).join(', ')}, the Worker${workers.length === 1 ? '' : 's'} that bind${workers.length === 1 ? 's' : ''} it`
    : !CF_TAG_TYPE[r.product]
      ? `Kept in usageflare: Cloudflare can't tag ${PRODUCT[r.product].label} yet`
      : m.tags.access[r.acct]?.write
        ? m.tags.local[r.id]?.length
          ? 'Kept in usageflare until moved to Cloudflare (Settings › Tags)'
          : 'Saved as Cloudflare resource tags'
        : 'Kept in usageflare: add a tags token for this account to save them in Cloudflare';
  return <p className="text-muted-foreground text-xs">{text}</p>;
}
