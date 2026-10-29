import { expect, test } from 'vitest'
import type {
	CredentialRef,
	PackageTriggerView,
} from '#universal/credential-contracts.ts'
import {
	canToggleTriggerEnablement,
	credentialRefHref,
	packageCredentialsTabHref,
	readPackageCredentialsTabPath,
} from './package-credentials-page.ts'

const acmeBot: CredentialRef = {
	id: 'cred 1',
	name: 'acme-bot',
	scope: 'org',
	kind: 'oauth',
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
	const href = packageCredentialsTabHref({
		username: 'jane',
		kodyId: 'daily-digest',
		tab: 'triggers',
	})
	expect(href).toBe('/@jane/daily-digest/triggers')
	expect(readPackageCredentialsTabPath(href)).toEqual({
		username: 'jane',
		kodyId: 'daily-digest',
		tab: 'triggers',
	})
	expect(readPackageCredentialsTabPath('/@jane/-/credentials')).toBeNull()
	expect(
		readPackageCredentialsTabPath('/@jane/daily-digest/settings'),
	).toBeNull()
	expect(readPackageCredentialsTabPath('/@jane/daily-digest')).toBeNull()
	expect(readPackageCredentialsTabPath('/@jane/%E0%A4%A/triggers')).toBeNull()
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
})
