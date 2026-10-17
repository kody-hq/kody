import {
	type CredentialMappingChange,
	type CredentialMappingTarget,
	type CredentialRef,
	type PackageCredentialNeedView,
	type PackageCredentialsView,
	type PackageCredentialsWriteError,
	type PackageTriggerView,
	type StoredCredentialMapping,
} from '#universal/credential-contracts.ts'
import { describeTrigger } from '#universal/package-credentials-page.ts'

/** What the editor will write: inherit (`null`), none on purpose (`[]`), or picks. */
export type MappingDraft =
	| { mode: 'inherit' }
	| { mode: 'none' }
	| { mode: 'pick'; ids: Array<string> }

export function mappingEditorKey(
	target: CredentialMappingTarget,
	needKey: string,
) {
	switch (target.type) {
		case 'default':
			return JSON.stringify(['default', target.layer, needKey])
		case 'trigger':
			return JSON.stringify([
				'trigger',
				target.trigger.kind,
				target.trigger.name,
				target.enablementId ?? '',
				target.createInstance ? 'new' : '',
				needKey,
			])
		default: {
			const exhaustive: never = target
			return exhaustive
		}
	}
}

export function draftFromStored(
	stored: StoredCredentialMapping | null,
): MappingDraft {
	if (!stored) return { mode: 'inherit' }
	if (stored.credentials.length === 0) {
		return stored.unusableIds.length === 0
			? { mode: 'none' }
			: { mode: 'pick', ids: [] }
	}
	return { mode: 'pick', ids: stored.credentials.map((ref) => ref.id) }
}

/**
 * Opening draft for a mapping cell: stored mapping when present; inherit when
 * auto-resolve already covers the need; otherwise pre-select the sole option
 * or the option whose name matches the need key so the owner can save without
 * hunting.
 */
export function draftForMappingEditor(
	need: PackageCredentialNeedView,
	target: CredentialMappingTarget,
	stored: StoredCredentialMapping | null,
): MappingDraft {
	if (stored) return draftFromStored(stored)
	if (need.effective.status === 'ready' && need.effective.source === 'auto') {
		return { mode: 'inherit' }
	}
	const choices = mappingOptions(need, target)
	if (choices.length === 1 && choices[0]) {
		return { mode: 'pick', ids: [choices[0].id] }
	}
	const named = choices.filter((choice) => choice.name === need.key)
	if (named.length === 1 && named[0]) {
		return { mode: 'pick', ids: [named[0].id] }
	}
	return { mode: 'inherit' }
}

/** Shown under the mapping picker: Keys bound to other packages stay out. */
export const packageBoundKeysPickerNote =
	'Keys bound to other packages are hidden. A Key bound to this package can fill its needs.'

/** The org default can only point at org credentials; other targets take any option. */
export function mappingOptions(
	need: PackageCredentialNeedView,
	target: CredentialMappingTarget,
): Array<CredentialRef> {
	return target.type === 'default' && target.layer === 'org'
		? need.options.filter((option) => option.scope === 'org')
		: need.options
}

export function toggleDraftPick(
	draft: MappingDraft,
	id: string,
	input: { multiple: boolean; checked: boolean },
): MappingDraft {
	if (!input.multiple) return { mode: 'pick', ids: [id] }
	const ids = draft.mode === 'pick' ? draft.ids : []
	const next = input.checked
		? [...ids.filter((existing) => existing !== id), id]
		: ids.filter((existing) => existing !== id)
	return { mode: 'pick', ids: next }
}

export function draftToChange(input: {
	target: CredentialMappingTarget
	need: PackageCredentialNeedView
	draft: MappingDraft
}):
	| { ok: true; change: CredentialMappingChange }
	| { ok: false; error: string } {
	const base = { target: input.target, needKey: input.need.key }
	switch (input.draft.mode) {
		case 'inherit':
			return { ok: true, change: { ...base, credentials: null } }
		case 'none':
			return { ok: true, change: { ...base, credentials: [] } }
		case 'pick': {
			const ids = input.draft.ids
			if (ids.length === 0) {
				return {
					ok: false,
					error: 'Pick a credential, or choose none on purpose.',
				}
			}
			if (ids.length > 1 && !input.need.multiple) {
				return {
					ok: false,
					error: `“${input.need.key}” takes one credential.`,
				}
			}
			return {
				ok: true,
				change: { ...base, credentials: ids.map((id) => ({ id })) },
			}
		}
		default: {
			const exhaustive: never = input.draft
			return exhaustive
		}
	}
}

/**
 * Writing a credential choice turns the trigger on for a writer who has not
 * enabled it. Inherit writes nothing, so an off trigger stays off.
 */
export function triggerWillEnable(
	trigger: PackageTriggerView,
	draft: MappingDraft,
	target?: CredentialMappingTarget,
) {
	if (!trigger.canEdit || draft.mode === 'inherit') return false
	if (target?.type === 'trigger' && target.createInstance) return true
	return trigger.enablement === null
}

/** Why saving this draft would change nothing, or null when it writes. */
export function triggerDraftProblem(
	trigger: PackageTriggerView | null,
	draft: MappingDraft,
	target?: CredentialMappingTarget,
) {
	if (!trigger || draft.mode !== 'inherit') return null
	if (target?.type === 'trigger' && target.createInstance) {
		return 'Inheriting writes nothing, so it would not create another instance. Pick a credential (or none on purpose), or use Add another instance for defaults.'
	}
	if (trigger.enablement !== null) return null
	return 'This trigger is off, and inheriting writes nothing, so it would stay off. Pick a credential (or none on purpose) to turn it on with this mapping.'
}

export function canEditTrigger(trigger: PackageTriggerView) {
	if (!trigger.canEdit) return false
	if (trigger.enablement && !trigger.enablement.enabledByYou) return false
	return !(trigger.trigger.kind === 'webhook' && trigger.instanceId === null)
}

/**
 * One row per declared need, using the trigger's own row when the API sent
 * one. A trigger nobody has turned on yet may come back without rows.
 */
export function triggerMappingRows(
	view: PackageCredentialsView,
	trigger: PackageTriggerView,
): Array<{
	need: PackageCredentialNeedView
	mapping: PackageTriggerView['mappings'][number] | null
}> {
	const byKey = new Map(
		trigger.mappings.map((mapping) => [mapping.needKey, mapping]),
	)
	return view.needs.map((need) => ({
		need,
		mapping: byKey.get(need.key) ?? null,
	}))
}

export type PackageCredentialsWriteResult =
	| { kind: 'saved'; view: PackageCredentialsView }
	| { kind: 'refused'; errors: Array<PackageCredentialsWriteError> }
	| { kind: 'error'; message: string }
	| { kind: 'unauthorized' }

export function describeMappingTarget(target: CredentialMappingTarget) {
	switch (target.type) {
		case 'default':
			return target.layer === 'org' ? 'the org default' : 'your default'
		case 'trigger':
			return describeTrigger(target.trigger)
		default: {
			const exhaustive: never = target
			return exhaustive
		}
	}
}

export function mappingSaveAgentPrompt(input: {
	pageUrl: string
	needKey: string
	target: CredentialMappingTarget
	message: string
}) {
	return [
		`I tried to map “${input.needKey}” for ${describeMappingTarget(input.target)} on Kody: ${input.pageUrl}`,
		`Kody said: ${input.message}`,
		'Help me fix it. Do not ask me to paste any credential value into chat.',
	].join('\n')
}
