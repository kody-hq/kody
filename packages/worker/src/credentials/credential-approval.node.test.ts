import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import {
	dailyTarget as daily,
	mineTarget as mine,
	orgDefaultTarget as orgDefault,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import {
	buildCredentialApprovalHref,
	parseCredentialApprovalQuery,
	type CredentialMappingProposalChange,
} from '#universal/credential-contracts.ts'
import { insertEnablement } from '#worker/enablements/repo.ts'
import {
	approveCredentialProposal,
	resolveCredentialApproval,
} from './credential-approval.ts'
import {
	buildWriteCredentialMappingStatement,
	runCredentialMappingWrite,
} from './credential-mappings.ts'
import * as needsClosure from './credential-needs-closure.ts'
import { buildPackageCredentialsView } from './package-credential-mappings.ts'

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

const setup = () =>
	setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})

/** Round-trips through the link codec, as the approval page reads it. */
function proposalOf(
	changes: Array<CredentialMappingProposalChange>,
	reason?: string,
) {
	const href = buildCredentialApprovalHref({
		username: 'acme-clients',
		kodyId: 'digest',
		changes,
		reason,
	})
	return parseCredentialApprovalQuery(
		new URL(href, 'https://kody.test').searchParams,
	)
}

test('one Approve writes default and trigger mappings and turns the trigger on', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	const slack = await t.storeKey('team-slack', 'slack')
	const proposal = proposalOf(
		[
			{
				target: orgDefault,
				needKey: 'mail',
				credentials: [{ name: 'resend-prod', scope: 'org' }],
			},
			{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
		],
		'Daily digest posts to Slack',
	)
	const scope = await t.scopeFor('bea', 'owner')
	const { view } = await resolveCredentialApproval(scope, proposal)
	expect(view).toMatchObject({
		ok: true,
		package: { id: t.savedPackage.id, kodyId: 'digest' },
		reason: 'Daily digest posts to Slack',
		canApprove: true,
		errors: [],
	})
	expect(
		view.changes.map((change) => [
			change.needKey,
			change.before,
			change.after.map((ref) => ref.id),
			change.willEnable,
			change.error,
		]),
	).toEqual([
		['mail', null, [prod], false, null],
		['chat', null, [slack], true, null],
	])
	expect(view.fingerprint).toMatch(/^[0-9a-f]{64}$/)
	expect(
		(await resolveCredentialApproval(scope, proposal)).view.fingerprint,
	).toBe(view.fingerprint)
	expect(await t.enablementCount()).toBe(0)

	const outcome = await approveCredentialProposal({
		scope,
		proposal,
		fingerprint: view.fingerprint,
	})
	expect(outcome.status).toBe('approved')
	expect(outcome.view.changes.map((change) => change.before)).toEqual([
		[expect.objectContaining({ id: prod })],
		[expect.objectContaining({ id: slack })],
	])
	expect(outcome.view.changes[1]!.willEnable).toBe(false)
	expect(await t.enablementCount()).toBe(1)
	const packageView = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(packageView.needs[0]!.effective).toMatchObject({
		source: 'org',
		status: 'ready',
	})
	expect(packageView.triggers[0]).toMatchObject({
		enablement: { state: 'on', enabledByYou: true },
		mappings: [
			{ needKey: 'mail', effective: { source: 'org' } },
			{ needKey: 'chat', effective: { source: 'trigger', status: 'ready' } },
		],
	})
})

