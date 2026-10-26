/**
 * The Tags page: every tag with how many resources and accounts carry it and where it's kept
 * (Cloudflare, usageflare or both), as a kit table. Ticked tags take a bulk bar: edit one (name,
 * colour, icon), merge several into one, or delete them. Tags still kept here for resources
 * Cloudflare can hold move there with one confirmed step.
 */
import { LumenConfirm, LumenSelector, lumenToast, type ViewDomain } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Building2, CloudUpload, Combine, MapPin, Palette, Rows3, Tag, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { CF_TAG_TYPE, PROJECT_PREFIX, type Resource, type TagsDoc } from '../shared/catalog';
import type { Model } from './model';
import { saveTagDoc, TagForm, TagMark, undoTags } from './tags';

export interface TagRow {
  name: string;
  /** `Project` for usageflare's own tags, `Cloudflare tag` for a `key=value` made elsewhere. */
  kind: 'Project' | 'Cloudflare tag';
  /** Resources that carry it (their own tag, not one shown from a Worker that binds them). */
  ids: string[];
  accts: string[];
  /** Of those, how many keep it in Cloudflare and how many only here. */
  inCf: number;
  local: number;
  /** Resources Cloudflare can't tag that show it from a Worker that binds them. */
  inherited: number;
}

export const tagKind = (name: string): TagRow['kind'] => (name.includes('=') ? 'Cloudflare tag' : 'Project');

export function tagRows(m: Model): TagRow[] {
  const live = m.resources.filter((r) => !r.total);
  return m.tags.tags.map((t) => {
    const ids = Object.keys(m.tags.assign).filter((id) => m.tags.assign[id]?.includes(t.name));
    const local = ids.filter((id) => m.tags.local[id]?.includes(t.name)).length;
    return {
      name: t.name,
      kind: tagKind(t.name),
      ids,
      accts: [...new Set(ids.map((id) => id.split(':')[0] ?? ''))],
      inCf: ids.length - local,
      local,
      inherited: live.filter((r) => m.inherited(r).includes(t.name)).length,
    };
  });
}

const whereOf = (t: TagRow) =>
  t.ids.length === 0 ? 'Unused' : t.local === 0 ? 'Cloudflare' : t.inCf === 0 ? 'usageflare' : 'Both';
const WHERE_NOTE: Record<string, string> = {
  Cloudflare: 'Saved as Cloudflare resource tags',
  usageflare: 'Kept in usageflare: Cloudflare can’t tag those resources, or their account has no tags token',
  Both: 'Some resources keep it in Cloudflare, some only in usageflare',
  Unused: 'On no resource yet',
};

export function tagDomain(m: Model): ViewDomain<TagRow> {
  return {
    id: 'tags',
    rowKey: (t) => t.name,
    text: (t) => [t.name, t.kind],
    fields: [
      {
        key: 'name',
        label: 'Tag',
        icon: Tag,
        format: 'text',
        value: (t) => t.name,
        render: (t) => <TagMark m={m} name={t.name} withName />,
      },
      {
        key: 'key',
        label: 'Key in Cloudflare',
        icon: Tag,
        format: 'text',
        value: (t) => (t.kind === 'Project' ? PROJECT_PREFIX + t.name : (t.name.split('=')[0] ?? t.name)),
        render: (t) => (
          <span className="font-mono text-muted-foreground text-xs">
            {t.kind === 'Project' ? PROJECT_PREFIX + t.name : t.name.split('=')[0]}
          </span>
        ),
        hideOnPhone: true,
      },
      {
        key: 'kind',
        label: 'Kind',
        icon: Tag,
        format: 'text',
        value: (t) => t.kind,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'resources',
        label: 'Resources',
        icon: Rows3,
        format: 'integer',
        value: (t) => t.ids.length,
        aggregate: 'sum',
      },
      {
        key: 'accounts',
        label: 'Accounts',
        icon: Building2,
        format: 'integer',
        value: (t) => t.accts.length,
        aggregate: 'max',
        hideOnPhone: true,
      },
      {
        key: 'where',
        label: 'Kept in',
        icon: MapPin,
        format: 'text',
        value: whereOf,
        filterable: true,
        groupable: true,
        render: (t) => (
          <span
            title={WHERE_NOTE[whereOf(t)]}
            className={whereOf(t) === 'Cloudflare' ? '' : 'text-muted-foreground'}
          >
            {whereOf(t)}
          </span>
        ),
      },
      {
        key: 'local',
        label: 'Only in usageflare',
        icon: MapPin,
        format: 'integer',
        value: (t) => t.local,
        aggregate: 'sum',
        hideOnPhone: true,
      },
      {
        key: 'inherited',
        label: 'From Workers',
        icon: Rows3,
        format: 'integer',
        value: (t) => t.inherited,
        aggregate: 'sum',
        hideOnPhone: true,
      },
    ],
  };
}

/** Resources whose tags are kept here though Cloudflare could hold them (a tags token reaches the account). */
export function movable(m: Model): string[] {
  return Object.keys(m.tags.local).filter((id) => {
    const [acct = '', product] = id.split(':') as [string, Resource['product']];
    return !!m.tags.local[id]?.length && !!CF_TAG_TYPE[product] && !!m.tags.access[acct]?.write;
  });
}

