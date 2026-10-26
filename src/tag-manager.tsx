/**
 * The Tags page, for one account or all of them: each account's own tags with how many resources
 * carry them and where they're kept (Cloudflare, usageflare or both), as a kit table. Ticked tags
 * take a bulk bar: edit one (name, colour, icon), merge several into one, or delete them, each in
 * its own account. Tags still kept here for resources Cloudflare can hold move there with one
 * confirmed step.
 */
import { LumenConfirm, LumenSelector, lumenToast, type ViewDomain } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Building2, CloudUpload, Combine, MapPin, Palette, Rows3, Tag, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { acctOf, CF_TAG_TYPE, PRODUCT, PROJECT_PREFIX, type Resource, type TagsDoc } from '../shared/catalog';
import { type Model, tagKey } from './model';
import { ensureTag, saveTagDoc, TagForm, TagMark, undoTags } from './tags';

export interface TagRow {
  /** `<account>|<name>`: one name in two accounts is two rows. */
  key: string;
  acct: string;
  name: string;
  /** `Project` for usageflare's own tags, `Cloudflare tag` for a `key=value` made elsewhere. */
  kind: 'Project' | 'Cloudflare tag';
  /** Resources that carry it (their own tag, not one shown from a Worker that binds them). */
  ids: string[];
  /** Of those, how many keep it in Cloudflare and how many only here. */
  inCf: number;
  local: number;
  /** Resources Cloudflare can't tag that show it from a Worker that binds them. */
  inherited: number;
}

export const tagKind = (name: string): TagRow['kind'] => (name.includes('=') ? 'Cloudflare tag' : 'Project');

/** One row per tag of `acct`, or of every account. */
export function tagRows(m: Model, acct?: string): TagRow[] {
  const live = m.resources.filter((r) => !r.total);
  return m.tags.tags
    .filter((t) => !acct || t.acct === acct)
    .map((t) => {
      const ids = Object.keys(m.tags.assign).filter(
        (id) => acctOf(id) === t.acct && m.tags.assign[id]?.includes(t.name),
      );
      const local = ids.filter((id) => m.tags.local[id]?.includes(t.name)).length;
      return {
        key: tagKey(t.acct, t.name),
        acct: t.acct,
        name: t.name,
        kind: tagKind(t.name),
        ids,
        inCf: ids.length - local,
        local,
        inherited: live.filter((r) => r.acct === t.acct && m.inherited(r).includes(t.name)).length,
      };
    });
}

const whereOf = (t: TagRow) =>
  t.ids.length === 0 ? 'Unused' : t.local === 0 ? 'Cloudflare' : t.inCf === 0 ? 'usageflare' : 'Both';
const WHERE_NOTE: Record<string, string> = {
  Cloudflare: 'Saved as Cloudflare resource tags',
  usageflare:
    'Kept in usageflare: Cloudflare can’t tag those resources, or its token lacks Account › Tag › Edit',
  Both: 'Some resources keep it in Cloudflare, some only in usageflare',
  Unused: 'On no resource yet',
};