test('Approve refuses a proposal with errors and one that changed since review', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	const scope = await t.scopeFor('bea', 'owner')

	const broken = proposalOf([
		{ target: mine, needKey: 'nope', credentials: [{ name: 'resend-prod' }] },
	])
	const brokenView = (await resolveCredentialApproval(scope, broken)).view
	expect(brokenView.canApprove).toBe(false)
	expect(brokenView.changes[0]!.error?.code).toBe('need_unknown')
	const invalid = await approveCredentialProposal({
		scope,
		proposal: broken,
		fingerprint: brokenView.fingerprint,
	})
	expect(invalid.status).toBe('invalid')

	const badQuery = parseCredentialApprovalQuery(
		new URLSearchParams('mine[mail]=org:'),
	)
	const badQueryView = (await resolveCredentialApproval(scope, badQuery)).view
	expect(badQueryView.canApprove).toBe(false)
	expect(badQueryView.errors).not.toEqual([])

	const empty = (
		await resolveCredentialApproval(
			scope,
			parseCredentialApprovalQuery(new URLSearchParams()),
		)
	).view
	expect(empty.canApprove).toBe(false)

	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const reviewed = (await resolveCredentialApproval(scope, proposal)).view
	expect(reviewed.canApprove).toBe(true)
	// The mapping changes after review, so the reviewed "before" is wrong.
	await t.apply('bea', 'owner', [
		{ target: mine, needKey: 'mail', credentials: [] },
	])
	const stale = await approveCredentialProposal({
		scope: await t.scopeFor('bea', 'owner'),
		proposal,
		fingerprint: reviewed.fingerprint,
	})
	expect(stale.status).toBe('stale')
	expect(stale.view.changes[0]!.before).toEqual([])
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(view.needs[0]!.defaults.mine?.credentials).toEqual([])

	const fresh = await approveCredentialProposal({
		scope: await t.scopeFor('bea', 'owner'),
		proposal,
		fingerprint: stale.view.fingerprint,
	})
	expect(fresh.status).toBe('approved')
})

test('a replaced credential with the same name changes the fingerprint', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const before = (
		await resolveCredentialApproval(await t.scopeFor('bea', 'owner'), proposal)
	).view
	await t.db
		.prepare(`UPDATE secret_entries SET id = ? WHERE name = 'resend-prod'`)
		.bind(crypto.randomUUID())
		.run()
	const after = (
		await resolveCredentialApproval(await t.scopeFor('bea', 'owner'), proposal)
	).view
	expect(after.canApprove).toBe(true)
	expect(after.fingerprint).not.toBe(before.fingerprint)
})

test('an edit between the final check and the write fails Approve and writes nothing', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const scope = await t.scopeFor('bea', 'owner')
	const reviewed = (await resolveCredentialApproval(scope, proposal)).view
	// `scope` still holds the rows read before this edit, as a racing
	// request would leave them.
	await t.apply('bea', 'owner', [
		{ target: mine, needKey: 'mail', credentials: [] },
	])
	const outcome = await approveCredentialProposal({
		scope,
		proposal,
		fingerprint: reviewed.fingerprint,
	})
	expect(outcome.status).toBe('stale')
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(view.needs[0]!.defaults.mine?.credentials).toEqual([])
	expect(await t.mappingAudits()).toHaveLength(1)
})

test('a trigger turned on and mapped after review fails Approve as stale and keeps that mapping', async () => {
	const t = await setup()
	await t.storeKey('team-slack', 'slack')
	await t.storeKey('backup-slack', 'slack')
	const proposal = proposalOf([
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	const scope = await t.scopeFor('bea', 'owner')
	const reviewed = (await resolveCredentialApproval(scope, proposal)).view
	expect(reviewed.changes[0]!.willEnable).toBe(true)
	// Another tab turns the trigger on with a different pick; `scope` still
	// holds the rows read before it.
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'backup-slack' }] },
	])
	const outcome = await approveCredentialProposal({
		scope,
		proposal,
		fingerprint: reviewed.fingerprint,
	})
	expect(outcome.status).toBe('stale')
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(view.triggers[0]!.mappings[1]).toMatchObject({
		needKey: 'chat',
		effective: {
			source: 'trigger',
			credentials: [expect.objectContaining({ name: 'backup-slack' })],
		},
	})
})

