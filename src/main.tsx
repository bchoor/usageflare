import './index.css';
import {
  configureLumen,
  createDeskQueryClient,
  iconOf,
  type LumenFinderRow,
  LumenSelector,
  LumenShell,
  NavGroup,
  type SectionItem,
  SettingRow,
  SidebarSection,
  StatusItem,
  useLumenFinderRows,
} from '@columenlabs/lumen-ui';
import { Slider } from '@columenlabs/lumen-ui/ui/slider';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { useQuery } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { Bell, Building2, Gauge, KeyRound, LayoutDashboard, Plus, Rows3, Tag } from 'lucide-react';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { CATEGORIES, type CategoryId, PRODUCTS, type ProductId } from '../shared/catalog';
import { api } from './api';
import { planText } from './meters';
import {
  type Model,
  SEVERITY,
  skipCacheOnce,
  tagColor,
  tagNames,
  useModel,
  useRefreshing,
  useSavePrefs,
  useSaveTags,
} from './model';
import { AccountLimitsPage, AccountPage, OverviewPage, ResourcesPage, TagsPage } from './pages';
import { PRODUCT_ICON } from './products';
import { TokensSettings } from './settings';
import { registerTagSaver, TagForm } from './tags';

configureLumen({ prefsCookie: 'usageflare_prefs' });
const queryClient = createDeskQueryClient();

// The last data this browser saw is kept in localStorage, so a page opened again draws it at once
// and reads the Worker behind it (stale while revalidate). Only the very first visit waits.
const DAY = 86_400_000;
const KEPT = ['accounts', 'usage', 'prefs', 'tags'];
for (const k of KEPT) queryClient.setQueryDefaults([k], { gcTime: DAY });
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
})();
const persister = createSyncStoragePersister({ storage, key: 'usageflare:cache' });
const persistOptions = {
  persister,
  maxAge: DAY,
  // Bump when the usage reply changes shape, so an old copy is dropped instead of drawn.
  buster: 'v1',
  dehydrateOptions: {
    shouldDehydrateQuery: (q: { queryKey: readonly unknown[]; state: { status: string } }) =>
      q.state.status === 'success' && KEPT.includes(String(q.queryKey[0])),
  },
};

