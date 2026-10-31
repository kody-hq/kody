import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import {
	mineTarget as mine,
	orgDefaultTarget as orgDefault,
	setupPackageCredentialMappingFixture,
	type MappingFixturePerson,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import {
	buildCredentialApprovalHref,
	parseCredentialApprovalQuery,
	type CredentialMappingProposalChange,
} from '#universal/credential-contracts.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	approveCredentialProposal,
	resolveCredentialApproval,
} from './credential-approval.ts'
import * as needsClosure from './credential-needs-closure.ts'
import { describePackageCredentialNeeds } from './package-credential-needs.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

async function setup() {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	const needsFor = async (person: MappingFixturePerson, role: OrgRole) =>
		Object.fromEntries(
			(
				await describePackageCredentialNeeds({
					env: t.env,
					request: t.requestAs(person, role),
					ownerUserId: t.acmeId,
					sourceId: t.savedPackage.sourceId,
					packageId: t.savedPackage.id,
				})
			).map((need) => [
				need.key,
				{ status: need.status, autoPick: need.autoPick, source: need.source },
			]),
		)
	const approve = async (changes: Array<CredentialMappingProposalChange>) => {
		const proposal = parseCredentialApprovalQuery(
			new URL(
				buildCredentialApprovalHref({
					username: 'acme-clients',
					kodyId: 'digest',
					changes,
				}),
				'https://kody.test',
			).searchParams,
		)
		const scope = await t.scopeFor('bea', 'owner')
		const { view } = await resolveCredentialApproval(scope, proposal)
		return approveCredentialProposal({
			scope,
			proposal,
			fingerprint: view.fingerprint,
		})
	}
	return { ...t, needsFor, approve }
}

test('an approved org default resolves an ambiguous need in packageGet', async () => {
	const t = await setup()
	await t.storeKey('resend-a', 'resend')
	const picked = await t.storeKey('resend-b', 'resend')
	expect(await t.needsFor('bea', 'owner')).toEqual({
		mail: { status: 'ambiguous', autoPick: null, source: 'auto' },
		chat: { status: 'unbound', autoPick: null, source: 'auto' },
	})

	const outcome = await t.approve([
		{ target: orgDefault, needKey: 'mail', credentials: [{ id: picked }] },
	])
	expect(outcome.status).toBe('approved')
	expect(await t.needsFor('bea', 'owner')).toEqual({
		mail: { status: 'ready', autoPick: 'resend-b', source: 'org' },
		chat: { status: 'unbound', autoPick: null, source: 'auto' },
	})
})

test('your own default wins over the org default, and a default you cannot Use falls back to auto-resolve', async () => {
	const t = await setup()
	const a = await t.storeKey('resend-a', 'resend')
	const b = await t.storeKey('resend-b', 'resend')
	await t.apply('bea', 'owner', [
		{ target: orgDefault, needKey: 'mail', credentials: [{ id: b }] },
		{ target: mine, needKey: 'mail', credentials: [{ id: a }] },
	])
	expect((await t.needsFor('bea', 'owner')).mail).toEqual({
		status: 'ready',
		autoPick: 'resend-a',
		source: 'mine',
	})

	// Ann can Use only resend-a, so the org default (resend-b) is skipped for
	// her, the same as a run, and her one usable match auto-resolves.
	await t.grantUse(a, 'ann')
	expect((await t.needsFor('ann', 'member')).mail).toEqual({
		status: 'ready',
		autoPick: 'resend-a',
		source: 'auto',
	})

	// Mapped to none on purpose: unbound, and no auto-pick.
	await t.apply('bea', 'owner', [
		{ target: mine, needKey: 'mail', credentials: [] },
	])
	expect((await t.needsFor('bea', 'owner')).mail).toEqual({
		status: 'unbound',
		autoPick: null,
		source: 'mine',
	})
})

test('executor needs read as visitor-supplied, and only provider matches are listed', async () => {
	const t = await setup()
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue([
		{
			key: 'code',
			kind: 'secret',
			provider: 'github',
			description: 'Read repositories',
			multiple: false,
			supplier: 'executor',
			required: true,
		},
		{
			key: 'chat',
			kind: 'secret',
			provider: 'slack',
			description: 'Post a summary',
			multiple: false,
			supplier: 'executor',
			required: false,
		},
	])
	await t.storeKey('gh-token', 'github')
	await t.storeKey('unlabeled', 'github')
	await t.env.APP_DB.prepare(
		`UPDATE secret_entries SET provider = NULL WHERE name = 'unlabeled'`,
	).run()
	const needs = await describePackageCredentialNeeds({
		env: t.env,
		request: t.requestAs('bea', 'owner'),
		ownerUserId: t.acmeId,
		sourceId: t.savedPackage.sourceId,
		packageId: t.savedPackage.id,
	})
	expect(
		needs.map((need) => ({
			key: need.key,
			supplier: need.supplier,
			required: need.required,
			status: need.status,
			source: need.source,
			options: need.yourOptions.map((option) => option.name),
			possibleMatchCount: need.possibleMatchCount,
		})),
	).toEqual([
		{
			key: 'code',
			supplier: 'executor',
			required: true,
			status: 'executor_supplied',
			source: 'visitor',
			options: ['gh-token'],
			possibleMatchCount: 1,
		},
		{
			key: 'chat',
			supplier: 'executor',
			required: false,
			status: 'executor_supplied',
			source: 'visitor',
			options: [],
			possibleMatchCount: 1,
		},
	])
})
