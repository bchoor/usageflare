/** The commit this build is from (vite.config.ts `define`), `dev` outside Workers Builds. */
declare global {
  const __BUILD_SHA__: string;
}

import type { TelemetryEnv } from './telemetry';
import type { Watch } from './watch';
import type { Watchdog } from './watchdog';

/** One alert email, laid out by the hub (its `alertMail` fields), to the hub's owner only. */
export interface MailAlert {
  to: string;
  subject: string;
  brand: { name: string; color: string; mark?: string };
  tag?: string;
  title: string;
  lines?: string[];
  links?: { text: string; href: string }[];
  footer?: { text: string };
}

export interface Env extends TelemetryEnv {
  KV: KVNamespace;
  /** The alert check's Durable Object (worker/watch.ts), one instance named `alerts`. */
  WATCH: DurableObjectNamespace<Watch>;
  /** Static assets: the landing page at `/` and the app shell at `/app/`. */
  ASSETS: Fetcher;
  /** AES-GCM key for secrets kept in KV: 32 random bytes, base64 (a Worker secret). */
  SETTINGS_KEY: string;
  /** Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. */
  ACCESS_AUD: string;
  /** Access service tokens and the person each acts as, `clientId=email` comma-separated (headless page checks). */
  SERVICE_IDENTITIES?: string;
  /** A suite of Lumen apps this deployment joins (all optional): the address its app switcher reads,
   *  and the Lumen prefs cookie and its domain shared across the suite's apps. */
  SUITE_LIST_URL?: string;
  SUITE_PREFS_COOKIE?: string;
  SUITE_PREFS_DOMAIN?: string;
  /** The watchdog (worker/watchdog.ts): one Durable Object whose alarm checks the accounts. */
  WATCHDOG: DurableObjectNamespace<Watchdog>;
  /**
   * The hub's email relay, a service binding to its `MailApi` entrypoint (production only): the
   * watchdog's alert emails go out through it. Unbound, email shows as not set up.
   */
  MAIL?: { alert(m: MailAlert): Promise<{ ok: boolean; detail: string }> };
  /** `1` serves sample accounts on localhost (worker/fixtures.ts); never set in production. */
  FIXTURES?: string;
}

export type AppEnv = { Bindings: Env; Variables: { email: string } };
