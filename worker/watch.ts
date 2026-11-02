/**
 * The old alert check (`WATCH`, #83): a Durable Object whose alarm read every account every 15
 * minutes to email limit changes. The watchdog (worker/watchdog.ts) now sends limit alerts on its
 * own 5 minute step, so this one only clears its alarm when it wakes. The class stays: Durable
 * Object classes are never removed while a binding or a migration names them.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export class Watch extends DurableObject<Env> {
  /** Stops the old 15 minute check for good. */
  async alarm() {
    await this.ctx.storage.deleteAlarm();
  }
}