/** Moves tags kept here to Cloudflare, after a preview of how many per account. */
export function MoveToCloudflare({ m }: { m: Model }) {
  const ids = movable(m);
  if (!ids.length) return null;
  const by = new Map<string, number>();
  for (const id of ids) by.set(id.split(':')[0] ?? '', (by.get(id.split(':')[0] ?? '') ?? 0) + 1);
  return (
    <LumenConfirm
      title={`Move tags on ${ids.length} resource${ids.length === 1 ? '' : 's'} to Cloudflare?`}
      destructive={false}
      action="Move"
      busyAction="Moving…"
      description={
        <span className="flex flex-col gap-1">
          <span>
            Each resource's tags are written to Cloudflare as resource tags; tags made in the Cloudflare
            dashboard stay as they are.
          </span>
          {[...by].map(([a, n]) => (
            <span key={a} className="font-mono text-xs">
              {m.account[a]?.name ?? a}: {n}
            </span>
          ))}
        </span>
      }
      onConfirm={async () => {
        const saved = await saveTagDoc(m, () => {}, true);
        if (saved && !saved.out.failed?.length) lumenToast.success('Tags moved to Cloudflare');
      }}
    >
      <Button size="sm" variant="outline">
        <CloudUpload className="size-4" />
        Move {ids.length} to Cloudflare
      </Button>
    </LumenConfirm>
  );
}

/** Drops `names` from the tags and every resource; `into` keeps their resources under that one. */
function rewrite(doc: TagsDoc, names: string[], into?: string) {
  const gone = new Set(names.filter((n) => n !== into));
  doc.tags = doc.tags.filter((t) => !gone.has(t.name));
  for (const [id, ns] of Object.entries(doc.assign)) {
    const next = new Set(ns.filter((n) => !gone.has(n)));
    if (into && ns.some((n) => gone.has(n))) next.add(into);
    doc.assign[id] = [...next];
  }
}

/** The floating bar while tags are ticked: edit one, merge several, delete. */
export function TagBulkBar({
  m,
  names,
  onSelect,
}: {
  m: Model;
  names: string[];
  onSelect: (keys: Set<string>) => void;
}) {
  const [into, setInto] = useState<string | null>(null);
  if (!names.length) return null;
  const rows = tagRows(m).filter((t) => names.includes(t.name));
  const touched = new Set(rows.flatMap((t) => t.ids)).size;
  const projects = names.filter((n) => tagKind(n) === 'Project');
  const save = async (edit: (doc: TagsDoc) => void, done: string) => {
    let saved: Awaited<ReturnType<typeof saveTagDoc>> = null;
    try {
      saved = await saveTagDoc(m, edit);
    } catch (e) {
      lumenToast.error(e instanceof Error ? e.message : 'Saving tags failed');
      return;
    }
    onSelect(new Set());
    lumenToast.success(done, {
      action: { label: 'Undo', onClick: () => undoTags(m, saved) },
    });
  };
  return (
    <div
      role="toolbar"
      aria-label="Tag actions"
      className="-translate-x-1/2 fixed bottom-12 left-1/2 z-50 flex max-w-[calc(100vw-24px)] items-center gap-2 whitespace-nowrap rounded-lg border bg-popover py-1.5 pr-2 pl-1.5 text-sm shadow-lg"
    >
      <Button size="icon" variant="ghost" aria-label="Clear selection" onClick={() => onSelect(new Set())}>
        <X className="size-4" />
      </Button>
      <span>
        <b className="font-mono">{names.length}</b> selected{' '}
        <span className="text-muted-foreground text-xs">
          on {touched} resource{touched === 1 ? '' : 's'}
        </span>
      </span>
      <span className="h-5 w-px bg-border" />
      {names.length === 1 && (
        <TagForm m={m} edit={names[0]} onDone={() => onSelect(new Set())}>
          <Button size="sm" variant="ghost">
            <Palette className="size-4" />
            Edit…
          </Button>
        </TagForm>
      )}
      {projects.length > 1 && (
        <>
          <LumenSelector
            trigger="chip"
            size="sm"
            icon={Combine}
            label="Merge into"
            placeholder="Merge into…"
            options={projects.map((n) => ({ value: n, label: n, icon: () => <TagMark m={m} name={n} /> }))}
            value={into ?? ''}
            onChange={(v) => setInto(v || null)}
          />
          {into && (
            <LumenConfirm
              title={`Merge ${projects.length} tags into ${into}?`}
              destructive={false}
              action="Merge"
              description={`Every resource with ${projects
                .filter((n) => n !== into)
                .join(', ')} gets ${into} instead; those tags are removed.`}
              onConfirm={() =>
                save(
                  (doc) => rewrite(doc, projects, into),
                  `Merged ${projects.length} tags into ${into}`,
                ).then(() => setInto(null))
              }
            >
              <Button size="sm">Merge</Button>
            </LumenConfirm>
          )}
        </>
      )}
      <LumenConfirm
        title={`Delete ${names.length} tag${names.length === 1 ? '' : 's'}?`}
        action="Delete"
        description={`They come off ${touched} resource${touched === 1 ? '' : 's'}, in Cloudflare too where they're kept there.`}
        onConfirm={() =>
          save((doc) => rewrite(doc, names), `Deleted ${names.length} tag${names.length === 1 ? '' : 's'}`)
        }
      >
        <Button size="sm" variant="ghost">
          <Trash2 className="size-4" />
          Delete
        </Button>
      </LumenConfirm>
    </div>
  );
}

/** Per account: whether its tags are saved in Cloudflare, for the page's intro. */
export function tagAccessLine(m: Model) {
  const yes = m.accounts.filter((a) => m.tags.access[a.id]?.write);
  return { yes: yes.length, of: m.accounts.length, names: yes.map((a) => a.name) };
}
