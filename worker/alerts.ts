/**
 * The old Settings ▸ Alerts (limit-status emails, #83), kept only so the watchdog can copy it once
 * into its own settings (worker/watchdog.ts `merge`). Alerts now run in the watchdog: one check,
 * one set of channels. The KV record `alerts:v1` is left as it is, so an older build rolled back
 * to still finds its settings.
 *
 * KV: `alerts:v1` → AlertsDoc. The webhook address is sealed under SETTINGS_KEY (worker/secrets.ts).
 */
import type { Env } from './env';
import { type Sealed, unseal } from './secrets';

/** The lowest limit status that sends: Watch, Will exceed or Over. */
export type AlertLevel = 'watch' | 'soon' | 'over';

interface AlertsDoc {
  v: 1;
  on: boolean;
  level: AlertLevel;
  email: { url: string; from: string; to: string; key: Sealed; last4: string } | null;
  webhook: { url: Sealed; hint: string } | null;
}

const KEY = 'alerts:v1';
const HOOK_AAD = 'alerts:webhook';

/** What the old Alerts had, ready to copy: the webhook address unsealed. Null when never set. */
export async function oldAlerts(env: Env): Promise<{
  on: boolean;
  level: AlertLevel;
  emailTo: string | null;
  webhook: string | null;
} | null> {
  const d = await env.KV.get<AlertsDoc>(KEY, 'json');
  if (!d) return null;
  const webhook = d.webhook ? await unseal(env, HOOK_AAD, d.webhook.url).catch(() => null) : null;
  return {
    on: !!d.on,
    level: d.level === 'watch' || d.level === 'over' ? d.level : 'soon',
    emailTo: d.email?.to ?? null,
    webhook,
  };
}
