import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { requireAccess, sameOrigin } from './access';
import type { AppEnv } from './env';
import { deleteSecret, listSecrets, putSecret, testSecret } from './secrets';

const name = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) });
const secretBody = z.object({
  kind: z.literal('cf_api_token'),
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(8).max(4096),
});

const api = new Hono<AppEnv>()
  .use(secureHeaders(), requireAccess, sameOrigin)
  .use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  })
  .get('/health', (c) => c.json({ ok: true }))
  .get('/me', (c) => c.json({ email: c.get('email') }))
  .get('/secrets', async (c) => c.json({ secrets: await listSecrets(c.env) }))
  .put('/secrets/:name', zValidator('param', name), zValidator('json', secretBody), async (c) => {
    const { name } = c.req.valid('param');
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
