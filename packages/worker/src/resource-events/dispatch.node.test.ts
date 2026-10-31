import { expect, test, vi } from 'vitest'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { type OrgAuditOutboxPayload } from '#worker/orgs/org-audit-outbox.ts'
import { type LoadedPackageSubscription } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { type invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

vi.mock('#worker/orgs/repo.ts', () => ({
	getOrgById: async () => ({ slug: 'acme' }),
}))
vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: () => 'https://kody.test',
}))
vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: async () => ({ ok: true }),
}))
vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	loadMatchingPackageSubscriptions: async () => ({
		subscriptions: [],
		discoveryErrors: [],
	}),
	readPreExecutionPackageInvocationInfrastructureCode: () => null,
}))
vi.mock('#worker/run-records/service.ts', () => ({
	recordRunRecord: vi.fn(async () => {}),
}))

const { dispatchResourceChangeEvent, recordDroppedResourceEvent } =
	await import('./dispatch.ts')
const { recordRunRecord } = await import('#worker/run-records/service.ts')

function savedPackage(id: string): SavedPackageRecord {
	return {
		id,
		userId: 'org-1',
		name: id,
		kodyId: id,
		description: '',
		tags: [],
		searchText: null,
		sourceId: `source-${id}`,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	} as unknown as SavedPackageRecord
}

function subscription(id: string) {
	return { savedPackage: savedPackage(id) } as LoadedPackageSubscription
}

function payload(
	overrides: Partial<OrgAuditOutboxPayload> = {},
): OrgAuditOutboxPayload {
	return {
		id: 'audit-1',
		orgId: 'org-1',
		action: 'package.updated',
		result: 'success',
		actorUserId: 'user-1',
		actorUsername: 'pat',
		credentialKind: null,
		credentialId: null,
		resourceType: 'package',
		resourceId: 'package-changed',
		targetUserId: null,
		detailsJson: JSON.stringify({
			name: 'changed-package',
			visibility: { before: 'private', after: 'org' },
		}),
		ipHash: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

function access(permissions: Array<string>): EffectivePermissions {
	return {
		orgId: 'org-1',
		permissions: new Set(permissions),
		isOwner: false,
		resourcePermissions: new Map(),
		credentialScopes: null,
	} as unknown as EffectivePermissions
}

function harness(subscribers: Array<string>) {
	const invoke = vi.fn<typeof invokePackageSubscription>(
		async () => ({ ok: true }) as never,
	)
	const recordDrop = vi.fn(async () => {})
	return {
		invoke,
		recordDrop,
		hooks: {
			loadSubscriptions: async () => subscribers.map(subscription),
			invoke,
			recordDrop,
			loadPackage: async ({ packageId }: { packageId: string }) =>
				savedPackage(packageId),
		},
	}
}

test('delivers to subscribers with the resource as the audience', async () => {
	const h = harness(['subscriber'])
	const result = await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload(),
		hooks: h.hooks,
	})
	expect(result).toEqual({ delivered: 1, dropped: [] })
	const call = h.invoke.mock.calls[0]![0]
	expect(call).toMatchObject({
		topic: 'package.updated',
		audience: { resource: { type: 'package', id: 'package-changed' } },
		idempotencyKey: 'resource-event:audit-1:subscriber',
		resourceEventDepth: 1,
		params: {
			event: 'package.updated',
			resource: { kind: 'package', name: 'changed-package' },
			org: { slug: 'acme' },
			changed_fields: ['visibility'],
			changes: { visibility: { before: 'private', after: 'org' } },
		},
	})
	expect(call.params).not.toHaveProperty('actor')
})

test('the actor reaches only enablers who can read the audit log', async () => {
	const h = harness(['subscriber'])
	await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload(),
		hooks: h.hooks,
	})
	const paramsForRun = h.invoke.mock.calls[0]![0].paramsForRun!
	expect(paramsForRun({ access: access(['package:read']) })).not.toHaveProperty(
		'actor',
	)
	expect(paramsForRun({ access: null })).not.toHaveProperty('actor')
	expect(paramsForRun({ access: access(['audit:read']) })).toMatchObject({
		actor: { kind: 'person', username: 'pat' },
	})
})

test('a package never receives its own change', async () => {
	const h = harness(['subscriber', 'causer'])
	const result = await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload({ cause: { packageId: 'causer', resourceEventDepth: 0 } }),
		hooks: h.hooks,
	})
	expect(result).toEqual({
		delivered: 1,
		dropped: [{ packageId: 'causer', reason: 'own_change' }],
	})
	expect(h.invoke).toHaveBeenCalledTimes(1)
	expect(h.invoke.mock.calls[0]![0].savedPackage.id).toBe('subscriber')
	expect(h.recordDrop).toHaveBeenCalledWith(
		expect.objectContaining({ topic: 'package.updated', reason: 'own_change' }),
	)
})

test('chains stop after three hops with a warning on the causing package', async () => {
	const h = harness(['subscriber'])
	const third = await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload({ cause: { packageId: 'causer', resourceEventDepth: 2 } }),
		hooks: h.hooks,
	})
	expect(third.delivered).toBe(1)
	expect(h.invoke.mock.calls[0]![0].resourceEventDepth).toBe(3)

	const fourth = await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload({ cause: { packageId: 'causer', resourceEventDepth: 3 } }),
		hooks: h.hooks,
	})
	expect(fourth).toEqual({
		delivered: 0,
		dropped: [{ packageId: 'causer', reason: 'chain_limit' }],
	})
	expect(h.invoke).toHaveBeenCalledTimes(1)
	expect(h.recordDrop).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage: expect.objectContaining({ id: 'causer' }),
			reason: 'chain_limit',
		}),
	)
})

test('failed changes and non-resource actions do not emit', async () => {
	const h = harness(['subscriber'])
	await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload({ result: 'denied' }),
		hooks: h.hooks,
	})
	await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload({ action: 'credential.used' }),
		hooks: h.hooks,
	})
	expect(h.invoke).not.toHaveBeenCalled()
})

test('memories reach owners only and membership needs member:read', async () => {
	const memory = harness(['subscriber'])
	await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload({
			action: 'memory.updated',
			resourceType: 'memory',
			detailsJson: JSON.stringify({ fields: ['body'] }),
		}),
		hooks: memory.hooks,
	})
	expect(memory.invoke.mock.calls[0]![0].audience).toEqual({ resource: null })

	const membership = harness(['subscriber'])
	await dispatchResourceChangeEvent({
		env: {} as Env,
		payload: payload({
			action: 'member.added',
			resourceType: null,
			detailsJson: JSON.stringify({ role: 'member' }),
		}),
		hooks: membership.hooks,
	})
	expect(membership.invoke.mock.calls[0]![0].audience).toEqual({
		resource: null,
		orgPermission: 'member:read',
	})
})

test('a dropped event writes a warning naming the event and why', async () => {
	await recordDroppedResourceEvent({
		env: {} as Env,
		savedPackage: savedPackage('causer'),
		topic: 'credential.rotated',
		reason: 'own_change',
		auditId: 'audit-1',
	})
	const record = vi.mocked(recordRunRecord).mock.calls[0]![0] as unknown as {
		logs: Array<{ level: string; message: string }>
	}
	expect(record.logs[0]!.level).toBe('warn')
	expect(record.logs[0]!.message).toContain(
		'Kody did not deliver credential.rotated to this package',
	)
	expect(record.logs[0]!.message).not.toContain('\u2014')
})
