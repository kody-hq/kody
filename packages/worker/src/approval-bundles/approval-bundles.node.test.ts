import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { decideApprovalBundleItem } from '#app/approval-bundle-decisions.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { approvalBundleCreateCapability } from '#mcp/capabilities/packages/approval-bundle-create.ts'
import { approvalPendingListCapability } from '#mcp/capabilities/packages/approval-pending-list.ts'
import { credentialMappingProposeCapability } from '#mcp/capabilities/secrets/credential-mapping-propose.ts'
import { enqueuePackageApprovalRequest } from '#worker/package-capabilities/approval-requests-repo.ts'
import {
	mappingFixtureBaseUrl,
	setupPackageCredentialMappingFixture,
	type MappingFixturePerson,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import { listPendingCredentialProposals } from '#worker/credentials/agent-credential-proposals.ts'
import {
	approvalItemsAwaitingDecision,
	approvalItemsReadyToApprove,
	type ApprovalBundleView,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'
import { insertPackageSecurityAudit } from '#worker/package-capabilities/security-audits-repo.ts'
import { approvePackageCapabilitySet } from '#worker/package-capabilities/capability-approval-service.ts'
import { enqueueWentPublicApproval } from '#worker/package-capabilities/went-public-approval.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import {
	type ApprovalViewer,
	capabilityGrantLines,
	loadApprovalItemView,
} from './item-views.ts'
import {
	approvalBundleClaimLeaseMs,
	deleteApprovalBundlesForMember,
} from './repo.ts'
import { createApprovalBundle, loadApprovalBundleView } from './service.ts'

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

async function setup() {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	await t.storeKey('team-slack', 'slack')
	await t.db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, ?, 'commit-1', 'package.json', '/', ?, ?)`,
		)
		.bind(
			t.savedPackage.sourceId,
			t.acmeId,
			t.savedPackage.id,
			`repo-${t.savedPackage.id}`,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
		.run()
	const agent = (person: MappingFixturePerson, packageId?: string) => ({
		env: t.env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: mappingFixtureBaseUrl,
			oauthClientId: 'client-a',
			user: {
				userId: t.people[person].personId,
				email: `${person}@example.com`,
				displayName: person,
			},
			orgBinding: {
				org: { id: t.acmeId, slug: 'acme-clients' },
				role: person === 'bea' ? 'owner' : 'member',
			},
			...(packageId
				? {
						storageContext: {
							sessionId: null,
							appId: null,
							packageId,
							storageId: null,
						},
					}
				: {}),
		}),
	})
	const viewerFor = (person: MappingFixturePerson): ApprovalViewer => ({
		env: t.env,
		baseUrl: mappingFixtureBaseUrl,
		request: t.requestAs(person, person === 'bea' ? 'owner' : 'member'),
	})
	const proposeDailyChat = () =>
		credentialMappingProposeCapability.handler(
			{
				kodyId: 'digest',
				triggers: [
					{
						kind: 'cron',
						name: 'daily',
						credentials: { chat: { name: 'team-slack' } },
					},
				],
				reason: 'Daily digest needs Slack.',
			},
			agent('bea'),
		)
	const pausePublish = () =>
		enqueuePackageApprovalRequest(t.db, {
			packageId: t.savedPackage.id,
			ownerUserId: t.acmeId,
			reason: 'credential_needs_changed',
			pendingCommit: 'e650a38aaaaaaaa',
			baseCommit: 'commit-1',
			details: {
				changes: [
					{
						change: 'added',
						key: 'dns',
						from: null,
						after: { kind: 'secret', provider: 'nextdns', multiple: false },
					},
				],
			},
			requestedByUserId: t.people.bea.stableUserId,
		})
	const user = (person: MappingFixturePerson) =>
		({
			userId: 0,
			username: person,
			mcpUser: { userId: t.people[person].personId, username: person },
		}) as unknown as AuthenticatedAppUser
	const decide = (input: {
		person?: MappingFixturePerson
		bundleId: string
		action: 'approve' | 'deny'
		item: string
		fingerprint: string
	}) => {
		const person = input.person ?? 'bea'
		return decideApprovalBundleItem({
			viewer: viewerFor(person),
			request: new Request(`${mappingFixtureBaseUrl}/approvals`),
			user: user(person),
			bundleId: input.bundleId,
			decision: {
				action: input.action,
				item: input.item,
				fingerprint: input.fingerprint,
			},
		})
	}
	const bundleAudits = async () => {
		const rows = await t.env.AUDIT_DB.prepare(
			`SELECT action, result, credential_kind, details_json
			FROM org_audit_events
			WHERE resource_type = 'approval_bundle' ORDER BY rowid`,
		).all<{
			action: string
			result: string
			credential_kind: string | null
			details_json: string | null
		}>()
		return (rows.results ?? []).map((row) => ({
			action: row.action,
			result: row.result,
			credentialKind: row.credential_kind,
			details: row.details_json ? JSON.parse(row.details_json) : null,
		}))
	}
	return {
		...t,
		agent,
		viewerFor,
		proposeDailyChat,
		pausePublish,
		decide,
		bundleAudits,
	}
}

function bundleItems(view: ApprovalBundleView) {
	return view.groups.flatMap((group) => group.items)
}

test('an agent bundles pending approvals, and approving from the bundle applies the proposal', async () => {
	const t = await setup()
	await t.proposeDailyChat()
	const request = await t.pausePublish()

	const listed = await approvalPendingListCapability.handler({}, t.agent('bea'))
	expect(listed.items.map((item) => item.type).sort()).toEqual([
		'credential-picks',
		'publish',
	])
	const publish = listed.items.find((item) => item.type === 'publish')!
	expect(publish.key).toBe(`publish:${request.id}`)
	expect(publish.package?.kodyId).toBe('digest')
	expect(publish.grants).toEqual([
		expect.objectContaining({
			change: 'added',
			label: 'dns',
			provider: 'nextdns',
			kind: 'Key',
		}),
	])

	const created = await approvalBundleCreateCapability.handler(
		{ note: 'Approve the credential format updates.' },
		t.agent('bea'),
	)
	expect(created.url).toBe(
		`${mappingFixtureBaseUrl}/@acme-clients/-/approvals/${created.bundleId}`,
	)
	expect(created.items).toHaveLength(2)

	const loaded = await loadApprovalBundleView({
		viewer: t.viewerFor('bea'),
		bundleId: created.bundleId,
	})
	if (!loaded.ok) throw new Error('bundle did not load')
	expect(loaded.view.bundle.note).toBe('Approve the credential format updates.')
	expect(loaded.view.bundle.createdVia).toBe('an MCP client')
	expect(loaded.view.groups).toHaveLength(1)
	expect(approvalItemsAwaitingDecision(loaded.view)).toHaveLength(2)

	const picks = bundleItems(loaded.view).find(
		(item) => item.type === 'credential-picks',
	)!
	const approved = await t.decide({
		bundleId: created.bundleId,
		action: 'approve',
		item: picks.key,
		fingerprint: picks.fingerprint!,
	})
	expect(approved.body).toMatchObject({
		ok: true,
		item: { key: picks.key, status: 'approved' },
	})
	const mapping = await t.db
		.prepare(
			`SELECT credential_ids_json FROM credential_mappings
			WHERE target = 'enablement' AND need_key = 'chat'`,
		)
		.first<{ credential_ids_json: string }>()
	expect(JSON.parse(mapping!.credential_ids_json)).toHaveLength(1)

	const again = await t.decide({
		bundleId: created.bundleId,
		action: 'approve',
		item: picks.key,
		fingerprint: picks.fingerprint!,
	})
	expect(again).toMatchObject({ ok: false, status: 409 })

	expect(await t.bundleAudits()).toEqual([
		expect.objectContaining({
			action: 'approval.bundle.create',
			result: 'success',
			credentialKind: 'mcp-oauth',
		}),
		expect.objectContaining({
			action: 'approval.bundle.approve',
			result: 'success',
			credentialKind: 'session',
			details: expect.objectContaining({ item: picks.key }),
		}),
	])
})

test('denying a paused publish drops it and records the denial', async () => {
	const t = await setup()
	const request = await t.pausePublish()
	await t.pausePublish()
	const created = await createApprovalBundle({
		viewer: t.viewerFor('bea'),
		items: [{ type: 'publish', requestId: request.id }],
	})
	const [item] = created.items
	const stale = await t.decide({
		bundleId: created.bundle.id,
		action: 'deny',
		item: item!.key,
		fingerprint: 'something-else',
	})
	expect(stale).toMatchObject({ ok: false, status: 409 })

	const denied = await t.decide({
		bundleId: created.bundle.id,
		action: 'deny',
		item: item!.key,
		fingerprint: item!.fingerprint!,
	})
	expect(denied.body).toMatchObject({
		ok: true,
		item: { status: 'denied', canApprove: false },
	})
	const row = await t.db
		.prepare(`SELECT status FROM package_approval_requests WHERE id = ?`)
		.bind(request.id)
		.first<{ status: string }>()
	expect(row?.status).toBe('superseded')
	expect((await t.bundleAudits()).map((event) => event.action)).toEqual([
		'approval.bundle.create',
		'approval.bundle.deny',
	])
})

test('write-only members see went_public but cannot deny it', async () => {
	const t = await setup()
	await upsertGrant({
		db: t.db,
		orgId: t.acmeId,
		resourceType: 'package',
		resourceId: t.savedPackage.id,
		family: 'package',
		subject: { type: 'user', id: t.people.ann.stableUserId },
		preset: null,
		permissions: ['package:read', 'package:write'],
		createdByUserId: t.people.bea.stableUserId,
		audit: createTestOrgAuditWriter(),
	})
	const capabilities = await loadApprovalItemView(t.viewerFor('bea'), {
		type: 'capabilities',
		packageId: t.savedPackage.id,
	})
	const request = await enqueueWentPublicApproval({
		env: t.env,
		ownerUserId: t.acmeId,
		savedPackage: t.savedPackage,
		publishedCommit: 'commit-1',
		fingerprint: capabilities.fingerprint!,
		requestedByUserId: t.people.bea.stableUserId,
	})
	const listed = await approvalPendingListCapability.handler(
		{ types: ['publish'] },
		t.agent('ann'),
	)
	expect(listed.items).toEqual([
		expect.objectContaining({
			type: 'publish',
			canApprove: false,
			statusMessage: expect.stringContaining('package:publish'),
		}),
	])
	const view = await loadApprovalItemView(t.viewerFor('ann'), {
		type: 'publish',
		requestId: request.id,
	})
	expect(view).toMatchObject({ canApprove: false, canDeny: false })
	const created = await createApprovalBundle({
		viewer: t.viewerFor('ann'),
		items: [{ type: 'publish', requestId: request.id }],
	})
	const [item] = created.items
	expect(item).toMatchObject({ canApprove: false, canDeny: false })
	const denied = await t.decide({
		person: 'ann',
		bundleId: created.bundle.id,
		action: 'deny',
		item: item!.key,
		fingerprint: item!.fingerprint!,
	})
	expect(denied).toMatchObject({ ok: false, status: 409 })
	const row = await t.db
		.prepare(`SELECT status FROM package_approval_requests WHERE id = ?`)
		.bind(request.id)
		.first<{ status: string }>()
	expect(row?.status).toBe('pending')
})

test('concurrent approve and deny on one item: only the winning decision acts', async () => {
	const t = await setup()
	await t.proposeDailyChat()
	const created = await createApprovalBundle({
		viewer: t.viewerFor('bea'),
		filter: { types: ['credential-picks'] },
	})
	const [item] = created.items
	const [approve, deny] = await Promise.all([
		t.decide({
			bundleId: created.bundle.id,
			action: 'approve',
			item: item!.key,
			fingerprint: item!.fingerprint!,
		}),
		t.decide({
			bundleId: created.bundle.id,
			action: 'deny',
			item: item!.key,
			fingerprint: item!.fingerprint!,
		}),
	])
	expect([approve.ok, deny.ok].filter(Boolean)).toHaveLength(1)
	const loser = approve.ok ? deny : approve
	expect(loser).toMatchObject({ ok: false, status: 409 })
	const mapping = await t.db
		.prepare(
			`SELECT credential_ids_json FROM credential_mappings
			WHERE target = 'enablement' AND need_key = 'chat'`,
		)
		.first<{ credential_ids_json: string }>()
	expect(mapping !== null).toBe(approve.ok)
	const loaded = await loadApprovalBundleView({
		viewer: t.viewerFor('bea'),
		bundleId: created.bundle.id,
	})
	if (!loaded.ok) throw new Error('bundle did not load')
	expect(bundleItems(loaded.view)[0]?.status).toBe(
		approve.ok ? 'approved' : 'denied',
	)
	expect(
		(await t.bundleAudits())
			.filter((event) => event.result === 'success')
			.map((event) => event.action),
	).toEqual([
		'approval.bundle.create',
		approve.ok ? 'approval.bundle.approve' : 'approval.bundle.deny',
	])
})

test('a failed approve gives the item back so it can still be decided', async () => {
	const t = await setup()
	await t.proposeDailyChat()
	const created = await createApprovalBundle({
		viewer: t.viewerFor('bea'),
		filter: { types: ['credential-picks'] },
	})
	const [item] = created.items
	await t.db
		.prepare(`DELETE FROM secret_entries WHERE name = 'team-slack'`)
		.run()
	const failed = await t.decide({
		bundleId: created.bundle.id,
		action: 'approve',
		item: item!.key,
		fingerprint: item!.fingerprint!,
	})
	expect(failed).toMatchObject({ ok: false, status: 409 })
	const denied = await t.decide({
		bundleId: created.bundle.id,
		action: 'deny',
		item: item!.key,
		fingerprint: failed.body.item!.fingerprint!,
	})
	expect(denied.body).toMatchObject({ ok: true, item: { status: 'denied' } })
})

test('a decided item stays decided in its bundle', async () => {
	const t = await setup()
	const request = await t.pausePublish()
	const created = await createApprovalBundle({
		viewer: t.viewerFor('bea'),
		items: [{ type: 'publish', requestId: request.id }],
	})
	const [item] = created.items
	await t.db
		.prepare(
			`INSERT INTO approval_bundle_decisions (
				bundle_id, item_key, decision, decided_by_user_id, decided_at,
				finalized_at
			) VALUES (?, ?, 'approved', ?, ?, ?)`,
		)
		.bind(
			created.bundle.id,
			item!.key,
			t.people.bea.personId,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:01.000Z',
		)
		.run()
	const loaded = await loadApprovalBundleView({
		viewer: t.viewerFor('bea'),
		bundleId: created.bundle.id,
	})
	if (!loaded.ok) throw new Error('bundle did not load')
	expect(bundleItems(loaded.view)[0]).toMatchObject({
		status: 'approved',
		canApprove: false,
		canDeny: false,
	})
	expect(approvalItemsAwaitingDecision(loaded.view)).toEqual([])
})

test('an in-flight claim blocks others until its lease runs out, and never reads as decided', async () => {
	const t = await setup()
	const request = await t.pausePublish()
	const created = await createApprovalBundle({
		viewer: t.viewerFor('bea'),
		items: [{ type: 'publish', requestId: request.id }],
	})
	const [item] = created.items
	const claim = (decidedAt: string) =>
		t.db
			.prepare(
				`INSERT OR REPLACE INTO approval_bundle_decisions (
					bundle_id, item_key, decision, decided_by_user_id, decided_at
				) VALUES (?, ?, 'approved', ?, ?)`,
			)
			.bind(created.bundle.id, item!.key, t.people.bea.personId, decidedAt)
			.run()
	const deny = () =>
		t.decide({
			bundleId: created.bundle.id,
			action: 'deny',
			item: item!.key,
			fingerprint: item!.fingerprint!,
		})

	await claim(new Date().toISOString())
	const loaded = await loadApprovalBundleView({
		viewer: t.viewerFor('bea'),
		bundleId: created.bundle.id,
	})
	if (!loaded.ok) throw new Error('bundle did not load')
	expect(bundleItems(loaded.view)[0]).toMatchObject({
		status: 'pending',
		decision: null,
	})
	const blocked = await deny()
	expect(blocked).toMatchObject({ ok: false, status: 409 })
	expect(blocked.body).toMatchObject({
		error: expect.stringContaining('being decided in another tab'),
	})

	await claim(
		new Date(Date.now() - approvalBundleClaimLeaseMs - 1000).toISOString(),
	)
	const takenOver = await deny()
	expect(takenOver.body).toMatchObject({
		ok: true,
		item: { status: 'denied' },
	})
})

test('a live claim in one bundle blocks the same item in another bundle', async () => {
	const t = await setup()
	const request = await t.pausePublish()
	const items = [{ type: 'publish' as const, requestId: request.id }]
	const first = await createApprovalBundle({
		viewer: t.viewerFor('bea'),
		items,
	})
	const second = await createApprovalBundle({
		viewer: t.viewerFor('bea'),
		items,
	})
	const [item] = second.items
	await t.db
		.prepare(
			`INSERT INTO approval_bundle_decisions (
				bundle_id, item_key, decision, decided_by_user_id, decided_at
			) VALUES (?, ?, 'approved', ?, ?)`,
		)
		.bind(
			first.bundle.id,
			item!.key,
			t.people.bea.personId,
			new Date().toISOString(),
		)
		.run()
	const blocked = await t.decide({
		bundleId: second.bundle.id,
		action: 'deny',
		item: item!.key,
		fingerprint: item!.fingerprint!,
	})
	expect(blocked).toMatchObject({ ok: false, status: 409 })
	const row = await t.db
		.prepare(`SELECT status FROM package_approval_requests WHERE id = ?`)
		.bind(request.id)
		.first<{ status: string }>()
	expect(row?.status).toBe('pending')
})

test('an approved proposal hides its older identical copies', async () => {
	const t = await setup()
	await t.proposeDailyChat()
	await t.proposeDailyChat()
	const pending = () =>
		listPendingCredentialProposals({
			db: t.db,
			orgId: t.acmeId,
			personId: t.people.bea.personId,
		})
	const [newest] = await pending()
	expect(await pending()).toHaveLength(1)
	await t.db
		.prepare(
			`UPDATE credential_mapping_proposals SET approved_at = ? WHERE id = ?`,
		)
		.bind(new Date().toISOString(), newest!.id)
		.run()
	expect(await pending()).toEqual([])
})

test('pending items that cannot be approved yet still count as waiting', () => {
	const item = (key: string, canApprove: boolean): ApprovalItemView => ({
		key,
		type: 'credential-picks',
		title: 'Choose credentials',
		summary: '',
		package: null,
		status: 'pending',
		statusMessage: canApprove ? null : 'Fix before approving: revoked.',
		canApprove,
		canDeny: true,
		fingerprint: key,
		detailLabel: 'Approval fingerprint',
		grants: [],
		reviewHref: null,
		decision: null,
	})
	const view = {
		groups: [
			{ package: null, items: [item('ready', true), item('blocked', false)] },
		],
	}
	expect(approvalItemsAwaitingDecision(view).map((entry) => entry.key)).toEqual(
		['ready', 'blocked'],
	)
	expect(approvalItemsReadyToApprove(view).map((entry) => entry.key)).toEqual([
		'ready',
	])
})

test('equal proposals from two agents both wait for approval', async () => {
	const t = await setup()
	await t.proposeDailyChat()
	await t.db
		.prepare(
			`INSERT INTO credential_mapping_proposals (
				id, org_id, package_id, person_user_id, agent_credential_kind,
				agent_credential_id, proposal_json, created_at
			)
			SELECT 'second-agent', org_id, package_id, person_user_id,
				agent_credential_kind, 'another-agent', proposal_json, created_at
			FROM credential_mapping_proposals LIMIT 1`,
		)
		.run()
	const pending = await listPendingCredentialProposals({
		db: t.db,
		orgId: t.acmeId,
		personId: t.people.bea.personId,
	})
	expect(pending).toHaveLength(2)
	expect(pending.map((entry) => entry.agentCredentialId)).toContain(
		'another-agent',
	)
})

test('only the person a bundle was made for can open or decide it', async () => {
	const t = await setup()
	await t.pausePublish()
	const created = await createApprovalBundle({ viewer: t.viewerFor('bea') })
	expect(
		await loadApprovalBundleView({
			viewer: t.viewerFor('ann'),
			bundleId: created.bundle.id,
		}),
	).toEqual({ ok: false, reason: 'not-found' })
	const [item] = created.items
	expect(
		await t.decide({
			person: 'ann',
			bundleId: created.bundle.id,
			action: 'approve',
			item: item!.key,
			fingerprint: item!.fingerprint!,
		}),
	).toMatchObject({ ok: false, status: 404 })
})

test('members without package:publish see no paused publishes to bundle', async () => {
	const t = await setup()
	await t.pausePublish()
	const listed = await approvalPendingListCapability.handler(
		{ types: ['publish'] },
		t.agent('ann'),
	)
	expect(listed.items).toEqual([])
	await expect(
		approvalBundleCreateCapability.handler(
			{ types: ['publish'] },
			t.agent('ann'),
		),
	).rejects.toThrow('Nothing is waiting on you to approve.')
})

test('package code cannot create approval bundles', async () => {
	const t = await setup()
	await t.pausePublish()
	await expect(
		approvalBundleCreateCapability.handler(
			{},
			t.agent('bea', t.savedPackage.id),
		),
	).rejects.toThrow('Package code cannot create approval bundles.')
})

test('bundles expire after 30 days and leave with the member', async () => {
	const t = await setup()
	await t.pausePublish()
	const created = await createApprovalBundle({ viewer: t.viewerFor('bea') })
	expect(
		await loadApprovalBundleView({
			viewer: t.viewerFor('bea'),
			bundleId: created.bundle.id,
			now: new Date(Date.parse(created.bundle.createdAt) + 31 * 86_400_000),
		}),
	).toEqual({ ok: false, reason: 'expired' })
	await deleteApprovalBundlesForMember({
		db: t.db,
		orgId: t.acmeId,
		personId: t.people.bea.stableUserId,
	})
	expect(
		await loadApprovalBundleView({
			viewer: t.viewerFor('bea'),
			bundleId: created.bundle.id,
		}),
	).toEqual({ ok: false, reason: 'not-found' })
})

test('a capability that only moved to another dependency still shows a change', () => {
	const entry = {
		kind: 'credential' as const,
		credentialId: 'cred_slack',
		name: 'team-slack',
		credentialKind: 'secret',
		hosts: ['slack.com'],
		via: ['@me/app'],
	}
	const lines = capabilityGrantLines(
		[entry],
		[{ ...entry, via: ['@me/app', '@me/slack-helper'] }],
	)
	expect(lines).toHaveLength(1)
	expect(lines[0]).toMatchObject({
		change: 'changed',
		before: expect.stringContaining('@me/app'),
		after: expect.stringContaining('@me/slack-helper'),
	})
	expect(
		capabilityGrantLines([entry], [{ ...entry, name: 'renamed-slack' }]),
	).toEqual([])
})

test('a capabilities item shows the security audit for the current version only', async () => {
	const t = await setup()
	const ref = { type: 'capabilities' as const, packageId: t.savedPackage.id }

	const before = await loadApprovalItemView(t.viewerFor('bea'), ref)
	expect(before.securityAudit).toEqual({ status: 'not_audited' })
	expect(before.fingerprint).toEqual(expect.any(String))

	await insertPackageSecurityAudit(t.db, {
		id: 'audit-1',
		packageId: t.savedPackage.id,
		ownerUserId: t.acmeId,
		publishedCommit: 'commit-1',
		fingerprint: before.fingerprint!,
		verdict: 'concerns',
		summary: 'Slack webhook host is broader than needed.',
		auditorLabel: 'Audit Agent',
		recordedByUserId: t.people.bea.personId,
		recordedAt: '2026-10-14T15:30:00.000Z',
	})
	const after = await loadApprovalItemView(t.viewerFor('bea'), ref)
	expect(after.securityAudit).toEqual({
		status: 'audited',
		verdict: 'concerns',
		auditor: 'Audit Agent',
		recordedAt: '2026-10-14T15:30:00.000Z',
	})
	expect(after.canApprove).toBe(before.canApprove)
})

test('a went-public item waits for the capability set, which the package page approves with it', async () => {
	const t = await setup()
	const viewer = t.viewerFor('bea')
	const capabilities = await loadApprovalItemView(viewer, {
		type: 'capabilities',
		packageId: t.savedPackage.id,
	})
	const request = await enqueueWentPublicApproval({
		env: t.env,
		ownerUserId: t.acmeId,
		savedPackage: t.savedPackage,
		publishedCommit: 'commit-1',
		fingerprint: capabilities.fingerprint!,
		requestedByUserId: t.people.bea.stableUserId,
	})
	const ref = { type: 'publish' as const, requestId: request.id }

	const waiting = await loadApprovalItemView(viewer, ref)
	expect(waiting).toMatchObject({
		title: 'Serve on the public internet',
		status: 'pending',
		canApprove: false,
		canDeny: true,
		statusMessage: expect.stringContaining('one Approve also turns on'),
	})
	expect(waiting.reviewHref).toContain('/approve-capabilities')
	// The credential needs the app asks for are listed, not just the hostname.
	expect(waiting.grants.map((grant) => grant.label)).toEqual(
		expect.arrayContaining(['mail', 'chat']),
	)

	const approved = await approvePackageCapabilitySet({
		env: t.env,
		ownerUserId: t.acmeId,
		actorUserId: t.people.bea.stableUserId,
		savedPackage: t.savedPackage,
		requestUrl: mappingFixtureBaseUrl,
		expectedFingerprint: capabilities.fingerprint!,
	})
	expect(approved.wentPublicRequest?.id).toBe(request.id)
	expect(await loadApprovalItemView(viewer, ref)).toMatchObject({
		status: 'pending',
		canApprove: true,
		statusMessage: null,
	})
})
