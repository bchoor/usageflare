export interface Env {
  KV: KVNamespace;
  /** Static assets: the landing page at `/` and the app shell at `/app/`. */
  ASSETS: Fetcher;
  /** AES-GCM key for secrets kept in KV: 32 random bytes, base64 (a Worker secret). */
  SETTINGS_KEY: string;
  /** Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. */
  ACCESS_AUD: string;
  /** `1` serves sample accounts on localhost (worker/fixtures.ts); never set in production. */
  FIXTURES?: string;
}

export type AppEnv = { Bindings: Env; Variables: { email: string } };
