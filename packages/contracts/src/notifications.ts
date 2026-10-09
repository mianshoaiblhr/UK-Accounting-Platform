import { z } from 'zod';

/**
 * Notification channels (V0 specification section 7, ADR-38). A channel exists only if declared here, so a typo can never create one.
 * `in_app` and `email` are implemented; `sms` and `whatsapp` are documented stubs that cannot be enabled (no provider, no consent or
 * number-verification model yet) - a later version implements them behind the same `NotificationChannel` port.
 */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'sms', 'whatsapp'] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];
export const IMPLEMENTED_NOTIFICATION_CHANNELS: readonly NotificationChannelId[] = ['in_app', 'email'];
/** Channels a user cannot switch off: a user must always be able to see what needs their attention in the product. */
export const MANDATORY_NOTIFICATION_CHANNELS: readonly NotificationChannelId[] = ['in_app'];

/** Preference granularity: the part of the notification type before the first dot (`task.assigned` -> `task`). Unknown prefixes are `system`. */
export const NOTIFICATION_CATEGORIES = ['task', 'workflow', 'system'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const notificationCategoryOf = (type: string): NotificationCategory => {
  const head = type.split('.')[0] ?? '';
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(head) ? (head as NotificationCategory) : 'system';
};

export const setNotificationPreferenceSchema = z.object({
  channel: z.enum(NOTIFICATION_CHANNELS), category: z.enum(NOTIFICATION_CATEGORIES), enabled: z.boolean(),
}).strict();

/** "in_app,email" -> validated list. Unknown or not-yet-implemented channels are configuration errors (fail fast at boot). */
export function parseNotificationChannels(raw: string | undefined): NotificationChannelId[] {
  const out: NotificationChannelId[] = [];
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(part)) throw new Error(`Invalid NOTIFICATION_CHANNELS: unknown channel "${part}"`);
    if (!IMPLEMENTED_NOTIFICATION_CHANNELS.includes(part as NotificationChannelId)) throw new Error(`Invalid NOTIFICATION_CHANNELS: channel "${part}" is not implemented yet (documented stub)`);
    if (!out.includes(part as NotificationChannelId)) out.push(part as NotificationChannelId);
  }
  if (!out.includes('in_app')) out.unshift('in_app'); // the in-app channel is mandatory
  return out;
}
