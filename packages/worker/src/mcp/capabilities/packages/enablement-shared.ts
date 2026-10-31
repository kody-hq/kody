import { z } from 'zod'
import {
	enablementTriggerKinds,
	type EnablementRecord,
} from '#worker/enablements/types.ts'

export const enablementTriggerKindSchema = z
	.enum(enablementTriggerKinds)
	.describe(
		'cron (a package.json#kody.jobs entry), subscription (a package.json#kody.subscriptions topic, inbound email included), or webhook (a minted package.json#kody.webhooks entry).',
	)

export const enablementSchema = z.object({
	id: z.string(),
	package_id: z.string().nullable(),
	trigger_kind: enablementTriggerKindSchema,
	trigger_name: z
		.string()
		.describe('Job name, subscription topic, or webhook name.'),
	enabler_user_id: z
		.string()
		.describe('The person every run acts as, and who is billed.'),
	state: z
		.enum(['on', 'paused', 'off'])
		.describe(
			'paused: the enabler lost access; events are dropped until access is back, then it resumes by itself.',
		),
	paused_reason: z
		.enum([
			'org_access',
			'package_access',
			'credential_access',
			'profile_inactive',
		])
		.nullable(),
	paused_permission: z.string().nullable(),
	paused_resource: z.object({ type: z.string(), id: z.string() }).nullable(),
	origin: z.enum(['enabled', 'migrated']),
	enabled_at: z.string(),
	disabled_at: z.string().nullable(),
})

export function toEnablementOutput(
	record: EnablementRecord,
): z.infer<typeof enablementSchema> {
	const pause = record.pause
	return {
		id: record.id,
		package_id: record.packageId,
		trigger_kind: record.triggerKind,
		trigger_name: record.triggerName,
		enabler_user_id: String(record.enablerUserId),
		state: record.state,
		paused_reason: pause?.reason ?? null,
		paused_permission: pause?.permission ?? null,
		paused_resource:
			pause?.resourceType && pause.resourceId
				? { type: pause.resourceType, id: pause.resourceId }
				: null,
		origin: record.origin,
		enabled_at: record.enabledAt,
		disabled_at: record.disabledAt,
	}
}