/** `just now`, `4 min ago`, `2 h ago`: how old the numbers on screen are, ticking each 30 s. */
function useAgo(iso: string | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return null;
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/** The brand: "usage" in the foreground, "flare" in the app accent. */
function Brand({ n }: { n: number }) {
  return (
    <span className="flex items-center gap-2">
      <img src="/brand/usageflare-mark.svg" alt="" className="size-8 rounded-lg" />
      <span className="flex flex-col leading-tight">
        <b className="font-semibold text-sm">
          usage<span className="text-primary">flare</span>
        </b>
        <small className="text-muted-foreground text-xs">
          {n} Cloudflare account{n === 1 ? '' : 's'}
        </small>
      </span>
    </span>
  );
}

function AccountNav({ m }: { m: Model }) {
  return (
    <>
      {m.accounts.map((a) => {
        const us = m.usage.filter((u) => u.a.id === a.id);
        const rs = m.resources.filter((r) => r.acct === a.id && !r.total);
        const tags = m.tags.tags.filter((l) => l.acct === a.id);
        const items: SectionItem[] = [
          { id: 'overview', title: 'Overview', to: `/a/${a.id}`, icon: LayoutDashboard, fixed: true },
          {
            id: 'limits',
            title: 'Limits',
            to: `/a/${a.id}/limits`,
            icon: Gauge,
            badge: us.filter((u) => SEVERITY[u.st] >= 2).length || undefined,
            fixed: true,
          },
          {
            id: 'resources',
            title: 'Resources',
            to: `/a/${a.id}/resources`,
            icon: Rows3,
            badge: rs.filter((r) => !m.archived(r)).length,
            fixed: true,
          },
          {
            id: 'tags',
            title: 'Tags',
            to: `/a/${a.id}/tags`,
            icon: Tag,
            badge: tags.length || undefined,
            fixed: true,
            items: tags.map((l) => ({
              id: l.name,
              title: l.name,
              to: `/a/${a.id}/resources?tag=${encodeURIComponent(l.name)}`,
              icon: l.icon ? iconOf(l.icon, Tag) : undefined,
              color: tagColor(m.tags, l.name, a.id),
              badge: rs.filter((r) => m.tagsOf(r).includes(l.name)).length,
            })),
          },
        ];
        return (
          <SidebarSection
            key={a.id}
            label={`${a.name}${us.length ? ` · ${planText(m.plan(a).share)}` : ''}`}
            items={items}
          >
            <TagForm m={m} acct={a.id}>
              <button
                type="button"
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-muted-foreground text-xs hover:bg-sidebar-accent"
              >
                <Plus className="size-3.5" />
                New tag
              </button>
            </TagForm>
          </SidebarSection>
        );
      })}
    </>
  );
}

/** Settings ▸ Accounts: each account the tokens reach, with its plan (detected or set here). */
function AccountsSettings() {
  const m = useModel();
  const save = useSavePrefs();
  if (!m.accounts.length)
    return <p className="text-muted-foreground text-sm">No accounts yet: add a token first.</p>;
  return (
    <div className="flex flex-col gap-2">
      {m.accounts.map((a) => (
        <SettingRow
          key={a.id}
          label={a.name}
          description={
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-xs">{a.id}</span>
              <span>
                Read with {a.tokenLabel} ·{' '}
                {a.planSource === 'detected'
                  ? 'plan detected from billing'
                  : a.planSource === 'set'
                    ? 'plan set here'
                    : a.planSource === 'inferred'
                      ? 'Paid, judged from usage past Free limits'
                      : 'plan assumed Free (the token has no Billing Read)'}
              </span>
            </span>
          }
        >
          <LumenSelector
            label={`${a.name} plan`}
            size="sm"
            value={m.prefs.plans[a.id] ?? 'auto'}
            options={[
              { value: 'auto', label: 'Detect from Cloudflare' },
              { value: 'free', label: 'Workers Free' },
              { value: 'paid', label: 'Workers Paid' },
            ]}
            onChange={(v) => {
              const plans = { ...m.prefs.plans };
              if (v === 'auto') delete plans[a.id];
              else plans[a.id] = v as 'free' | 'paid';
              save.mutate({ ...m.prefs, plans });
            }}
          />
        </SettingRow>
      ))}
    </div>
  );
}

/** Settings ▸ Limits: the share of an allowance at which a metric shows as Watch. */
function LimitsSettings() {
  const m = useModel();
  const save = useSavePrefs();
  const [warn, setWarn] = useState(m.prefs.warn);
  useEffect(() => setWarn(m.prefs.warn), [m.prefs.warn]);
  return (
    <SettingRow label="Watch at" description="Metrics above this share of their allowance show as Watch.">
      <div className="flex w-56 items-center gap-3">
        <Slider
          min={50}
          max={95}
          step={5}
          value={[warn]}
          onValueChange={([v]) => setWarn(v ?? 75)}
          onValueCommit={([v]) => save.mutate({ ...m.prefs, warn: v ?? 75 })}
          aria-label="Watch at"
        />
        <span className="w-10 text-right font-mono text-sm">{warn}%</span>
      </div>
    </SettingRow>
  );
}

/** ⌘K rows: accounts, tags, products and resources. */
function FinderRows({ m }: { m: Model }) {
  const rows = useMemo<LumenFinderRow[]>(
    () => [
      ...m.accounts.map((a) => ({
        value: `acct:${a.id}`,
        label: a.name,
        group: 'Accounts',
        scope: 'Accounts',
        href: `/a/${a.id}`,
        icon: Building2,
        detail: a.plan === 'paid' ? 'Paid' : 'Free',
      })),
      ...tagNames(m.tags).map((name) => ({
        value: `tag:${name}`,
        label: name,
        group: 'Tags',
        scope: 'Tags',
        href: `/resources?tag=${encodeURIComponent(name)}`,
        icon: Tag,
      })),
      ...PRODUCTS.map((p) => ({
        value: `prod:${p.id}`,
        label: `${p.label} resources`,
        group: 'Products',
        scope: 'Resources',
        href: `/resources?product=${p.id}`,
        icon: PRODUCT_ICON[p.id],
      })),
      ...m.resources
        .filter((r) => !r.total)
        .map((r) => ({
          value: `res:${r.id}`,
          label: r.name,
          group: 'Resources',
          scope: 'Resources',
          href: `/a/${r.acct}/resources?open=${encodeURIComponent(r.id)}`,
          icon: PRODUCT_ICON[r.product],
          detail: `${m.account[r.acct]?.name ?? ''} · ${r.product}`,
        })),
    ],
    [m],
  );
  useLumenFinderRows(rows);
  return null;
}

function Shell() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const m = useModel();
  const saveTags = useSaveTags();
  registerTagSaver((doc, base, push, force) => saveTags.mutateAsync({ doc, base, push, force }));
  const synced = m.accounts.map((a) => a.syncedAt).sort()[0];
  const ago = useAgo(synced);
  const refreshing = useRefreshing();
  const missing = m.accounts.filter((a) => a.missing.length);
  return (
    <LumenShell
      app="usageflare"
      appLabel="usageflare"
      brand={<Brand n={m.accounts.length} />}
      nav={
        <>
          <NavGroup
            items={[
              { title: 'Overview', to: '/', icon: LayoutDashboard, exact: true },
              {
                title: 'All resources',
                to: '/resources',
                icon: Rows3,
                badge: m.resources.filter((r) => !r.total && !m.archived(r)).length || undefined,
              },
              { title: 'Tags', to: '/tags', icon: Tag, badge: tagNames(m.tags).length || undefined },
            ]}
          />
          <AccountNav m={m} />
        </>
      }
      status={
        <>
          <StatusItem label="Cloudflare GraphQL" ok={m.error ? false : m.accounts.length ? true : null} />
          {missing.length > 0 && (
            <StatusItem label="Scopes missing" value={missing.map((a) => a.name).join(', ')} ok={false} />
          )}
          {synced && <StatusItem label="Synced" value={refreshing ? `${ago} · refreshing…` : ago} />}
        </>
      }
      releases="/api/releases"
      user={me.data ? { email: me.data.email, name: null } : null}
      finder={{
        scopes: ['Accounts', 'Tags', 'Resources'],
        placeholder: 'Find an account, tag, resource or setting',
      }}
      settings={[
        { id: 'tokens', title: 'Cloudflare API tokens', icon: KeyRound, content: <TokensSettings /> },
        {
          id: 'accounts',
          title: 'Accounts',
          icon: Building2,
          description: 'Cloudflare accounts usageflare reads usage from.',
          content: <AccountsSettings />,
        },
        {
          id: 'limits',
          title: 'Limits',
          icon: Bell,
          description: 'When a metric counts as at risk.',
          content: <LimitsSettings />,
        },
      ]}
      onRefresh={() => {
        skipCacheOnce();
        return queryClient.invalidateQueries();
      }}
    >
      <FinderRows m={m} />
      <Outlet />
    </LumenShell>
  );
}

