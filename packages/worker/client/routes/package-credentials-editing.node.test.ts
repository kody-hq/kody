import { afterEach, expect, test, vi } from 'vitest'
import {
	type CredentialRef,
	type PackageCredentialNeedView,
	type PackageCredentialsView,
	type PackageTriggerView,
} from '#universal/credential-contracts.ts'
import {
	canEditTrigger,
	draftForMappingEditor,
	draftFromStored,
	draftToChange,
	mappingOptions,
	mappingEditorKey,
	type MappingDraft,
	mappingSaveAgentPrompt,
	packageBoundKeysPickerNote,
	toggleDraftPick,
	triggerMappingRows,
	triggerDraftProblem,
	triggerWillEnable,
} from './package-credentials-editing.ts'

const orgRef: CredentialRef = {
	id: 'cred-1',
	name: 'team',
	scope: 'org',
	kind: 'secret',
}
const mineRef: CredentialRef = {
	id: 'cred-2',
	name: 'mine',
	scope: 'personal',
	kind: 'secret',
}

function need(overrides: Partial<PackageCredentialNeedView> = {}) {
	return {
		key: 'openai',
		kind: 'secret',
		provider: 'openai',
		description: '',
		multiple: false,
		defaults: { org: null, mine: null },
		effective: {
			source: 'none',
			status: 'ambiguous',
			credentials: [],
			candidates: [orgRef, mineRef],
			createUrl: null,
		},
		options: [orgRef, mineRef],
		createUrl: '/connect/credential?provider=openai',
		...overrides,
	} satisfies PackageCredentialNeedView
}

