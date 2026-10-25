import { listReleases, RELEASES_HEADERS, type Release } from '@columenlabs/lumen-ship/releases';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { requireAccess, sameOrigin } from './access';
import changelog from './changelog.json';
import type { AppEnv } from './env';
import { deleteSecret, hasSecret, listSecrets, putSecret, testSecret } from './secrets';

const name = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) });
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
    return c.json({ secret: await putSecret(c.env, name, c.req.valid('json'), c.get('email')) });
  })
  .post('/secrets/:name/test', zValidator('param', name), async (c) => {
    const secret = await testSecret(c.env, c.req.valid('param').name);
    return secret ? c.json({ secret }) : c.json({ error: 'Not found' }, 404);
  })
  .delete('/secrets/:name', zValidator('param', name), async (c) => {
    await deleteSecret(c.env, c.req.valid('param').name);
    return c.body(null, 204);
  })
  .onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

const app = new Hono<AppEnv>().route('/api', api).all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

export type Api = typeof api;
export default app;