test('a stored mapping of unusable credentials shows their ids and changes the fingerprint when switched', async () => {
	const t = await setup()
	const gone1 = await t.storeKey('resend-old-1', 'resend')
	const gone2 = await t.storeKey('resend-old-2', 'resend')
	await t.storeKey('resend-prod', 'resend')
	await t.db
		.prepare(`UPDATE secret_entries SET deleted_at = ? WHERE id IN (?, ?)`)
		.bind(new Date().toISOString(), gone1, gone2)
		.run()
	const storeMine = (id: string) =>
		runCredentialMappingWrite(
			t.db,
			buildWriteCredentialMappingStatement({
				db: t.db,
				orgId: t.acmeId,
				packageId: t.savedPackage.id,
				needKey: 'mail',
				target: { target: 'mine', personId: t.people.bea.personId },
				credentialIds: [id],
				updatedByUserId: t.people.bea.personId,
				now: new Date().toISOString(),
			}),
		)
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const view = async () =>
		(
			await resolveCredentialApproval(
				await t.scopeFor('bea', 'owner'),
				proposal,
			)
		).view
	await storeMine(gone1)
	const first = await view()
	expect(first.changes[0]).toMatchObject({
		before: [],
		beforeUnusableIds: [gone1],
	})
	await storeMine(gone2)
	expect((await view()).fingerprint).not.toBe(first.fingerprint)
})

test('renaming a credential picked by id changes the fingerprint', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ id: prod }] },
	])
	const fingerprint = async () =>
		(
			await resolveCredentialApproval(
				await t.scopeFor('bea', 'owner'),
				proposal,
			)
		).view.fingerprint
	const before = await fingerprint()
	await t.db
		.prepare(`UPDATE secret_entries SET name = 'resend-renamed' WHERE id = ?`)
		.bind(prod)
		.run()
	expect(await fingerprint()).not.toBe(before)
})

test('a member cannot approve org defaults but can approve their own', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.grantUse(prod, 'ann')
	const scope = await t.scopeFor('ann', 'member')
	const orgView = (
		await resolveCredentialApproval(
			scope,
			proposalOf([
				{
					target: orgDefault,
					needKey: 'mail',
					credentials: [{ name: 'resend-prod' }],
				},
			]),
		)
	).view
	expect(orgView.canApprove).toBe(false)
	expect(orgView.changes[0]!.error?.code).toBe('not_allowed')
	const mineView = (
		await resolveCredentialApproval(
			scope,
			proposalOf([
				{ target: mine, needKey: 'mail', credentials: [{ id: prod }] },
			]),
		)
	).view
	expect(mineView.canApprove).toBe(true)
})

test('publisher-supplied needs reject personal and trigger mapping proposals', async () => {
	const t = await setup()
	const credentialId = await t.storeKey('publisher-key', 'resend')
	const needs = vi
		.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockResolvedValue([
			{
				key: 'mail',
				kind: 'secret',
				provider: 'resend',
				description: 'Publisher email.',
				multiple: false,
				supplier: 'publisher',
			},
		])
	const scope = await t.scopeFor('bea', 'owner')
	for (const target of [mine, daily]) {
		const { view } = await resolveCredentialApproval(
			scope,
			proposalOf([
				{
					target,
					needKey: 'mail',
					credentials: [{ id: credentialId }],
				},
			]),
		)
		expect(view.changes[0]?.error).toMatchObject({
			code: 'not_allowed',
			message:
				'Credential need "mail" is supplied by the publisher. Only the org-level mapping can set it.',
		})
	}
	needs.mockRestore()
})

