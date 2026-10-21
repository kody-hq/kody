import { expect, test } from 'vitest'
import {
	type CredentialRef,
	type PackageCredentialNeedView,
	type PackageTriggerView,
} from '#universal/credential-contracts.ts'
import {
	canToggleTriggerEnablement,
	credentialRefHref,
	credentialRefLabel,
	describeIncompleteMapping,
	incompleteMappingTab,
	mappingStatusLabel,
	packageCredentialsTabHref,
	readPackageCredentialsTabPath,
	sortNeedsByAttention,
	triggerStateLabel,
	withheldTriggerMappingsNote,
} from './package-credentials-page.ts'

const acmeBot: CredentialRef = {
	id: 'cred 1',
	name: 'acme-bot',
	scope: 'org',
	kind: 'oauth',
}

function need(
	key: string,
	status: PackageCredentialNeedView['effective']['status'],
): PackageCredentialNeedView {
	return {
		key,
		kind: null,
		provider: key,
		description: '',
		multiple: false,
		defaults: { org: null, mine: null },
		effective: {
			source: 'none',
			status,
			credentials: [],
			candidates: [],
			createUrl: null,
		},
		options: [],
		createUrl: `/connect/credential?provider=${key}`,
	}
}

function trigger(
	overrides: Partial<PackageTriggerView> & Pick<PackageTriggerView, 'trigger'>,
): PackageTriggerView {
	return {
		instanceId: 'instance-1',
		enablement: null,
		canEdit: false,
		mappings: [],
		instances: [],
		canAddInstance: false,
		...overrides,
	}
}

test('tab paths round-trip and reject org pages and other package paths', () => {
	for (const tab of ['credentials', 'mappings', 'triggers'] as const) {
		const href = packageCredentialsTabHref({
			username: 'jane',
			kodyId: 'daily-digest',
			tab,
		})
		expect(href).toBe(`/@jane/daily-digest/${tab}`)
		expect(readPackageCredentialsTabPath(href)).toEqual({
			username: 'jane',
			kodyId: 'daily-digest',
			tab,
		})
	}
	expect(readPackageCredentialsTabPath('/@jane/-/credentials')).toBeNull()
	expect(
		readPackageCredentialsTabPath('/@jane/daily-digest/settings'),
	).toBeNull()
	expect(readPackageCredentialsTabPath('/@jane/daily-digest')).toBeNull()
	expect(readPackageCredentialsTabPath('/@jane/%E0%A4%A/triggers')).toBeNull()
})

test('incomplete mappings say what is wrong and which tab fixes it', () => {
	const atDefault = {
		needKey: 'slack',
		where: { type: 'default' },
		status: 'unbound',
	} as const
	const atTrigger = {
		needKey: 'openai',
		where: { type: 'trigger', trigger: { kind: 'cron', name: 'daily' } },
		status: 'ambiguous',
	} as const
	expect(describeIncompleteMapping(atDefault)).toBe(
		'Runs have no credential for “slack”. Add one or map an existing one.',
	)
	expect(incompleteMappingTab(atDefault)).toBe('mappings')
	expect(describeIncompleteMapping(atTrigger)).toBe(
		'Schedule “daily” runs match several credentials for “openai”. Pick one so runs don’t fail.',
	)
	expect(incompleteMappingTab(atTrigger)).toBe('triggers')
})

test('needs that need attention sort first, then by key', () => {
	const sorted = sortNeedsByAttention([
		need('github', 'ready'),
		need('zoom', 'unbound'),
		need('none', 'none'),
		need('openai', 'ambiguous'),
		need('token', 'expired'),
	])
	expect(sorted.map((item) => item.key)).toEqual([
		'openai',
		'zoom',
		'github',
		'none',
		'token',
	])
})

test('expired mappings label as Expired with a warning tone', () => {
	expect(mappingStatusLabel('expired')).toEqual({
		label: 'Expired',
		tone: 'warning',
	})
})

test('trigger state names who turned it on and unminted webhooks', () => {
	expect(
		triggerStateLabel(
			trigger({
				trigger: { kind: 'webhook', name: 'hook' },
				instanceId: null,
			}),
		),
	).toBe('Not minted')
	expect(
		triggerStateLabel(trigger({ trigger: { kind: 'cron', name: 'daily' } })),
	).toBe('Off')
	expect(
		triggerStateLabel(
			trigger({
				trigger: { kind: 'subscription', name: 'pr' },
				enablement: { id: 'en', state: 'paused', enabledByYou: false },
			}),
		),
	).toBe('Paused by someone else')
	expect(
		triggerStateLabel(
			trigger({
				trigger: { kind: 'cron', name: 'daily' },
				enablement: { id: 'en', state: 'on', enabledByYou: true },
			}),
		),
	).toBe('On by you')
})

test('mappings under someone else’s enablement read as withheld in every state', () => {
	const hook = { kind: 'webhook', name: 'hook' } as const
	expect(
		withheldTriggerMappingsNote(
			trigger({
				trigger: hook,
				enablement: { id: 'en', state: 'off', enabledByYou: false },
			}),
		),
	).toBe(
		'Someone else set up this trigger (it is off), so its credential mappings are theirs.',
	)
	expect(
		withheldTriggerMappingsNote(
			trigger({
				trigger: hook,
				enablement: { id: 'en', state: 'paused', enabledByYou: false },
			}),
		),
	).toContain('(it is paused)')
	expect(
		withheldTriggerMappingsNote(
			trigger({
				trigger: hook,
				enablement: { id: 'en', state: 'off', enabledByYou: true },
			}),
		),
	).toBeNull()
	expect(withheldTriggerMappingsNote(trigger({ trigger: hook }))).toBeNull()
})

test('the Triggers tab toggle is for the viewer’s own cron or live enablement', () => {
	expect(
		canToggleTriggerEnablement(
			trigger({ trigger: { kind: 'cron', name: 'daily' }, canEdit: true }),
		),
	).toBe(true)
	expect(
		canToggleTriggerEnablement(
			trigger({
				trigger: { kind: 'subscription', name: 'email.message.received' },
				canEdit: true,
			}),
		),
	).toBe(false)
	expect(
		canToggleTriggerEnablement(
			trigger({
				trigger: { kind: 'webhook', name: 'hook' },
				instanceId: null,
				canEdit: true,
			}),
		),
	).toBe(false)
	expect(
		canToggleTriggerEnablement(
			trigger({
				trigger: { kind: 'webhook', name: 'hook' },
				canEdit: true,
			}),
		),
	).toBe(false)
	expect(
		canToggleTriggerEnablement(
			trigger({
				trigger: { kind: 'webhook', name: 'hook' },
				canEdit: true,
				enablement: { id: 'en', state: 'on', enabledByYou: true },
			}),
		),
	).toBe(true)
})

test('credential refs link to the org credential detail by id', () => {
	expect(credentialRefHref('jane', acmeBot)).toBe(
		'/@jane/-/credentials/cred%201',
	)
	expect(credentialRefLabel(acmeBot)).toBe('acme-bot')
	expect(credentialRefLabel({ ...acmeBot, scope: 'personal' })).toBe(
		'acme-bot (yours)',
	)
})
