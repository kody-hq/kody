import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	setupPackageCredentialMappingFixture,
	type MappingFixturePerson,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import { parseCredentialApprovalQuery } from '#universal/credential-contracts.ts'
import { credentialMappingProposeCapability } from './credential-mapping-propose.ts'

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

async function setup() {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	const caller = (
		person: MappingFixturePerson,
		role: 'owner' | 'member' | null,
		packageId: string | null = null,
	) => ({
		env: t.env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.test',
			user: {
				userId: t.people[person].personId,
				email: `${person}@example.com`,
				displayName: person,
			},
			orgBinding: { org: { id: t.acmeId, slug: 'acme-clients' }, role },
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
	return { ...t, caller }
}

test('credentialMappingPropose returns an approval URL and the view, writing nothing', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.storeKey('team-slack', 'slack')
	const result = await credentialMappingProposeCapability.handler(
		{
			kodyId: 'digest',
			defaults: { mail: { name: 'resend-prod', scope: 'org' } },
			mine: { chat: [] },
			triggers: [
				{
					kind: 'cron',
					name: 'daily',
					credentials: { chat: [{ name: 'team-slack' }] },
				},
			],
			reason: 'Daily digest',
		},
		t.caller('bea', 'owner'),
	)
	const url = new URL(result.approvalUrl)
	expect(url.origin + url.pathname).toBe(
		'https://kody.test/@acme-clients/digest/approve-credentials',
	)
	expect(url.searchParams.get('default[mail]')).toBe('org:resend-prod')
	expect(url.searchParams.get('mine[chat]')).toBe('')
	expect(url.searchParams.get('trigger[cron:daily][chat]')).toBe('team-slack')
	expect(parseCredentialApprovalQuery(url.searchParams).errors).toEqual([])
	expect(result.view).toMatchObject({
		canApprove: true,
		reason: 'Daily digest',
		package: { id: t.savedPackage.id, kodyId: 'digest' },
	})
	expect(result.view.changes.map((change) => change.willEnable)).toEqual([
		false,
		false,
		true,
	])
	expect(result.view.changes[0]!.after).toEqual([
		{ id: prod, name: 'resend-prod', scope: 'org', kind: 'secret' },
	])
	expect(result.message).toContain(result.approvalUrl)
	expect(await t.enablementCount()).toBe(0)
	const stored = await t.db
		.prepare(`SELECT COUNT(*) AS n FROM credential_mappings`)
		.first<{ n: number }>()
	expect(stored?.n).toBe(0)
})

test('credentialMappingPropose reports what to fix and refuses package code and outsiders', async () => {
	const t = await setup()
	const fixable = await credentialMappingProposeCapability.handler(
		{ packageId: t.savedPackage.id, mine: { mail: { name: 'missing' } } },
		t.caller('bea', 'owner'),
	)
	expect(fixable.view.canApprove).toBe(false)
	expect(fixable.view.changes[0]!.error).toMatchObject({
		code: 'credential_not_found',
		createUrl: expect.stringContaining('/@acme-clients/-/credentials/new?'),
	})
	expect(fixable.message).toContain('cannot be approved yet')

	await expect(
		credentialMappingProposeCapability.handler(
			{ kodyId: 'digest' },
			t.caller('bea', 'owner'),
		),
	).rejects.toThrow(/at least one mapping/)
	await expect(
		credentialMappingProposeCapability.handler(
			{ kodyId: 'digest', mine: { mail: [] } },
			t.caller('bea', 'owner', t.savedPackage.id),
		),
	).rejects.toThrow(/Package code cannot/)
	await expect(
		credentialMappingProposeCapability.handler(
			{ kodyId: 'digest', mine: { mail: [] } },
			t.caller('ann', 'member'),
		),
	).rejects.toThrow(/Package not found/)
	await expect(
		credentialMappingProposeCapability.handler(
			{ kodyId: 'missing', mine: { mail: [] } },
			t.caller('bea', 'owner'),
		),
	).rejects.toThrow(/Package not found/)
})

test('credentialMappingPropose puts an email sender on the approval link', async () => {
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
	const result = await credentialMappingProposeCapability.handler(
		{
			kodyId: 'digest',
			enable: [{ kind: 'subscription', name: 'email.message.received' }],
			sender: { kind: 'address', value: 'receipts@shop.example' },
		},
		t.caller('bea', 'owner'),
	)
	const url = new URL(result.approvalUrl)
	expect(url.searchParams.get('sender_kind')).toBe('address')
	expect(url.searchParams.get('sender_value')).toBe('receipts@shop.example')
	expect(result.view.canApprove).toBe(true)
	expect(result.view.sender).toEqual({
		kind: 'address',
		value: 'receipts@shop.example',
	})
	expect(result.view.enable[0]).toMatchObject({ willEnable: true, error: null })
	expect(await t.enablementCount()).toBe(0)
})

test('credentialMappingPropose refuses an unusable sender instead of omitting it', async () => {
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
	await expect(
		credentialMappingProposeCapability.handler(
			{
				kodyId: 'digest',
				enable: [{ kind: 'subscription', name: 'email.message.received' }],
				sender: { kind: 'address', value: 'not-an-email' },
			},
			t.caller('bea', 'owner'),
		),
	).rejects.toThrow(/usable value/)
})
