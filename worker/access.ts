import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import type { AppEnv } from './env';

type KeySet = ReturnType<typeof createRemoteJWKSet>;
/** Per issuer: Access's keys read through the edge cache, and read straight from Access. */
const jwks = new Map<string, { cached: KeySet; direct: KeySet }>();

const keySets = (issuer: string) => {
  let sets = jwks.get(issuer);
  if (!sets) {
    const url = new URL(`${issuer}/cdn-cgi/access/certs`);
    sets = {
      // A new isolate reads the keys from the edge cache instead of across the network each time.
      cached: createRemoteJWKSet(url, {
        [customFetch]: (u: string, init: RequestInit) =>
          fetch(u, { ...init, cf: { cacheTtl: 300, cacheEverything: true } }),
      }),
      direct: createRemoteJWKSet(url),
    };
    jwks.set(issuer, sets);
  }
  return sets;
};

/** The email a service token acts as: SERVICE_IDENTITIES lists `clientId=email` pairs, comma-separated. */
const serviceTokenEmail = (raw: string | undefined, clientId: unknown) => {
  if (typeof clientId !== 'string' || !clientId) return '';
  for (const pair of (raw ?? '').split(',')) {
    const [id, email] = pair.split('=').map((x) => x.trim().toLowerCase());
    if (id && id === clientId.toLowerCase() && email?.includes('@')) return email;
  }
  return '';
};

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
  const keys = keySets(issuer);
  try {
    const opts = { issuer, audience: aud };
    // Signed with a key newer than the cached copy (Access rotated): ask Access itself.
    const { payload } = await jwtVerify(token, keys.cached, opts).catch((e) =>
      e instanceof errors.JWKSNoMatchingKey ? jwtVerify(token, keys.direct, opts) : Promise.reject(e),
    );
    // A service token has no email; one listed in SERVICE_IDENTITIES acts as the person it names.
    const email =
      typeof payload.email === 'string' && payload.email
        ? payload.email
        : serviceTokenEmail(c.env.SERVICE_IDENTITIES, payload.common_name);
    c.set('email', email);
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
