import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as packageSourceModule from '#worker/package-registry/source.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { planLimits } from '#universal/plans.ts'
import { consumeExecuteUniqueWorkerDay } from '#worker/entitlements/service.ts'
import type * as EntitlementService from '#worker/entitlements/service.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	ComputeOverageLimitError,
	computeOverageLimitErrorCode,
	entitlementLimitErrorCode,
} from '#worker/entitlements/errors.ts'
import { invokePackageExport } from './service.ts'
import { invalidateInvokeContractFreshness } from './invoke-contract-cache.ts'
import {
	packageInvocationsRepoMockModule as repoMockModule,
	createDatabase,
	createEnvWithUserMeter,
	createToken,
	seedPackageResolution,
} from '#worker/test-support/package-invocations.ts'
import { automationInvocationsPerDayResource } from './automation-invocation-entitlement.ts'

const entitlementServiceMock = vi.hoisted(() => ({
	stopPastInclude: false,
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementService>()
	return {
		...actual,
		consumeDailyEntitlement: async (
			...args: Parameters<typeof actual.consumeDailyEntitlement>
		) => {
			if (entitlementServiceMock.stopPastInclude) {
				throw new ComputeOverageLimitError({
					resource: 'unique_worker_days',
					plan: 'pro',
					limit: 350,
					current: 351,
					creditsStatus: 'add_credits',
				})
			}
			return await actual.consumeDailyEntitlement(...args)
		},
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		repoMockModule.resolveSavedPackageRef(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByName(...args),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		repoMockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestBySourceId(...args),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceBySourceId(...args),
	loadPackageSourceRowForUser: (
		...args: Parameters<typeof packageSourceModule.loadPackageSourceRowForUser>
	) => repoMockModule.loadPackageSourceRowForUser(...args),
	loadPackageManifestForSource: (
		...args: Parameters<typeof packageSourceModule.loadPackageManifestForSource>
	) => repoMockModule.loadPackageManifestForSource(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		repoMockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		repoMockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		repoMockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runBundledModuleWithRegistry: (...args: Array<unknown>) =>
		repoMockModule.runBundledModuleWithRegistry(...args),
}))

vi.mock('#worker/usage/agent-package-conversation-uses.ts', () => ({
	recordAgentPackageConversationUse: (...args: Array<unknown>) =>
		repoMockModule.recordAgentPackageConversationUse(...args),
}))

vi.mock('#worker/run-records/package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: (...args: Array<unknown>) =>
		repoMockModule.dispatchRunErrorSubscriptionEvents(...args),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: async (_db: D1Database, userId: string) => ({
		userId,
		email: 'owner@example.com',
		username: 'owner',
		displayName: 'Owner',
	}),
}))

function invalidateSeededInvokeContract() {
	invalidateInvokeContractFreshness({
		userId: ownerIdFromStored('user-123'),
		packageIdOrKodyIds: ['pkg-1', 'discord-gateway', '@owner/pkg'],
		sourceId: 'source-1',
	})
}

function prepareSuccessfulExport() {
	invalidateSeededInvokeContract()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})
	const db = createDatabase()
	return { db, ...createEnvWithUserMeter(db), token: createToken() }
}

function invokeWebhook(
	env: Env,
	token: ReturnType<typeof createToken>,
	idempotencyKey: string,
) {
	return invokePackageExport({
		env,
		baseUrl: 'https://example.test',
		token,
		request: {
			packageIdOrKodyId: '@owner/pkg',
			exportName: './dispatch-message-created',
			params: { n: 1 },
			idempotencyKey,
			source: 'webhook',
		},
	})
}

function readMeter(env: Env, userId: string, resource: string) {
	return userMeterRpc({ env, userId: ownerIdFromStored(userId) }).read({
		resource,
		day: utcDayKey(),
	})
}

async function readCount(env: Env, userId: string, resource: string) {
	const read = await readMeter(env, userId, resource)
	return read.outcome === 'ready' ? read.count : 0
}

