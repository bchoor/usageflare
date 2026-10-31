/**
 * Sanity entry: wraps the built Worker (./index.js in dist/usageflare) for a local run only. It
 * counts what every request costs and sends it back as `x-sanity` JSON. Never deployed: only
 * e2e/sanity/run.ts copies it next to the build and boots it.
 *
 * What it counts, with no list of meters to keep up:
 * - every call on every env binding, as `bind.<BINDING>.<method>` (KV get/put/list/delete, ASSETS
 *   fetch, …), so a binding added later counts by itself;
 * - KV bytes written (`kvBytesWritten`), since the free plan caps KV writes;
 * - the Worker's own invocations (`inv.worker.fetch`, `inv.worker.scheduled`);
 * - calls out to the network (`out.<host>`), all refused: a sanity run never reaches Cloudflare.
 */
// @ts-nocheck
// biome-ignore-all lint/suspicious/noExplicitAny: it wraps whatever bindings the Worker has
import real from './index.js';

// The Worker's Durable Object classes (the alert check), so its bindings resolve.
export * from './index.js';

const t: Record<string, number> = { outboundCalls: 0, kvBytesWritten: 0 };
// Always in a probe's numbers; every other key only when it moved.
const BASE = new Set(Object.keys(t));
const bump = (k: string, n = 1) => {
  t[k] = (t[k] ?? 0) + n;
};

globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  bump('outboundCalls');
  bump(`out.${url.hostname}`);
  return new Response('no network in a sanity run', { status: 503 });
};

const SKIP = new Set(['then', 'constructor', 'toJSON', 'toString', 'valueOf']);
const size = (v: unknown) =>
  typeof v === 'string'
    ? v.length
    : v instanceof ArrayBuffer
      ? v.byteLength
      : ArrayBuffer.isView(v)
        ? v.byteLength
        : 0;
function counted(target: any, name: string): any {
  return new Proxy(target, {
    get(o, k) {
      const v = Reflect.get(o, k);
      if (typeof k === 'symbol' || SKIP.has(k) || typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        bump(`bind.${name}.${k}`);
        if (k === 'put') bump('kvBytesWritten', size(a[1]));
        return v.apply(o, a);
      };
    },
  });
}

const envs = new WeakMap<object, object>();
function wrapEnv(env: any) {
  const hit = envs.get(env);
  if (hit) return hit;
  const out: any = { ...env };
  for (const [k, v] of Object.entries(env)) if (v && typeof v === 'object') out[k] = counted(v, k);
  envs.set(env, out);
  return out;
}

export default {
  async fetch(req: Request, env: any, ctx: ExecutionContext) {
    if (new URL(req.url).pathname === '/__sanity/counters') return Response.json({ ...t });
    // waitUntil work (a cache write after the reply) counts on the request that started it.
    const pending: Promise<unknown>[] = [];
    const ctx2 = {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
        ctx.waitUntil(p);
      },
      passThroughOnException: () => ctx.passThroughOnException(),
      props: ctx.props,
    };
    const before = { ...t };
    bump('inv.worker.fetch');
    const res = await real.fetch(req, wrapEnv(env), ctx2);
    const body = await res.arrayBuffer();
    await Promise.allSettled(pending);
    const delta: Record<string, number> = {};
    for (const k of Object.keys(t)) {
      const d = t[k] - (before[k] ?? 0);
      if (d || BASE.has(k)) delta[k] = d;
    }
    const out = new Response([101, 204, 205, 304].includes(res.status) ? null : body, res);
    out.headers.set('x-sanity', JSON.stringify(delta));
    return out;
  },
  scheduled(e: any, env: any, ctx: any) {
    bump('inv.worker.scheduled');
    return real.scheduled?.(e, wrapEnv(env), ctx);
  },
};