test('an enable-only proposal turns a minted webhook on at Approve, once', async () => {
	const t = await setup()
	const enableIncoming = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [],
				enable: [{ kind: 'webhook', name: 'incoming' }],
			}),
			'https://kody.test',
		).searchParams,
	)

	const unminted = (
		await resolveCredentialApproval(
			await t.scopeFor('ann', 'member'),
			enableIncoming,
		)
	).view
	expect(unminted.canApprove).toBe(false)
	expect(unminted.enable).toEqual([
		{
			trigger: { kind: 'webhook', name: 'incoming' },
			willEnable: false,
			error: {
				code: 'webhook_not_minted',
				message:
					'Webhook "incoming" has no URL yet. Mint its URL first, then approve it here.',
			},
		},
	])

	// A stored signing secret keeps the enable from minting one.
	await t.db
		.prepare(
			`INSERT INTO webhook_endpoints
				(id, user_id, package_id, webhook_name, url_secret_hash, hmac_secret_encrypted, created_at, rotated_at)
			VALUES ('ep-incoming', ?, ?, 'incoming', 'hash', 'sealed', ?, ?)`,
		)
		.bind(
			t.acmeId,
			t.savedPackage.id,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
		.run()
	expect(await t.enablementCount()).toBe(0)

	const scope = await t.scopeFor('ann', 'member')
	const { view } = await resolveCredentialApproval(scope, enableIncoming)
	expect(view).toMatchObject({
		canApprove: true,
		changes: [],
		enable: [
			{
				trigger: { kind: 'webhook', name: 'incoming' },
				willEnable: true,
				error: null,
			},
		],
	})
	const outcome = await approveCredentialProposal({
		scope,
		proposal: enableIncoming,
		fingerprint: view.fingerprint,
	})
	expect(outcome.status).toBe('approved')
	expect(outcome.view.enable[0]!.willEnable).toBe(false)
	expect(await t.enablementCount()).toBe(1)
	const enabled = await t.db
		.prepare(
			`SELECT instance_id, enabler_user_id, state FROM enablements WHERE trigger_kind = 'webhook'`,
		)
		.first<{ instance_id: string; enabler_user_id: string; state: string }>()
	expect(enabled).toEqual({
		instance_id: 'ep-incoming',
		enabler_user_id: String(t.people.ann.personId),
		state: 'on',
	})

	// Approving again writes nothing; someone else cannot take the webhook over.
	const again = await resolveCredentialApproval(
		await t.scopeFor('ann', 'member'),
		enableIncoming,
	)
	await approveCredentialProposal({
		scope: await t.scopeFor('ann', 'member'),
		proposal: enableIncoming,
		fingerprint: again.view.fingerprint,
	})
	expect(await t.enablementCount()).toBe(1)
	const bea = (
		await resolveCredentialApproval(
			await t.scopeFor('bea', 'owner'),
			enableIncoming,
		)
	).view
	expect(bea.canApprove).toBe(false)
	expect(bea.enable[0]!.error?.code).toBe('webhook_other_enabler')
})