let executeWorkerSeq = 0
function consumeExecuteCall(env: Env, userId: string) {
	executeWorkerSeq += 1
	return consumeExecuteUniqueWorkerDay({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(userId),
		email: 'owner@example.com',
		workerId: `kody-execute-${executeWorkerSeq}`,
	})
}

test('automation_invocations_per_day under quota succeeds without touching execute', async () => {
	const { env, token } = prepareSuccessfulExport()

	const response = await invokeWebhook(env, token, 'automation-under-quota')
	expect(response.status).toBe(200)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		await readMeter(env, token.userId, automationInvocationsPerDayResource),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(
		await readCount(env, token.userId, 'execute_unique_workers_per_day'),
	).toBe(0)
})

test('automation_invocations_per_day at quota fails before sandbox, leaves execute free, and releases the keyed claim so a later retry can succeed', async () => {
	const { db, env, meter, token } = prepareSuccessfulExport()
	const day = utcDayKey()
	const limit = planLimits.free.maxAutomationInvocationsPerDay
	const idempotencyKey = 'automation-quota-retry'
	await meter.seed({
		userId: token.userId,
		resource: automationInvocationsPerDayResource,
		day,
		count: limit,
	})

	const denied = await invokeWebhook(env, token, idempotencyKey)
	expect(denied.status).toBe(429)
	expect(denied.body).toMatchObject({
		ok: false,
		error: {
			code: entitlementLimitErrorCode,
			details: {
				code: entitlementLimitErrorCode,
				resource: automationInvocationsPerDayResource,
				plan: 'free',
				limit,
				current: limit,
			},
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	expect(
		db.runLog.ledgerRows.find((row) => row.idempotencyKey === idempotencyKey),
	).toBeUndefined()

	await consumeExecuteCall(env, token.userId)
	expect(
		await readMeter(env, token.userId, 'execute_unique_workers_per_day'),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(
		await readMeter(env, token.userId, automationInvocationsPerDayResource),
	).toMatchObject({ outcome: 'ready', count: limit })

	// initialize() is insert-once; drop the counter so a retry can consume.
	const userRows = meter.metersByUser.get(token.userId)
	expect(userRows).toBeDefined()
	userRows?.delete(`${automationInvocationsPerDayResource}\0${day}`)
	await meter.seed({
		userId: token.userId,
		resource: automationInvocationsPerDayResource,
		day,
		count: 0,
	})

	const retried = await invokeWebhook(env, token, idempotencyKey)
	expect(retried.status).toBe(200)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('execute_unique_workers_per_day flood does not burn automation_invocations_per_day', async () => {
	invalidateSeededInvokeContract()
	const { env } = createEnvWithUserMeter(createDatabase())
	const userId = ownerIdFromStored('user-123')

	for (let i = 0; i < 3; i++) await consumeExecuteCall(env, userId)

	expect(
		await readMeter(env, userId, 'execute_unique_workers_per_day'),
	).toMatchObject({
		outcome: 'ready',
		count: 3,
	})
	expect(
		await readCount(env, userId, automationInvocationsPerDayResource),
	).toBe(0)
})

test('an empty Pro wallet past the monthly include gets a 429 stop before sandbox work', async () => {
	const { env, token } = prepareSuccessfulExport()
	entitlementServiceMock.stopPastInclude = true
	try {
		const denied = await invokeWebhook(env, token, 'automation-past-include')
		expect(denied.status).toBe(429)
		expect(denied.body).toMatchObject({
			ok: false,
			error: {
				code: computeOverageLimitErrorCode,
				details: {
					code: computeOverageLimitErrorCode,
					resource: 'unique_worker_days',
					plan: 'pro',
					limit: 350,
					current: 351,
					creditsStatus: 'add_credits',
				},
			},
		})
		expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	} finally {
		entitlementServiceMock.stopPastInclude = false
	}
})
