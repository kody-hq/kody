/**
 * The credential approval page (`/@user/kody-id/approve-credentials?<proposal>`)
 * on top of the approval API (docs/contributing/contracts/credential-mappings-api.md):
 * the page payload, how changes group, and the copy each one shows. Nothing
 * here carries a credential value.
 */
import type {
	CredentialApprovalChangeView,
	CredentialApprovalEnableView,
	CredentialApprovalView,
	CredentialMappingTarget,
	CredentialRef,
	CredentialTriggerRef,
} from '#universal/credential-contracts.ts'
import {
	credentialRefLabel,
	describeTrigger,
} from '#universal/package-credentials-page.ts'

/** Not found also covers a viewer without `package:execute`, as the API does. */
export type PackageCredentialApprovalLoaderData =
	| { ok: true; view: CredentialApprovalView }
	| { ok: false; notFound: true }

export type CredentialApprovalGroup = {
	key: string
	title: string
	description: string
	trigger: CredentialTriggerRef | null
	changes: Array<{ index: number; change: CredentialApprovalChangeView }>
}

function groupFor(
	target: CredentialMappingTarget,
): Omit<CredentialApprovalGroup, 'changes'> {
	switch (target.type) {
		case 'default':
			return target.layer === 'org'
				? {
						key: 'default:org',
						title: 'Org defaults',
						description:
							'What everyone in the org uses when they run this package, unless they set their own.',
						trigger: null,
					}
				: {
						key: 'default:mine',
						title: 'Your defaults',
						description: 'What your own runs of this package use.',
						trigger: null,
					}
		case 'trigger':
			return {
				key: `trigger:${JSON.stringify([target.trigger.kind, target.trigger.name])}`,
				title: describeTrigger(target.trigger),
				description: 'What this trigger uses when it runs as you.',
				trigger: target.trigger,
			}
		default: {
			const exhaustive: never = target
			return exhaustive
		}
	}
}

/** Org defaults, then your defaults, then each trigger in the order the proposal names it. */
export function groupApprovalChanges(
	changes: ReadonlyArray<CredentialApprovalChangeView>,
): Array<CredentialApprovalGroup> {
	const groups = new Map<string, CredentialApprovalGroup>()
	changes.forEach((change, index) => {
		const group = groupFor(change.target)
		const existing = groups.get(group.key) ?? { ...group, changes: [] }
		existing.changes.push({ index, change })
		groups.set(group.key, existing)
	})
	const rank = (group: CredentialApprovalGroup) =>
		group.key === 'default:org' ? 0 : group.key === 'default:mine' ? 1 : 2
	return [...groups.values()].sort((a, b) => rank(a) - rank(b))
}

function refsLabel(refs: ReadonlyArray<CredentialRef>) {
	return refs.map(credentialRefLabel).join(', ')
}

/** The stored mapping today: `null` inherits, `[]` is none on purpose. */
export function approvalBeforeLabel(change: CredentialApprovalChangeView) {
	if (change.before === null) {
		return change.target.type === 'trigger'
			? 'Inherits your default'
			: 'Not set'
	}
	if (change.before.length === 0) {
		if (change.beforeUnusableIds.length > 0) {
			return change.beforeUnusableIds.length === 1
				? '1 stored credential you can no longer use'
				: `${change.beforeUnusableIds.length} stored credentials you can no longer use`
		}
		return 'None on purpose'
	}
	const usable = refsLabel(change.before)
	if (change.beforeUnusableIds.length === 0) return usable
	const unusable =
		change.beforeUnusableIds.length === 1
			? '1 you can no longer use'
			: `${change.beforeUnusableIds.length} you can no longer use`
	return `${usable} (+ ${unusable})`
}

export function approvalAfterLabel(change: CredentialApprovalChangeView) {
	// Failed resolves use `after: []`; do not call that "none on purpose".
	if (change.error) return 'Not resolved'
	if (change.after.length === 0)
		return 'None on purpose (runs get no credential)'
	return refsLabel(change.after)
}

export function approvalChangeIsNoop(change: CredentialApprovalChangeView) {
	if (change.before === null || change.error) return false
	// Stored unusable ids are rewritten on Approve even when usable refs match.
	if (change.beforeUnusableIds.length > 0) return false
	const before = change.before.map((ref) => ref.id)
	const after = change.after.map((ref) => ref.id)
	return (
		before.length === after.length &&
		before.every((id, index) => id === after[index])
	)
}

/** Every problem on the page, for the agent prompt and the summary. */
export function approvalProblems(view: CredentialApprovalView): Array<string> {
	return [
		...view.errors,
		...view.changes.flatMap((change) =>
			change.error ? [`${change.needKey}: ${change.error.message}`] : [],
		),
		...view.enable.flatMap((entry) =>
			entry.error
				? [`${describeTrigger(entry.trigger)}: ${entry.error.message}`]
				: [],
		),
	]
}

/** Triggers Approve turns on, whether by a mapping or by `enable[]` alone. */
function approvalEnabledTriggers(
	view: Pick<CredentialApprovalView, 'changes' | 'enable'>,
): Array<string> {
	const labels = new Set<string>()
	for (const change of view.changes) {
		if (change.willEnable && change.target.type === 'trigger') {
			labels.add(describeTrigger(change.target.trigger))
		}
	}
	for (const entry of view.enable) {
		if (entry.willEnable) labels.add(describeTrigger(entry.trigger))
	}
	return [...labels]
}

/**
 * The success line after Approve. `reviewed` is the view the person approved;
 * the post-write view no longer marks the triggers it turned on.
 */
export function approvalDoneCopy(reviewed: CredentialApprovalView) {
	const count = reviewed.changes.length
	const parts: Array<string> = []
	if (count > 0) {
		parts.push(
			count === 1 ? '1 mapping is saved' : `${count} mappings are saved`,
		)
	}
	const enables = approvalEnabledTriggers(reviewed)
	if (enables.length > 0) {
		parts.push(
			`${enables.join(', ')} ${enables.length === 1 ? 'is' : 'are'} on`,
		)
	}
	return parts.length > 0
		? `${parts.join(' and ')}.`
		: 'Nothing needed to change.'
}

/** Status line for one `enable[]` entry; null when its error says it all. */
export function approvalEnableStatus(
	entry: CredentialApprovalEnableView,
	input: { approved: boolean; turnedOn: boolean },
) {
	const label = describeTrigger(entry.trigger)
	if (input.turnedOn) return `${label} is on for you.`
	if (entry.error) return null
	return entry.willEnable && !input.approved
		? `Approving turns on ${label} for you.`
		: `${label} is already on for you.`
}

export function approvalSummary(view: CredentialApprovalView) {
	const count = view.changes.length
	const enables = approvalEnabledTriggers(view)
	const turnOn = enables.length > 0 ? `turn on ${enables.join(', ')}` : null
	if (count === 0) {
		return turnOn ? `Approve and ${turnOn}` : 'Approve'
	}
	const mappings = count === 1 ? '1 mapping' : `${count} mappings`
	return turnOn ? `Approve ${mappings} and ${turnOn}` : `Approve ${mappings}`
}

export function credentialApprovalAgentPrompt(input: {
	pageUrl: string
	problems: ReadonlyArray<string>
}) {
	return [
		`I opened a credential approval link on Kody: ${input.pageUrl}`,
		'Kody said:',
		...input.problems.map((problem) => `- ${problem}`),
		'Build a corrected link (credentialMappingPropose checks it first). Do not ask me to paste any credential value into chat.',
	].join('\n')
}