const root = createRootRoute({ component: Shell });
const catSearch = z.object({
  cat: z.enum(CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]]).optional(),
});
const resSearch = z
  .object({
    tag: z.coerce.string().optional(),
    // Links from before labels became tags.
    label: z.coerce.string().optional(),
    open: z.coerce.string().optional(),
    product: z.enum(PRODUCTS.map((p) => p.id) as [ProductId, ...ProductId[]]).optional(),
  })
  .transform(({ label, ...s }) => ({ ...s, tag: s.tag ?? label }));

const routes = [
  createRoute({ getParentRoute: () => root, path: '/', component: OverviewPage }),
  // Limits are per account now: an old link lands on the Overview.
  createRoute({
    getParentRoute: () => root,
    path: '/limits',
    beforeLoad: () => {
      throw redirect({ to: '/' });
    },
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/resources',
    validateSearch: resSearch,
    component: function AllResources() {
      const s = resourcesRoute.useSearch();
      return <ResourcesPage key={s.product ?? ''} tag={s.tag} open={s.open} product={s.product} />;
    },
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/a/$acct',
    validateSearch: catSearch,
    component: function Account() {
      const { acct } = accountRoute.useParams();
      const { cat } = accountRoute.useSearch();
      return <AccountPage acct={acct} cat={cat} />;
    },
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/a/$acct/resources',
    validateSearch: resSearch,
    component: function AccountResources() {
      const { acct } = accountResourcesRoute.useParams();
      const s = accountResourcesRoute.useSearch();
      return (
        <ResourcesPage
          key={`${acct}|${s.product ?? ''}`}
          acct={acct}
          tag={s.tag}
          open={s.open}
          product={s.product}
        />
      );
    },
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/a/$acct/limits',
    component: function AccountLimits() {
      const { acct } = accountLimitsRoute.useParams();
      return <AccountLimitsPage key={acct} acct={acct} />;
    },
  }),
  createRoute({ getParentRoute: () => root, path: '/tags', component: () => <TagsPage /> }),
  createRoute({
    getParentRoute: () => root,
    path: '/a/$acct/tags',
    component: function AccountTags() {
      const { acct } = accountTagsRoute.useParams();
      return <TagsPage key={acct} acct={acct} />;
    },
  }),
] as const;
const [, , resourcesRoute, accountRoute, accountResourcesRoute, accountLimitsRoute, , accountTagsRoute] =
  routes;

// The public landing page owns `/`; the app is served under /app (wrangler.jsonc).
const router = createRouter({ routeTree: root.addChildren([...routes]), basepath: '/app' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <RouterProvider router={router} />
      </PersistQueryClientProvider>
    </StrictMode>,
  );
}
