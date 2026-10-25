import './index.css';
import { configureLumen, createDeskQueryClient, LumenShell, NavGroup, Page } from '@columenlabs/lumen-ui';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { Gauge, KeyRound } from 'lucide-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { TokensSettings } from './settings';

configureLumen({ prefsCookie: 'usageflare_prefs' });
const queryClient = createDeskQueryClient();

function Shell() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  return (
    <LumenShell
      app="usageflare"
      appLabel="usageflare"
      brand={<span className="font-semibold">usageflare</span>}
      nav={<NavGroup items={[{ title: 'Usage', to: '/', icon: Gauge, exact: true }]} />}
      releases="/api/releases"
      user={me.data ? { email: me.data.email, name: null } : null}
      settings={[
        {
          id: 'tokens',
          title: 'Cloudflare API tokens',
          icon: KeyRound,
          content: <TokensSettings />,
        },
      ]}
      onRefresh={() => queryClient.invalidateQueries()}
    >
      <Outlet />
    </LumenShell>
  );
}

function Home() {
  return (
    <Page crumbs={[{ label: 'Usage' }]}>
      <p className="text-muted-foreground text-sm">Usage across your Cloudflare accounts will show here.</p>
    </Page>
  );
}

const root = createRootRoute({ component: Shell });
const router = createRouter({
  routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: '/', component: Home })]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