export function tagDomain(m: Model): ViewDomain<TagRow> {
  return {
    id: 'tags',
    rowKey: (t) => t.key,
    text: (t) => [t.name, t.kind, m.account[t.acct]?.name ?? ''],
    fields: [
      {
        key: 'name',
        label: 'Tag',
        icon: Tag,
        format: 'text',
        value: (t) => t.name,
        render: (t) => <TagMark m={m} name={t.name} acct={t.acct} withName />,
      },
      {
        key: 'account',
        label: 'Account',
        icon: Building2,
        format: 'text',
        value: (t) => m.account[t.acct]?.name ?? t.acct,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
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

/** Deleted, or no longer listed at all: Cloudflare can't tag it. */
const gone = (m: Model, id: string) => !m.resource[id] || m.resource[id].state === 'deleted';

/**
 * Resources whose tags are kept here though Cloudflare could hold them (the account's token can
 * write tags). A deleted one stays: Cloudflare can't tag what no longer exists.
 */
export function movable(m: Model): string[] {
  return Object.keys(m.tags.local).filter((id) => {
    const [acct = '', product] = id.split(':') as [string, Resource['product']];
    return (
      !!m.tags.local[id]?.length && !!CF_TAG_TYPE[product] && !!m.tags.access[acct]?.write && !gone(m, id)
    );
  });
}

/**
 * Of `acct`'s (or every account's) resources with tags kept here, the ones that stay here: products
 * Cloudflare can't tag yet (by product name) and deleted resources.
 */
export function stayHere(m: Model, acct?: string) {
  const ids = Object.keys(m.tags.local).filter(
    (id) => (!acct || acctOf(id) === acct) && !!m.tags.local[id]?.length,
  );
  const untaggable = ids.filter((id) => !CF_TAG_TYPE[id.split(':')[1] as Resource['product']]);
  const products = [
    ...new Set(untaggable.map((id) => PRODUCT[id.split(':')[1] as Resource['product']]?.label ?? '')),
  ].filter(Boolean);
  const deleted = ids.filter((id) => !untaggable.includes(id) && gone(m, id));
  return { untaggable: untaggable.length, products, deleted: deleted.length };
}

/** The tile's short form: `6 not taggable yet · 13 deleted`, or null when none stay. */
export function stayShort(m: Model, acct?: string) {
  const s = stayHere(m, acct);
  const parts = [
    s.untaggable && `${s.untaggable} not taggable yet`,
    s.deleted && `${s.deleted} deleted`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** One line on the tags that stay in usageflare and why, or null when none do. */
export function stayLine(m: Model, acct?: string) {
  const s = stayHere(m, acct);
  const parts = [
    s.untaggable && `${s.untaggable} Cloudflare can't tag yet (${s.products.join(', ')})`,
    s.deleted && `${s.deleted} deleted`,
  ].filter(Boolean);
  return parts.length ? `Stay in usageflare: ${parts.join(' · ')}` : null;
}

/** Resources of `acct` (or any account) whose tags Cloudflare could hold once its token can write tags. */
const waiting = (m: Model, acct?: string) =>
  Object.keys(m.tags.local).filter((id) => {
    const [a = '', product] = id.split(':') as [string, Resource['product']];
    return (
      (!acct || a === acct) &&
      !!m.tags.local[id]?.length &&
      !!CF_TAG_TYPE[product] &&
      !m.tags.access[a]?.write &&
      !gone(m, id)
    );
  });

/**
 * Moves tags kept here to Cloudflare, after a preview of how many per account. Until the account's token
 * can write tags it shows greyed out, saying what to add.
 */
export function MoveToCloudflare({ m, acct }: { m: Model; acct?: string }) {
  const ids = movable(m).filter((id) => !acct || acctOf(id) === acct);
  if (!ids.length) {
    const n = waiting(m, acct).length;
    if (!n) return null;
    return (
      <Button
        size="sm"
        variant="outline"
        disabled
        title={`Add Account › Tag › Edit to the account's token (Settings › Cloudflare API tokens) to save these tags in Cloudflare.${stayLine(m, acct) ? ` ${stayLine(m, acct)}.` : ''}`}
      >
        <CloudUpload className="size-4" />
        Move {n} to Cloudflare
      </Button>
    );
  }
  const by = new Map<string, number>();
  for (const id of ids) by.set(id.split(':')[0] ?? '', (by.get(id.split(':')[0] ?? '') ?? 0) + 1);
  const stay = stayLine(m, acct);
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
          {stay && <span className="text-muted-foreground text-xs">{stay}.</span>}
        </span>
      }
      onConfirm={async () => {
        const saved = await saveTagDoc(m, () => {}, true);
        if (saved && !saved.out.failed?.length) lumenToast.success('Tags moved to Cloudflare');
      }}
    >
      <Button
        size="sm"
        variant="outline"
        title={`Writes these resources' tags to Cloudflare.${stay ? ` ${stay}.` : ''}`}
      >
        <CloudUpload className="size-4" />
        Move {ids.length} to Cloudflare
      </Button>
    </LumenConfirm>
  );
}

/**
 * Drops the tags `keys` (`<account>|<name>`) and takes them off their account's resources; `into`
 * keeps those resources under that name, in the same account.
 */
function rewrite(doc: TagsDoc, keys: string[], into?: string) {
  const gone = new Set(keys.filter((k) => !into || k !== tagKey(k.split('|')[0] ?? '', into)));
  doc.tags = doc.tags.filter((t) => !gone.has(tagKey(t.acct, t.name)));
  for (const [id, ns] of Object.entries(doc.assign)) {
    const acct = acctOf(id);
    const hit = ns.some((n) => gone.has(tagKey(acct, n)));
    if (!hit) continue;
    const next = new Set(ns.filter((n) => !gone.has(tagKey(acct, n))));
    if (into) {
      ensureTag(doc, acct, into);
      next.add(into);
    }
    doc.assign[id] = [...next];
  }
}

/** The floating bar while tags are ticked (by `<account>|<name>`): edit one, merge several, delete. */
export function TagBulkBar({
  m,
  keys,
  onSelect,
}: {
  m: Model;
  keys: string[];
  onSelect: (keys: Set<string>) => void;
}) {
  const [into, setInto] = useState<string | null>(null);
  if (!keys.length) return null;
  const rows = tagRows(m).filter((t) => keys.includes(t.key));
  const touched = new Set(rows.flatMap((t) => t.ids)).size;
  const projectKeys = rows.filter((t) => t.kind === 'Project').map((t) => t.key);
  const projects = [...new Set(rows.filter((t) => t.kind === 'Project').map((t) => t.name))];
  const first = rows[0];
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
        <b className="font-mono">{keys.length}</b> selected{' '}
        <span className="text-muted-foreground text-xs">
          on {touched} resource{touched === 1 ? '' : 's'}
        </span>
      </span>
      <span className="h-5 w-px bg-border" />
      {rows.length === 1 && first && (
        <TagForm m={m} acct={first.acct} edit={first.name} onDone={() => onSelect(new Set())}>
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
              title={`Merge ${projectKeys.length} tags into ${into}?`}
              destructive={false}
              action="Merge"
              description={`Every resource with ${projects
                .filter((n) => n !== into)
                .join(', ')} gets ${into} instead, in its own account; those tags are removed.`}
              onConfirm={() =>
                save(
                  (doc) => rewrite(doc, projectKeys, into),
                  `Merged ${projectKeys.length} tags into ${into}`,
                ).then(() => setInto(null))
              }
            >
              <Button size="sm">Merge</Button>
            </LumenConfirm>
          )}
        </>
      )}
      <LumenConfirm
        title={`Delete ${keys.length} tag${keys.length === 1 ? '' : 's'}?`}
        action="Delete"
        description={`They come off ${touched} resource${touched === 1 ? '' : 's'}, in Cloudflare too where they're kept there.`}
        onConfirm={() =>
          save((doc) => rewrite(doc, keys), `Deleted ${keys.length} tag${keys.length === 1 ? '' : 's'}`)
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
