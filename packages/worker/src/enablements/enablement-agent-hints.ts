/**
 * Agent-directed wording when a trigger is armed but not turned on for a
 * person. Creating a scheduled job auto-enables it for the owner; other
 * package triggers never auto-enable on publish — agents must ask the user,
 * then call enablementEnable (or Approve for webhooks/email).
 */

import type { EnablementTriggerKind } from './types.ts'

export type EnablementHintReason = 'missing' | 'paused'

export type EnablementHintPackageRef =
	| { packageId: string; kodyId?: string | null }
	| { packageId?: undefined; kodyId: string }

export type EnablementHintTrigger = {
	kind: EnablementTriggerKind
	name: string
	reason: EnablementHintReason
}

const emailSubscriptionTopics = new Set([
	'email.message.received',
	'email.message.quarantined',
])

export function isEmailSubscriptionTopic(topic: string) {
	return emailSubscriptionTopics.has(topic)
}

export function formatEnablementEnableCall(
	input: EnablementHintPackageRef & {
		triggerKind: Exclude<EnablementTriggerKind, 'webhook'>
		triggerName: string
	},
): string {
	const idPart =
		input.packageId != null && input.packageId !== ''
			? `packageId: ${JSON.stringify(input.packageId)}`
			: `kodyId: ${JSON.stringify(input.kodyId)}`
	return `enablementEnable({ ${idPart}, triggerKind: ${JSON.stringify(input.triggerKind)}, triggerName: ${JSON.stringify(input.triggerName)} })`
}

function triggerLabel(kind: EnablementTriggerKind, name: string) {
	return `${kind} "${name}"`
}

/**
 * One-trigger agent hint used on jobGet / jobList / jobUpdate and skip errors.
 * Cron jobs the owner created are auto-enabled on create — do not ask the user
 * about those. Other triggers still need an explicit ask + enablementEnable /
 * Approve.
 */
export function buildSingleTriggerEnablementHint(
	input: EnablementHintPackageRef & {
		triggerKind: EnablementTriggerKind
		triggerName: string
		reason: EnablementHintReason
	},
): string {
	const label = triggerLabel(input.triggerKind, input.triggerName)
	if (input.triggerKind === 'webhook') {
		return input.reason === 'paused'
			? `Ask the user to fix the paused enablement for ${label}. Webhook turn-on is Approve, not enablementEnable.`
			: `Ask the user whether to turn on ${label} for them. Webhooks need Approve (enablementEnable cannot turn a webhook on the first time).`
	}
	// Cron before email-topic name matching: a job can reuse an email topic
	// string as its cron name and still needs cron enablementEnable guidance.
	if (input.triggerKind === 'cron') {
		const call = formatEnablementEnableCall({
			...input,
			triggerKind: 'cron',
		})
		if (input.reason === 'paused') {
			return `Ask the user to fix the paused enablement for ${label}, or re-enable with ${call}.`
		}
		return `Call ${call} to turn on ${label} for the owner. Creating a job enables it for the owner automatically; other package triggers still need an explicit enable.`
	}
	if (isEmailSubscriptionTopic(input.triggerName)) {
		return input.reason === 'paused'
			? `Ask the user to fix the paused enablement for ${label}. Inbound email turn-on is Approve from the inbox, not enablementEnable.`
			: `Ask the user whether to turn on ${label} for them. Inbound email needs Approve from the inbox (enablementEnable cannot turn it on).`
	}
	const call = formatEnablementEnableCall({
		...input,
		triggerKind: input.triggerKind,
	})
	if (input.reason === 'paused') {
		return `Ask the user to fix the paused enablement for ${label}, or re-enable with ${call}.`
	}
	return `Ask the user whether to enable ${label} for them: ${call}. Publishing never turns a trigger on.`
}

/**
 * Multi-trigger agent hint for publish `test_hints` / follow-up.
 */
export function buildMultiTriggerEnablementHint(
	input: EnablementHintPackageRef & {
		triggers: Array<EnablementHintTrigger>
	},
): string | null {
	if (input.triggers.length === 0) return null
	const lines = input.triggers.map((trigger) => {
		const label = triggerLabel(trigger.kind, trigger.name)
		if (trigger.kind === 'webhook') {
			return trigger.reason === 'paused'
				? `- ${label} (paused): ask the user to fix the pause; turn-on is Approve, not enablementEnable.`
				: `- ${label}: ask the user whether to Approve it (enablementEnable cannot turn a webhook on the first time).`
		}
		if (trigger.kind === 'cron') {
			const call = formatEnablementEnableCall({
				...input,
				triggerKind: 'cron',
				triggerName: trigger.name,
			})
			return trigger.reason === 'paused'
				? `- ${label} (paused): ask the user to fix the pause, or re-enable with ${call}.`
				: `- ${label}: call ${call} to turn it on for the owner (creating a job enables the owner automatically).`
		}
		if (isEmailSubscriptionTopic(trigger.name)) {
			return trigger.reason === 'paused'
				? `- ${label} (paused): ask the user to fix the pause; turn-on is Approve from the inbox.`
				: `- ${label}: ask the user whether to Approve it from the inbox (enablementEnable cannot turn it on).`
		}
		const call = formatEnablementEnableCall({
			...input,
			triggerKind: trigger.kind,
			triggerName: trigger.name,
		})
		return trigger.reason === 'paused'
			? `- ${label} (paused): ask the user to fix the pause, or re-enable with ${call}.`
			: `- ${label}: ask the user whether to enable it with ${call}.`
	})
	return [
		'Enable missing triggers as follows (publishing does not auto-enable webhooks or subscriptions; new package jobs enable for the owner on create):',
		...lines,
	].join('\n')
}

/**
 * Scheduled-tick skip error; same enablementEnable guidance as jobGet hints.
 */
export function buildNoEnablementSkipError(
	input: EnablementHintPackageRef & {
		jobName: string
		reason: EnablementHintReason
	},
): string {
	const hint = buildSingleTriggerEnablementHint({
		...input,
		triggerKind: 'cron',
		triggerName: input.jobName,
		reason: input.reason,
	})
	if (input.reason === 'paused') {
		return `Scheduled tick skipped: every enablement for cron "${input.jobName}" is paused. ${hint}`
	}
	return `Scheduled tick skipped: no on enablement for cron "${input.jobName}". ${hint}`
}