function trigger(overrides: Partial<PackageTriggerView> = {}) {
	return {
		trigger: { kind: 'cron', name: 'daily' },
		instanceId: 'job-1',
		enablement: null,
		canEdit: true,
		mappings: [],
		instances: [],
		canAddInstance: true,
		...overrides,
	} satisfies PackageTriggerView
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('drafts read inherit, none, and picks from the stored mapping', () => {
	const stored = {
		unusableIds: [],
		updatedAt: '2026-10-13T00:00:00.000Z',
		updatedBy: null,
	}
	expect(draftFromStored(null)).toEqual({ mode: 'inherit' })
	expect(draftFromStored({ ...stored, credentials: [] })).toEqual({
		mode: 'none',
	})
	expect(draftFromStored({ ...stored, credentials: [orgRef] })).toEqual({
		mode: 'pick',
		ids: ['cred-1'],
	})
	expect(
		draftFromStored({ ...stored, credentials: [], unusableIds: ['gone'] }),
	).toEqual({ mode: 'pick', ids: [] })
})

test('drafts become changes, and empty or extra picks are refused', () => {
	const target = { type: 'default', layer: 'mine' } as const
	expect(
		draftToChange({ target, need: need(), draft: { mode: 'inherit' } }),
	).toEqual({
		ok: true,
		change: { target, needKey: 'openai', credentials: null },
	})
	expect(
		draftToChange({ target, need: need(), draft: { mode: 'none' } }),
	).toEqual({
		ok: true,
		change: { target, needKey: 'openai', credentials: [] },
	})
	expect(
		draftToChange({
			target,
			need: need(),
			draft: { mode: 'pick', ids: ['cred-2'] },
		}),
	).toEqual({
		ok: true,
		change: { target, needKey: 'openai', credentials: [{ id: 'cred-2' }] },
	})
	expect(
		draftToChange({ target, need: need(), draft: { mode: 'pick', ids: [] } }),
	).toEqual({
		ok: false,
		error: 'Pick a credential, or choose none on purpose.',
	})
	expect(
		draftToChange({
			target,
			need: need(),
			draft: { mode: 'pick', ids: ['cred-1', 'cred-2'] },
		}),
	).toEqual({ ok: false, error: '“openai” takes one credential.' })
})

test('picks replace for single needs and toggle for multiple ones', () => {
	expect(
		toggleDraftPick({ mode: 'pick', ids: ['a'] }, 'b', {
			multiple: false,
			checked: true,
		}),
	).toEqual({ mode: 'pick', ids: ['b'] })
	const added = toggleDraftPick({ mode: 'none' }, 'a', {
		multiple: true,
		checked: true,
	})
	const both = toggleDraftPick(added, 'b', { multiple: true, checked: true })
	expect(both).toEqual({ mode: 'pick', ids: ['a', 'b'] })
	expect(
		toggleDraftPick(both, 'a', { multiple: true, checked: false }),
	).toEqual({ mode: 'pick', ids: ['b'] })
})

test('the org default offers org credentials only', () => {
	expect(mappingOptions(need(), { type: 'default', layer: 'org' })).toEqual([
		orgRef,
	])
	expect(mappingOptions(need(), { type: 'default', layer: 'mine' })).toEqual([
		orgRef,
		mineRef,
	])
	expect(
		mappingOptions(need(), {
			type: 'trigger',
			trigger: { kind: 'cron', name: 'daily' },
		}),
	).toEqual([orgRef, mineRef])
})

test('the mapping editor pre-selects a sole option or an exact name match', () => {
	const target = { type: 'default', layer: 'mine' } as const
	const unbound = {
		source: 'auto' as const,
		status: 'unbound' as const,
		credentials: [],
		candidates: [],
		createUrl: null,
	}
	expect(
		draftForMappingEditor(
			need({ effective: unbound, options: [] }),
			target,
			null,
		),
	).toEqual({ mode: 'inherit' })
	expect(
		draftForMappingEditor(
			need({ effective: unbound, options: [orgRef] }),
			{ type: 'default', layer: 'org' },
			null,
		),
	).toEqual({ mode: 'pick', ids: ['cred-1'] })
	const named: CredentialRef = {
		id: 'cred-openai',
		name: 'openai',
		scope: 'org',
		kind: 'secret',
	}
	expect(
		draftForMappingEditor(
			need({ effective: unbound, options: [orgRef, named] }),
			target,
			null,
		),
	).toEqual({ mode: 'pick', ids: ['cred-openai'] })
	// Auto-ready stays inherit so saving is not required.
	expect(
		draftForMappingEditor(
			need({
				effective: {
					source: 'auto',
					status: 'ready',
					credentials: [orgRef],
					candidates: [],
					createUrl: null,
				},
				options: [orgRef],
			}),
			{ type: 'default', layer: 'org' },
			null,
		),
	).toEqual({ mode: 'inherit' })
	expect(packageBoundKeysPickerNote).toContain('other packages are hidden')
})

test('only the enabler edits a trigger, and an off trigger turns on when saved', () => {
	expect(canEditTrigger(trigger())).toBe(true)
	const pick: MappingDraft = { mode: 'pick', ids: ['cred-1'] }
	const inherit: MappingDraft = { mode: 'inherit' }
	expect(triggerWillEnable(trigger(), pick)).toBe(true)
	expect(triggerWillEnable(trigger(), { mode: 'none' })).toBe(true)
	expect(triggerWillEnable(trigger(), inherit)).toBe(false)
	const createTarget = {
		type: 'trigger' as const,
		trigger: { kind: 'cron' as const, name: 'daily' },
		createInstance: true,
	}
	expect(
		triggerWillEnable(
			trigger({
				enablement: { id: 'en', state: 'on', enabledByYou: true },
			}),
			pick,
			createTarget,
		),
	).toBe(true)
	expect(triggerDraftProblem(trigger(), inherit, createTarget)).toContain(
		'not create another instance',
	)
	expect(triggerDraftProblem(trigger(), inherit)).toContain('stay off')
	expect(triggerDraftProblem(trigger(), pick)).toBeNull()
	expect(triggerDraftProblem(null, inherit)).toBeNull()
	const mine = trigger({
		enablement: { id: 'en', state: 'on', enabledByYou: true },
	})
	expect(canEditTrigger(mine)).toBe(true)
	expect(triggerWillEnable(mine, pick)).toBe(false)
	expect(triggerDraftProblem(mine, inherit)).toBeNull()
	expect(
		canEditTrigger(
			trigger({
				enablement: { id: 'en', state: 'on', enabledByYou: false },
				canEdit: false,
			}),
		),
	).toBe(false)
	expect(
		canEditTrigger(
			trigger({
				trigger: { kind: 'webhook', name: 'hook' },
				instanceId: null,
			}),
		),
	).toBe(false)
})

test('trigger rows cover every need, using the trigger’s own row when sent', () => {
	const github = need({ key: 'github' })
	const openai = need()
	const mapping = {
		needKey: 'openai',
		override: null,
		effective: openai.effective,
	}
	const view = {
		ok: true,
		package: { id: 'pkg', kodyId: 'pkg', canManage: true },
		needs: [github, openai],
		triggers: [],
		locked: [],
		incomplete: [],
	} satisfies PackageCredentialsView
	expect(triggerMappingRows(view, trigger({ mappings: [mapping] }))).toEqual([
		{ need: github, mapping: null },
		{ need: openai, mapping },
	])
})

test('the agent prompt names the mapping and never asks for a value', () => {
	expect(
		mappingSaveAgentPrompt({
			pageUrl: 'https://kody.codes/@jane/daily-digest/triggers',
			needKey: 'openai',
			target: { type: 'trigger', trigger: { kind: 'cron', name: 'daily' } },
			message: 'Gone.',
		}),
	).toBe(
		[
			'I tried to map “openai” for Schedule “daily” on Kody: https://kody.codes/@jane/daily-digest/triggers',
			'Kody said: Gone.',
			'Help me fix it. Do not ask me to paste any credential value into chat.',
		].join('\n'),
	)
})

test('mapping editor state stays separate for each live trigger instance and a new instance', () => {
	const trigger = { kind: 'cron' as const, name: 'daily' }
	const first = mappingEditorKey(
		{ type: 'trigger', trigger, enablementId: 'first' },
		'github',
	)
	const second = mappingEditorKey(
		{ type: 'trigger', trigger, enablementId: 'second' },
		'github',
	)
	const next = mappingEditorKey(
		{ type: 'trigger', trigger, createInstance: true },
		'github',
	)
	expect(new Set([first, second, next]).size).toBe(3)
})