test('a webhook another person turns on between resolve and write is a conflict that writes nothing, not even its signing secret', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.grantUse(prod, 'ann')
	await t.db
		.prepare(
			`INSERT INTO webhook_endpoints
				(id, user_id, package_id, webhook_name, url_secret_hash, hmac_secret_encrypted, created_at, rotated_at)
			VALUES ('ep-incoming', ?, ?, 'incoming', 'hash', NULL, ?, ?)`,
		)
		.bind(
			t.acmeId,
			t.savedPackage.id,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
		.run()
	const incoming = {
		type: 'trigger',
		trigger: { kind: 'webhook', name: 'incoming' },
	} as const
	const proposal = proposalOf([
		{ target: incoming, needKey: 'mail', credentials: [{ id: prod }] },
		{
			target: { type: 'default', layer: 'mine' },
			needKey: 'mail',
			credentials: [{ id: prod }],
		},
	])
	const scope = await t.scopeFor('ann', 'member')
	const { view } = await resolveCredentialApproval(scope, proposal)
	expect(view).toMatchObject({
		canApprove: true,
		changes: [
			{ willEnable: true, error: null },
			{ willEnable: false, error: null },
		],
	})

	// Bea's enablement lands after Ann's plan was made and before her batch.
	const racingDb = new Proxy(t.db, {
		get(target, property) {
			if (property === 'batch') {
				return async (statements: Array<D1PreparedStatement>) => {
					await insertEnablement({
						db: target,
						enablement: {
							orgId: t.acmeId,
							packageId: t.savedPackage.id,
							triggerKind: 'webhook',
							triggerName: 'incoming',
							instanceId: 'ep-incoming',
							enablerUserId: String(t.people.bea.personId),
							origin: 'enabled',
						},
					})
					return await target.batch(statements)
				}
			}
			const value = Reflect.get(target, property) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const outcome = await approveCredentialProposal({
		scope: { ...scope, env: { ...scope.env, APP_DB: racingDb } },
		proposal,
		fingerprint: view.fingerprint,
	})
	expect(outcome.status).toBe('conflict')
	if (outcome.status !== 'conflict') return
	expect(outcome.message).toContain('another person')
	expect(outcome.view.canApprove).toBe(false)
	expect(outcome.view.changes[0]!.error?.code).toBe('webhook_other_enabler')
	expect(await t.enablementCount()).toBe(1)
	const mappings = await t.db
		.prepare(`SELECT COUNT(*) AS n FROM credential_mappings`)
		.first<{ n: number }>()
	expect(mappings!.n).toBe(0)
	const live = await t.db
		.prepare(`SELECT enabler_user_id FROM enablements`)
		.first<{ enabler_user_id: string }>()
	expect(live!.enabler_user_id).toBe(String(t.people.bea.personId))
	const endpoint = await t.db
		.prepare(
			`SELECT hmac_secret_encrypted FROM webhook_endpoints WHERE id = 'ep-incoming'`,
		)
		.first<{ hmac_secret_encrypted: string | null }>()
	expect(endpoint!.hmac_secret_encrypted).toBeNull()
})

test('approving an inbound-email subscription stores the sender and refuses a link without one', async () => {
	const t = await setup()
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@acme/digest',
			kody: {
				id: 'digest',
				description: 'digest',
				subscriptions: {
					'email.message.received': { handler: './src/h.ts' },
					'email.message.quarantined': { handler: './src/q.ts' },
				},
			},
		},
	})
	const received = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [],
				enable: [{ kind: 'subscription', name: 'email.message.received' }],
				sender: { kind: 'address', value: 'receipts@shop.example' },
			}),
			'https://kody.test',
		).searchParams,
	)
	const scope = await t.scopeFor('bea', 'owner')
	const reviewed = await resolveCredentialApproval(scope, received)
	expect(reviewed.view.canApprove).toBe(true)
	expect(reviewed.view.sender).toEqual({
		kind: 'address',
		value: 'receipts@shop.example',
	})
	expect(reviewed.view.enable[0]).toMatchObject({
		willEnable: true,
		error: null,
	})
	const outcome = await approveCredentialProposal({
		scope,
		proposal: received,
		fingerprint: reviewed.view.fingerprint,
	})
	expect(outcome.status).toBe('approved')
	const row = await t.db
		.prepare(
			`SELECT trigger_name, sender_kind, sender_value, state
			 FROM enablements WHERE package_id = ?`,
		)
		.bind(t.savedPackage.id)
		.first<{
			trigger_name: string
			sender_kind: string | null
			sender_value: string | null
			state: string
		}>()
	expect(row).toEqual({
		trigger_name: 'email.message.received',
		sender_kind: 'address',
		sender_value: 'receipts@shop.example',
		state: 'on',
	})

	const again = await resolveCredentialApproval(
		await t.scopeFor('bea', 'owner'),
		received,
	)
	expect(again.view.enable[0]!.willEnable).toBe(false)
	await approveCredentialProposal({
		scope: await t.scopeFor('bea', 'owner'),
		proposal: received,
		fingerprint: again.view.fingerprint,
	})
	expect(await t.enablementCount()).toBe(1)

	const otherSender = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [],
				enable: [{ kind: 'subscription', name: 'email.message.received' }],
				sender: { kind: 'domain', value: 'shop.example' },
			}),
			'https://kody.test',
		).searchParams,
	)
	const other = await resolveCredentialApproval(
		await t.scopeFor('bea', 'owner'),
		otherSender,
	)
	expect(other.view.enable[0]!.willEnable).toBe(true)
	expect(
		(
			await approveCredentialProposal({
				scope: await t.scopeFor('bea', 'owner'),
				proposal: otherSender,
				fingerprint: other.view.fingerprint,
			})
		).status,
	).toBe('approved')
	expect(await t.enablementCount()).toBe(2)

	const missingSender = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [],
				enable: [{ kind: 'subscription', name: 'email.message.quarantined' }],
			}),
			'https://kody.test',
		).searchParams,
	)
	const blocked = await resolveCredentialApproval(
		await t.scopeFor('bea', 'owner'),
		missingSender,
	)
	expect(blocked.view.canApprove).toBe(false)
	expect(blocked.view.errors.join(' ')).toContain('sender_kind')
	expect(
		(
			await approveCredentialProposal({
				scope: await t.scopeFor('bea', 'owner'),
				proposal: missingSender,
				fingerprint: blocked.view.fingerprint,
			})
		).status,
	).toBe('invalid')
	expect(await t.enablementCount()).toBe(2)
})

