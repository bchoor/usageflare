import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv } from './env';

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const isLocal = (url: string) => {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
};

/**
 * Every /api call needs a valid Cloudflare Access JWT. Fails closed: without Access configured the
 * API answers 503, except on localhost (vite dev).
 */
export const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  if (!team || !aud) {
    if (isLocal(c.req.url)) {
      c.set('email', 'dev@localhost');
      return next();
    }
    return c.json({ error: 'Cloudflare Access is not configured' }, 503);
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const issuer = `https://${team}`;
  let keys = jwks.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwks.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: aud });
    c.set('email', typeof payload.email === 'string' ? payload.email : '');
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
};

/** Writes must come from this app's own pages: JSON body and a same-origin `Origin`. */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const origin = c.req.header('Origin');
  if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: 'Bad origin' }, 403);
  return next();
};
