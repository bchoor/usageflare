import { listReleases, RELEASES_HEADERS, type Release } from '@columenlabs/lumen-ship/releases';
import { customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import { zValidator as zv } from '@hono/zod-validator';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { METRIC } from '../shared/catalog';
import { requireAccess, sameOrigin } from './access';
import changelog from './changelog.json';
import { historyDates } from './cloudflare';
import type { AppEnv, Env } from './env';
import { FIXTURE_TAGS, fixtureRefs, fixturesOn, fixtureUsage } from './fixtures';
import { deleteSecret, hasSecret, listSecrets, putSecret, testSecret } from './secrets';
import { forgetTagAccess, getTagsState, saveTags } from './tags';
import {
  accountRefs,
  accountUsage,
  type Defer,
  deleteView,
  getPrefs,
  getView,
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
/**
 * A tag name: a project tag (`billing-v2`) or any Cloudflare tag as `key=value`. Names the Worker
 * read from Cloudflare come back as they are, so only length and line breaks are checked here;
 * Cloudflare checks the key when it's written.
 */
const tagName = z
  .string()
  .min(1)
  .max(1300)
  .regex(/^[^\n]+$/);
const tagsBody = z.object({
  push: z.boolean().optional(),
  /** Resources to try in Cloudflare though it can't take them (no tag type, deleted, refused before). */
  force: z.array(z.string().max(600)).max(50).optional(),
  tags: z
    .array(
      z.object({
        acct: z.string().regex(/^[0-9a-f]{32}$/),
        name: tagName,
        c: z.number().int().min(0).max(9999),
        icon: z.string().max(32).optional(),
      }),
    )
    .max(2000),
  /** resource id → tag names to add and to take off. */
  changes: z
    .record(
      z.string().max(300),
      z.object({ add: z.array(tagName).max(100), remove: z.array(tagName).max(100) }),
    )
    .refine((o) => Object.keys(o).length <= 5000, 'Too many resources'),
});
const viewPage = z.object({
  page: z.enum([
    'overview',
    'account',
    // The Overview pages since Usage + Watch for: fresh defaults, older saved layouts left behind.
    'overview-usage',
    'account-usage',
    'limits',
    'account-limits',
    'resources',
    // The All tab since Usage + Watch for (v17): a fresh default, older saved columns left behind.
    'resources-all',
    'resources-compute',
    'resources-storage',
    'resources-ai',
    'resources-messaging',
    'tags',
    'account-tags',
  ]),
});
const prefsBody = z.object({
  warn: z.number().int().min(50).max(95),
  plans: z
    .record(z.string().regex(/^[a-f0-9]{32}$/), z.enum(['free', 'paid']))
    .refine((o) => Object.keys(o).length <= 200, 'Too many accounts'),
  meterIcons: z
    .record(
      z.string().refine((k) => Object.hasOwn(METRIC, k), 'Unknown meter'),
      z.string().trim().min(1).max(64),
    )
    .optional(),
});
const fresh = (q: string | undefined) => q !== undefined;

const secretBody = z.object({
  kind: z.enum(['cf_api_token', 'cf_tags_token']),
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(8).max(4096),
});

/** The suite this deployment joins, from its variables; undefined when none is set. */
function suiteOf(env: Env) {
  const suite = {
    list: env.SUITE_LIST_URL || undefined,
    prefsCookie: env.SUITE_PREFS_COOKIE || undefined,
    prefsDomain: env.SUITE_PREFS_DOMAIN || undefined,
  };
  return suite.list || suite.prefsCookie ? suite : undefined;
}

const api = new Hono<AppEnv>()
  .use(secureHeaders(), async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  })
  .use(requireAccess, sameOrigin)
  .get('/health', (c) => c.json({ ok: true }))
  .get('/me', (c) => c.json({ email: c.get('email'), suite: suiteOf(c.env) }))
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
    await Promise.all([c.env.KV.delete('accounts:v1'), forgetTagAccess(c.env)]);
    return c.json({ secret });
  })
  .post('/secrets/:name/test', zValidator('param', name), async (c) => {
    const secret = await testSecret(c.env, c.req.valid('param').name);
    // A test can find Tag access the token didn't have before: probe it again on the next read.
    await forgetTagAccess(c.env);
    return secret ? c.json({ secret }) : c.json({ error: 'Not found' }, 404);
  })
  .delete('/secrets/:name', zValidator('param', name), async (c) => {
    await deleteSecret(c.env, c.req.valid('param').name);
    await Promise.all([c.env.KV.delete('accounts:v1'), forgetTagAccess(c.env)]);
    return c.body(null, 204);
  })
  // Usage: the accounts the tokens reach, then one account at a time (`?fresh` skips the cache).
  .get('/accounts', async (c) =>
    c.json(
      fixturesOn(c.env, c.req.url)
        ? publicRefs(fixtureRefs())
        : await accountRefsPublic(c.env, fresh(c.req.query('fresh')), (w) => c.executionCtx.waitUntil(w)),
    ),
  )
  .get('/accounts/:id/usage', zValidator('param', accountParam), async (c) => {
    if (fixturesOn(c.env, c.req.url)) {
      const usage = fixtureUsage(c.req.valid('param').id, historyDates());
      return usage ? c.json(usage) : c.json({ error: 'No token reaches that account' }, 404);
    }
    const usage = await accountUsage(c.env, c.req.valid('param').id, fresh(c.req.query('fresh')), (w) =>
      c.executionCtx.waitUntil(w),
    );
    return usage ? c.json(usage) : c.json({ error: 'No token reaches that account' }, 404);
  })
  .get('/prefs', async (c) => c.json(await getPrefs(c.env)))
  .put('/prefs', zValidator('json', prefsBody), async (c) => {
    await putPrefs(c.env, c.req.valid('json'));
    return c.json(await getPrefs(c.env));
  })
  // Tags: Cloudflare's where a token with Account › Tag reaches the account, else kept here (`?fresh` re-reads).
  .get('/tags', async (c) => {
    const tags = await getTagsState(c.env, fresh(c.req.query('fresh')));
    return c.json(fixturesOn(c.env, c.req.url) && !tags.tags.length ? FIXTURE_TAGS : tags);
  })
  .put('/tags', zValidator('json', tagsBody), async (c) => {
    const { push, force, tags, changes } = c.req.valid('json');
    return c.json(await saveTags(c.env, tags, changes, !!push, force));
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
async function accountRefsPublic(env: AppEnv['Bindings'], fresh: boolean, defer: Defer) {
  return publicRefs(await accountRefs(env, fresh, defer));
}

function publicRefs({ accounts, errors }: Awaited<ReturnType<typeof accountRefs>>) {
  return {
    accounts: accounts.map(({ id, name, tokenLabel }) => ({ id, name, tokenLabel })),
    errors: errors.map(({ label, error }) => ({ label, error })),
  };
}

/** The app's client routes live under /app; every one of them gets the same shell. */
const appShell = (req: Request, env: AppEnv['Bindings']) =>
  env.ASSETS.fetch(new Request(new URL('/app/', req.url), req));

const app = new Hono<AppEnv>()
  .route('/api', api)
  .all('/api/*', (c) => c.json({ error: 'Not found' }, 404))
  .get('/app', (c) => appShell(c.req.raw, c.env))
  .get('/app/*', (c) => appShell(c.req.raw, c.env))
  // Bookmarks from before the app moved under /app.
  .get('/limits', (c) => c.redirect(`/app/limits${new URL(c.req.url).search}`, 301))
  .get('/resources', (c) => c.redirect(`/app/resources${new URL(c.req.url).search}`, 301))
  .get('/a/*', (c) => c.redirect(`/app${new URL(c.req.url).pathname}${new URL(c.req.url).search}`, 301));

export type Api = typeof api;
export default app;