test('approving a sender mapping writes that sender enablement, not an older one', async () => {
	const t = await setup()
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@acme/digest',
			kody: {
				id: 'digest',
				description: 'digest',
				subscriptions: {
					'email.message.received': { handler: './src/h.ts' },
				},
			},
		},
	})
	const credA = await t.storeKey('resend-a', 'resend')
	const credB = await t.storeKey('resend-b', 'resend')
	const credNext = await t.storeKey('resend-next', 'resend')
	const enabler = String(t.people.bea.personId)
	const insertSender = (senderValue: string, now: string) =>
		insertEnablement({
			db: t.db,
			now,
			enablement: {
				orgId: t.acmeId,
				packageId: t.savedPackage.id,
				triggerKind: 'subscription',
				triggerName: 'email.message.received',
				instanceId: t.savedPackage.id,
				enablerUserId: enabler,
				origin: 'enabled',
				senderKind: 'address',
				senderValue,
			},
		})
	const senderA = await insertSender(
		'a@shop.example',
		'2026-10-13T00:00:00.000Z',
	)
	const senderB = await insertSender(
		'b@shop.example',
		'2026-10-13T00:01:00.000Z',
	)
	const writeMapping = (enablementId: string, credentialId: string) =>
		runCredentialMappingWrite(
			t.db,
			buildWriteCredentialMappingStatement({
				db: t.db,
				orgId: t.acmeId,
				packageId: t.savedPackage.id,
				needKey: 'mail',
				target: { target: 'enablement', enablementId, personId: enabler },
				credentialIds: [credentialId],
				updatedByUserId: enabler,
				now: '2026-10-13T00:00:00.000Z',
			}),
		)
	await writeMapping(senderA.id, credA)
	await writeMapping(senderB.id, credB)
	const proposal = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [
					{
						target: {
							type: 'trigger',
							trigger: {
								kind: 'subscription',
								name: 'email.message.received',
							},
						},
						needKey: 'mail',
						credentials: [{ id: credNext }],
					},
				],
				sender: { kind: 'address', value: 'b@shop.example' },
			}),
			'https://kody.test',
		).searchParams,
	)
	const scope = await t.scopeFor('bea', 'owner')
	const reviewed = await resolveCredentialApproval(scope, proposal)
	expect(reviewed.view.canApprove).toBe(true)
	expect(reviewed.view.changes[0]).toMatchObject({
		willEnable: false,
		before: [expect.objectContaining({ id: credB })],
		after: [expect.objectContaining({ id: credNext })],
	})
	expect(
		(
			await approveCredentialProposal({
				scope,
				proposal,
				fingerprint: reviewed.view.fingerprint,
			})
		).status,
	).toBe('approved')
	const rows = await t.db
		.prepare(
			`SELECT enablement_id, credential_ids_json
			 FROM credential_mappings
			 WHERE target = 'enablement'
			 ORDER BY enablement_id`,
		)
		.all<{ enablement_id: string; credential_ids_json: string }>()
	const stored = (rows.results ?? []).map((row) => ({
		enablementId: row.enablement_id,
		credentialIds: JSON.parse(row.credential_ids_json) as Array<string>,
	}))
	expect(stored).toEqual(
		[
			{ enablementId: senderA.id, credentialIds: [credA] },
			{ enablementId: senderB.id, credentialIds: [credNext] },
		].sort((left, right) =>
			left.enablementId.localeCompare(right.enablementId),
		),
	)
	expect(await t.enablementCount()).toBe(2)
})

