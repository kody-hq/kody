import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import {
	approveCredentialProposal,
	resolveCredentialApproval,
} from '#worker/credentials/credential-approval.ts'
import { type RequestSource } from '#worker/request-context/request-context.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	dailyTarget as daily,
	setupPackageCredentialMappingFixture,
	type MappingFixturePerson,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import {
	parseCredentialApprovalQuery,
	readCredentialProposalId,
} from '#universal/credential-contracts.ts'
import { credentialMappingProposeCapability } from './credential-mapping-propose.ts'
import { credentialTriggerPickSetCapability } from './credential-trigger-pick-set.ts'

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

async function setup() {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	const team = await t.storeKey('team-slack', 'slack')
	const ops = await t.storeKey('ops-slack', 'slack')
	const caller = (
		person: MappingFixturePerson,
		options: {
			source?: RequestSource
			clientId?: string
			packageId?: string
		} = {},
	) => ({
		env: t.env,
		callerContext: createMcpCallerContext({
			source: options.source ?? { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.test',
			oauthClientId: options.clientId ?? 'client-a',
			user: {
				userId: t.people[person].personId,
				email: `${person}@example.com`,
				displayName: person,
			},
			orgBinding: {
				org: { id: t.acmeId, slug: 'acme-clients' },
				role: person === 'bea' ? 'owner' : 'member',
			},
			...(options.packageId
				? {
						storageContext: {
							sessionId: null,
							appId: null,
							packageId: options.packageId,
							storageId: null,
						},
					}
				: {}),
		}),
	})
	const propose = async (
		credential: string,
		agent: ReturnType<typeof caller> = caller('bea'),
	) =>
		(
			await credentialMappingProposeCapability.handler(
				{
					kodyId: 'digest',
					triggers: [
						{
							kind: 'cron',
							name: 'daily',
							credentials: { chat: { name: credential } },
						},
					],
				},
				agent,
			)
		).approvalUrl
	/** What the approval page does on Approve, for the link it was opened with. */
	const approve = async (
		approvalUrl: string,
		person: MappingFixturePerson = 'bea',
	) => {
		const search = new URL(approvalUrl).searchParams
		const proposal = parseCredentialApprovalQuery(search)
		const scope = await t.scopeFor(
			person,
			person === 'bea' ? 'owner' : 'member',
		)
		const { view } = await resolveCredentialApproval(scope, proposal)
		const outcome = await approveCredentialProposal({
			scope,
			proposal,
			fingerprint: view.fingerprint,
			proposalId: readCredentialProposalId(search),
		})
		expect(outcome.status).toBe('approved')
	}
	const setPick = (credential: string, agent = caller('bea')) =>
		credentialTriggerPickSetCapability.handler(
			{
				kodyId: 'digest',
				trigger: { kind: 'cron', name: 'daily' },
				needKey: 'chat',
				credentials: { name: credential },
			},
			agent,
		)
	const dailyChatPick = async () => {
		const row = await t.db
			.prepare(
				`SELECT credential_ids_json FROM credential_mappings
				WHERE target = 'enablement' AND need_key = 'chat'`,
			)
			.first<{ credential_ids_json: string }>()
		return row ? (JSON.parse(row.credential_ids_json) as Array<string>) : null
	}
	return { ...t, team, ops, caller, propose, approve, setPick, dailyChatPick }
}

test('an agent sets a trigger pick back to a value it proposed and the person approved', async () => {
	const t = await setup()
	const approvalUrl = await t.propose('team-slack')
	expect(readCredentialProposalId(new URL(approvalUrl).searchParams)).toEqual(
		expect.any(String),
	)
	await t.approve(approvalUrl)
	expect(await t.dailyChatPick()).toEqual([t.team])

	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'ops-slack' }] },
	])
	expect(await t.dailyChatPick()).toEqual([t.ops])

	const result = await t.setPick('team-slack')
	expect(result).toMatchObject({
		trigger: { kind: 'cron', name: 'daily' },
		needKey: 'chat',
		credentials: [{ id: t.team, name: 'team-slack' }],
	})
	expect(await t.dailyChatPick()).toEqual([t.team])
})

test('approving the same link again after its credential is replaced keeps the earlier pick approved', async () => {
	const t = await setup()
	const approvalUrl = await t.propose('team-slack')
	await t.approve(approvalUrl)
	await t.db
		.prepare(`UPDATE secret_entries SET name = 'old-team-slack' WHERE id = ?`)
		.bind(t.team)
		.run()
	const replacement = await t.storeKey('team-slack', 'slack')
	await t.approve(approvalUrl)
	expect(await t.dailyChatPick()).toEqual([replacement])

	await t.setPick('old-team-slack')
	expect(await t.dailyChatPick()).toEqual([t.team])
	await t.setPick('team-slack')
	expect(await t.dailyChatPick()).toEqual([replacement])
})

