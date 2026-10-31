/**
 * Telemetry from Lumen's ops meters (@columenlabs/lumen-ops): one Analytics Engine point per
 * request (route template, status, ms, time spent waiting on KV and the Cloudflare API) and the
 * same split sent back as `Server-Timing`. With no dataset bound (`METRICS`) nothing is written and
 * Server-Timing still works, so a fork deploys without it.
 */
import {
  foldRoute,
  meteredBindings,
  meterFetch,
  type PointSink,
  setEventSink,
  setRequestSink,
} from '@columenlabs/lumen-ops';
import { requestMeter } from '@columenlabs/lumen-ops/hono';
import type { Context } from 'hono';

export interface TelemetryEnv {
  /** Analytics Engine dataset for request points; unset = points are not written. */
  METRICS?: PointSink;
}

let wired = false;

/** Points the meters at the dataset and patches fetch, once per isolate. */
export function wireTelemetry(env: TelemetryEnv): void {
  if (wired) return;
  wired = true;
  setRequestSink(env.METRICS);
  setEventSink(env.METRICS, { app: 'usageflare', env: 'production' });
  meterFetch();
}

/** The env the app sees: its bindings timed. */
export const metered = <E extends object>(env: E): E =>
  meteredBindings(env, { kinds: { KV: 'kv', ASSETS: 'assets' }, skip: ['METRICS', 'WATCHDOG', 'MAIL'] });

/**
 * The request meter: first, so every route is metered; hashed files are one route. A `?fresh`
 * read is the page's background revalidation (it already shows the cached copy), so it is its own
 * surface, `refresh`, and its provider wait never counts as what a person waits for.
 */
export const usageRequestMeter = () =>
  requestMeter({
    app: 'usageflare',
    route: (c: Context) => {
      const p = new URL(c.req.url).pathname;
      return p.startsWith('/assets/') ? '/assets/*' : foldRoute(p);
    },
    serverTiming: true,
    describe: (c: Context) => ({
      surface: surfaceOf(new URL(c.req.url)),
      callerKind: c.req.header('cf-access-client-id')
        ? 'service'
        : c.req.header('cf-access-jwt-assertion')
          ? 'session'
          : 'anon',
    }),
  });

const surfaceOf = (u: URL) =>
  !u.pathname.startsWith('/api/') ? 'site' : u.searchParams.has('fresh') ? 'refresh' : 'api';
