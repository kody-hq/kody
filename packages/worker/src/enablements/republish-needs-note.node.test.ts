import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { type CredentialNeed } from '#worker/credentials/credential-needs.ts'
import {
	dailyTarget as daily,
	mappingFixtureNeeds,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import { republishedNeedsNote } from './republish-needs-note.ts'

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

const calendar: CredentialNeed = {
	key: 'calendar',
	kind: 'oauth',
	provider: 'google',
	description: 'Read the calendar',
	multiple: false,
}

test('a republish that adds needs notes how live enablements resolve them', async () => {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	const note = (needs: Array<CredentialNeed>) =>
		republishedNeedsNote({
			env: t.env,
			userId: t.acmeId,
			packageName: '@acme/digest',
			needs,
		})

	expect(await note([...mappingFixtureNeeds, calendar])).toBeNull()

	await t.storeKey('team-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	expect(await note(mappingFixtureNeeds)).toBeNull()
	expect(await note([...mappingFixtureNeeds, calendar])).toBe(
		"This publish adds credential needs calendar. 1 live enablement of this package resolves them on each run from its trigger mapping, the enabler's default, the org default, or the one credential the enabler can use; a run that finds none fails with a link to create one. Map them on the package's Credentials page, or propose mappings with credentialMappingPropose.",
	)
})

test('a republish is found by its source: a rename still notes added needs, another source does not', async () => {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	await t.storeKey('team-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	const renamed = (sourceId: string | null) =>
		republishedNeedsNote({
			env: t.env,
			userId: t.acmeId,
			sourceId,
			packageName: '@acme/digest-renamed',
			needs: [...mappingFixtureNeeds, calendar],
		})
	expect(await renamed(null)).toBeNull()
	expect(await renamed(t.savedPackage.sourceId)).toContain(
		'This publish adds credential needs calendar.',
	)
	expect(
		await republishedNeedsNote({
			env: t.env,
			userId: t.acmeId,
			sourceId: 'another-source',
			packageName: '@acme/digest',
			needs: [...mappingFixtureNeeds, calendar],
		}),
	).toBeNull()
})