test('Approve writes the mapping and records the approved picks together, or neither', async () => {
	const t = await setup()
	const approvalUrl = await t.propose('team-slack')
	const prepare = t.db.prepare.bind(t.db)
	const spy = vi
		.spyOn(t.db, 'prepare')
		.mockImplementation((sql: string) =>
			prepare(
				sql.includes('SET approved_picks_json')
					? sql.replace('approved_at = ?', 'missing_column = ?')
					: sql,
			),
		)
	await expect(t.approve(approvalUrl)).rejects.toThrow()
	spy.mockRestore()
	expect(await t.dailyChatPick()).toBeNull()
	expect(await t.enablementCount()).toBe(0)

	await t.approve(approvalUrl)
	expect(await t.dailyChatPick()).toEqual([t.team])
})

test('an agent cannot set a pick it never proposed, or one another agent proposed', async () => {
	const t = await setup()
	await t.approve(await t.propose('team-slack'))

	await expect(t.setPick('ops-slack')).rejects.toThrow(
		/only to a value you proposed/,
	)
	await t.approve(
		await t.propose('ops-slack', t.caller('bea', { clientId: 'client-b' })),
	)
	expect(await t.dailyChatPick()).toEqual([t.ops])

	// client-b proposed ops-slack; client-a only team-slack.
	await expect(
		t.setPick('team-slack', t.caller('bea', { clientId: 'client-b' })),
	).rejects.toThrow(/only to a value you proposed/)
	await expect(
		t.setPick(
			'team-slack',
			t.caller('bea', { source: { kind: 'api-token', tokenId: 'client-a' } }),
		),
	).rejects.toThrow(/only to a value you proposed/)
	expect(await t.dailyChatPick()).toEqual([t.ops])
	await t.setPick('team-slack')
	expect(await t.dailyChatPick()).toEqual([t.team])
})

test('a proposal nobody approved, an edited link, or another approver grants nothing', async () => {
	const t = await setup()
	await t.approve(await t.propose('team-slack'))

	await t.propose('ops-slack')
	await expect(t.setPick('ops-slack')).rejects.toThrow(
		/only to a value you proposed/,
	)

	// The person approves ops-slack, but on a link edited from the agent's.
	const edited = new URL(await t.propose('team-slack'))
	edited.searchParams.set('trigger[cron:daily][chat]', 'ops-slack')
	await t.approve(edited.toString())
	expect(await t.dailyChatPick()).toEqual([t.ops])
	await expect(t.setPick('ops-slack')).rejects.toThrow(
		/only to a value you proposed/,
	)

	// ann approves bea's agent's link for her own instance of the job.
	await t.grantPackageUse('ann')
	await t.grantUse(t.ops, 'ann')
	const forAnn = await t.propose('ops-slack')
	await t.approve(forAnn, 'ann')
	const row = await t.db
		.prepare(
			`SELECT approved_at FROM credential_mapping_proposals WHERE id = ?`,
		)
		.bind(readCredentialProposalId(new URL(forAnn).searchParams))
		.first<{ approved_at: string | null }>()
	expect(row?.approved_at).toBeNull()
	await expect(t.setPick('ops-slack')).rejects.toThrow(
		/only to a value you proposed/,
	)
})

test('credentialTriggerPickSet refuses sessions, package code, and a trigger that is off', async () => {
	const t = await setup()
	await expect(
		t.setPick('team-slack', t.caller('bea', { source: { kind: 'session' } })),
	).rejects.toThrow(/MCP client, the CLI, or an API token/)
	await expect(
		t.setPick('team-slack', t.caller('bea', { packageId: t.savedPackage.id })),
	).rejects.toThrow(/Package code cannot/)
	await expect(t.setPick('team-slack', t.caller('cy'))).rejects.toThrow(
		/Package not found/,
	)

	// Approving would turn the job on, so the agent cannot.
	await t.propose('team-slack')
	await expect(t.setPick('team-slack')).rejects.toThrow(
		/cron "daily" is off\. Turning it on needs approval/,
	)
	expect(await t.enablementCount()).toBe(0)
	expect(await t.dailyChatPick()).toBeNull()
})