test('a concurrent approval of the same sender reuses that enablement', async () => {
	const t = await setup()
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@acme/digest',
			kody: {
				id: 'digest',
				description: 'digest',
				subscriptions: {
					'email.message.received': { handler: './src/h.ts' },
				},
			},
		},
	})
	const cred = await t.storeKey('resend-prod', 'resend')
	const sender = { kind: 'address' as const, value: 'receipts@shop.example' }
	const proposal = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [
					{
						target: {
							type: 'trigger',
							trigger: {
								kind: 'subscription',
								name: 'email.message.received',
							},
						},
						needKey: 'mail',
						credentials: [{ id: cred }],
					},
				],
				sender,
			}),
			'https://kody.test',
		).searchParams,
	)
	const scope = await t.scopeFor('bea', 'owner')
	const reviewed = await resolveCredentialApproval(scope, proposal)
	expect(reviewed.view.canApprove).toBe(true)
	expect(reviewed.view.changes[0]!.willEnable).toBe(true)
	let raced = false
	const racingDb = new Proxy(t.db, {
		get(target, property) {
			if (property === 'batch') {
				return async (statements: Array<D1PreparedStatement>) => {
					if (!raced) {
						raced = true
						await insertEnablement({
							db: target,
							enablement: {
								orgId: t.acmeId,
								packageId: t.savedPackage.id,
								triggerKind: 'subscription',
								triggerName: 'email.message.received',
								instanceId: t.savedPackage.id,
								enablerUserId: String(t.people.bea.personId),
								origin: 'enabled',
								senderKind: sender.kind,
								senderValue: sender.value,
							},
						})
					}
					return await target.batch(statements)
				}
			}
			const value = Reflect.get(target, property) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const outcome = await approveCredentialProposal({
		scope: { ...scope, env: { ...scope.env, APP_DB: racingDb } },
		proposal,
		fingerprint: reviewed.view.fingerprint,
	})
	expect(outcome.status).toBe('approved')
	expect(await t.enablementCount()).toBe(1)
	const mapping = await t.db
		.prepare(
			`SELECT enablement_id, credential_ids_json FROM credential_mappings
			 WHERE target = 'enablement'`,
		)
		.first<{ enablement_id: string; credential_ids_json: string }>()
	const live = await t.db
		.prepare(`SELECT id FROM enablements`)
		.first<{ id: string }>()
	expect(mapping).toEqual({
		enablement_id: live!.id,
		credential_ids_json: JSON.stringify([cred]),
	})
})

test('approving a sender someone else already runs is a conflict', async () => {
	const t = await setup()
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@acme/digest',
			kody: {
				id: 'digest',
				description: 'digest',
				subscriptions: {
					'email.message.received': { handler: './src/h.ts' },
				},
			},
		},
	})
	await insertEnablement({
		db: t.db,
		enablement: {
			orgId: t.acmeId,
			packageId: t.savedPackage.id,
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: t.savedPackage.id,
			enablerUserId: String(t.people.bea.personId),
			origin: 'enabled',
			senderKind: 'address',
			senderValue: 'receipts@shop.example',
		},
	})
	const proposal = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [],
				enable: [{ kind: 'subscription', name: 'email.message.received' }],
				sender: { kind: 'address', value: 'receipts@shop.example' },
			}),
			'https://kody.test',
		).searchParams,
	)
	const scope = await t.scopeFor('ann', 'member')
	const reviewed = await resolveCredentialApproval(scope, proposal)
	expect(reviewed.view.canApprove).toBe(true)
	const outcome = await approveCredentialProposal({
		scope,
		proposal,
		fingerprint: reviewed.view.fingerprint,
	})
	expect(outcome.status).toBe('conflict')
	if (outcome.status !== 'conflict') return
	expect(outcome.message).toContain('another person')
	expect(await t.enablementCount()).toBe(1)
	const live = await t.db
		.prepare(`SELECT enabler_user_id FROM enablements`)
		.first<{ enabler_user_id: string }>()
	expect(live!.enabler_user_id).toBe(String(t.people.bea.personId))
})
