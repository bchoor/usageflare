import { listReleases, RELEASES_HEADERS, type Release } from '@columenlabs/lumen-ship/releases';
import { customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import { zValidator as zv } from '@hono/zod-validator';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { requireAccess, sameOrigin } from './access';
import changelog from './changelog.json';
import { historyDates } from './cloudflare';
import type { AppEnv } from './env';
import { FIXTURE_LABELS, fixtureRefs, fixturesOn, fixtureUsage } from './fixtures';
import { deleteSecret, hasSecret, listSecrets, putSecret, testSecret } from './secrets';
import {
  accountRefs,
  accountUsage,
  deleteView,
  getLabels,
  getPrefs,
  getView,
  putLabels,
  putPrefs,
  putView,
} from './usage';

/** Validation failures answer `{error: string}`, the shape the client shows. */
const zValidator = <T extends z.ZodType, Target extends 'json' | 'param' | 'query'>(
  target: Target,
  schema: T,
) =>
  zv(target, schema, (r, c) => {
    if (!r.success) {
      const issues = r.error.issues.map((i) =>
        i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
      );
      return c.json({ error: `Invalid request: ${issues.join('; ')}` }, 400);
    }
  });

const name = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) });
const accountParam = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) });
const labelName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/);
const labelsBody = z.object({
  labels: z
    .array(
      z.object({ name: labelName, c: z.number().int().min(0).max(99), icon: z.string().max(32).optional() }),
    )
    .max(200),
  assign: z
    .record(z.string().max(300), z.array(labelName).max(50))
    .refine((o) => Object.keys(o).length <= 5000, 'Too many labelled resources'),
});
const viewPage = z.object({
  page: z.enum([
    'overview',
    'account',
    'limits',
    'resources',
    'resources-compute',
    'resources-storage',
    'resources-ai',
    'resources-messaging',
  ]),
});
const prefsBody = z.object({
  warn: z.number().int().min(50).max(95),
  plans: z
    .record(z.string().regex(/^[a-f0-9]{32}$/), z.enum(['free', 'paid']))
    .refine((o) => Object.keys(o).length <= 200, 'Too many accounts'),
});
const fresh = (q: string | undefined) => q !== undefined;

const secretBody = z.object({
  kind: z.literal('cf_api_token'),
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(8).max(4096),
});

const api = new Hono<AppEnv>()
  .use(secureHeaders(), async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  })
  .use(requireAccess, sameOrigin)
  .get('/health', (c) => c.json({ ok: true }))
  .get('/me', (c) => c.json({ email: c.get('email') }))
  // What's new in the status bar: the Key takeaways lumen-ship commits on each release.
  .get('/releases', (c) =>
    c.json(
      {
        releases: listReleases(changelog as Release[], {
          limit: c.req.query('limit'),
          before: c.req.query('before'),
        }),
      },
      200,
      RELEASES_HEADERS,
    ),
  )
  .get('/secrets', async (c) => c.json({ secrets: await listSecrets(c.env) }))
  .put('/secrets/:name', zValidator('param', name), zValidator('json', secretBody), async (c) => {
    const { name } = c.req.valid('param');
    // `?create` adds a new secret only: a label that slugs to an existing name must not replace it.
    if (c.req.query('create') !== undefined && (await hasSecret(c.env, name))) {
      return c.json({ error: 'A token with that name already exists' }, 409);
    }
    const secret = await putSecret(c.env, name, c.req.valid('json'), c.get('email'));
    await c.env.KV.delete('accounts:v1');
    return c.json({ secret });
  })
  .post('/secrets/:name/test', zValidator('param', name), async (c) => {
    const secret = await testSecret(c.env, c.req.valid('param').name);
    return secret ? c.json({ secret }) : c.json({ error: 'Not found' }, 404);
  })
  .delete('/secrets/:name', zValidator('param', name), async (c) => {
    await deleteSecret(c.env, c.req.valid('param').name);
    await c.env.KV.delete('accounts:v1');
    return c.body(null, 204);
  })
  // Usage: the accounts the tokens reach, then one account at a time (`?fresh` skips the cache).
  .get('/accounts', async (c) =>
    c.json(
      fixturesOn(c.env, c.req.url)
        ? publicRefs(fixtureRefs())
        : await accountRefsPublic(c.env, fresh(c.req.query('fresh'))),
    ),
  )
  .get('/accounts/:id/usage', zValidator('param', accountParam), async (c) => {
    if (fixturesOn(c.env, c.req.url)) {
      const usage = fixtureUsage(c.req.valid('param').id, historyDates());
      return usage ? c.json(usage) : c.json({ error: 'No token reaches that account' }, 404);
    }
    const usage = await accountUsage(c.env, c.req.valid('param').id, fresh(c.req.query('fresh')));
    return usage ? c.json(usage) : c.json({ error: 'No token reaches that account' }, 404);
  })
  .get('/prefs', async (c) => c.json(await getPrefs(c.env)))
  .put('/prefs', zValidator('json', prefsBody), async (c) => {
    await putPrefs(c.env, c.req.valid('json'));
    return c.json(await getPrefs(c.env));
  })
  .get('/labels', async (c) => {
    const labels = await getLabels(c.env);
    return c.json(fixturesOn(c.env, c.req.url) && !labels.labels.length ? FIXTURE_LABELS : labels);
  })
  .put('/labels', zValidator('json', labelsBody), async (c) => {
    await putLabels(c.env, c.req.valid('json'));
    return c.json(await getLabels(c.env));
  })
  // A page's saved layout (LumenLayout's view config): cards, widths, columns, sort and grouping.
  .get('/views/:page', zValidator('param', viewPage), async (c) =>
    c.json({ config: await getView(c.env, c.req.valid('param').page) }),
  )
  .put(
    '/views/:page',
    zValidator('param', viewPage),
    zValidator('json', customViewConfigSchema.extend({ name: z.string().trim().min(1).max(80) })),
    async (c) => {
      await putView(c.env, c.req.valid('param').page, c.req.valid('json'));
      return c.json({ config: c.req.valid('json') });
    },
  )
  .delete('/views/:page', zValidator('param', viewPage), async (c) => {
    await deleteView(c.env, c.req.valid('param').page);
    return c.body(null, 204);
  })
  .onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

/** Account refs without the token's KV name: the UI only needs the label it's read with. */
async function accountRefsPublic(env: AppEnv['Bindings'], fresh: boolean) {
  return publicRefs(await accountRefs(env, fresh));
}

function publicRefs({ accounts, errors }: Awaited<ReturnType<typeof accountRefs>>) {
  return {
    accounts: accounts.map(({ id, name, tokenLabel }) => ({ id, name, tokenLabel })),
    errors: errors.map(({ label, error }) => ({ label, error })),
  };
}

const app = new Hono<AppEnv>().route('/api', api).all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

export type Api = typeof api;
export default app;
