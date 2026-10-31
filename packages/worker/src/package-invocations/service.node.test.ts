import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import * as credentialClientModule from '#worker/credentials/credential-client.ts'
import { CredentialClientError } from '#worker/credentials/credential-client.ts'
import type * as packageSourceModule from '#worker/package-registry/source.ts'
import {
	AccountSuspendedError,
	accountSuspendedMessage,
} from '#worker/account/account-suspension.ts'
import * as runRecords from '#worker/run-records/service.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { invokePackageExport, invokePackageSubscription } from './service.ts'
import { invalidateInvokeContractFreshness } from './invoke-contract-cache.ts'
import {
	maxStoredInvocationResponseJsonBytes,
	packageInvocationStagedOversizedFenceJson,
} from './repo.ts'
import {
	packageInvocationsRepoMockModule as repoMockModule,
	createDatabase,
	createEnv,
	createToken,
	seedPackageResolution,
} from '#worker/test-support/package-invocations.ts'

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
	loadPackageSourceRowsForUser: (
		...args: Parameters<typeof packageSourceModule.loadPackageSourceRowsForUser>
	) => repoMockModule.loadPackageSourceRowsForUser(...args),
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

const backgroundUserMocks = vi.hoisted(() => ({
	resolveBackgroundMcpUser: vi.fn(async (_db: D1Database, userId: string) => ({
		userId,
		email: 'owner@example.com',
		username: 'owner',
		displayName: 'Owner',
	})),
}))

// Every trigger runs as its enabler; here the personal org's own person.
vi.mock('#worker/enablements/run-gate.ts', () => ({
	planEnablementRuns: async (input: { orgId: string }) => ({
		runs: [
			{
				id: `enablement-${input.orgId}`,
				enabler: { userId: input.orgId, username: 'owner' },
				role: 'owner',
			},
		],
		skipped: [],
	}),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: (db: D1Database, userId: string) =>
		backgroundUserMocks.resolveBackgroundMcpUser(db, userId),
}))

type ExportRequest = Parameters<typeof invokePackageExport>[0]['request']
type Db = ReturnType<typeof createDatabase>

const directPackageFixture = {
	packageId: 'package-1',
	name: 'sample-package',
	kodyId: 'sample-package',
	description: 'Sample package',
	exportName: './run',
	entryPoint: 'src/run.ts',
}

const supplierPreflightMocks = vi.hoisted(() => ({
	isEnabled: vi.fn(async () => false),
	needs: new Map(),
}))

const loadRunNeedsSpy = vi.spyOn(
	credentialClientModule,
	'loadRunCredentialNeeds',
)
const openCredentialClientSpy = vi.spyOn(
	credentialClientModule,
	'openCredentialClient',
)

vi.mock('#worker/credentials/credential-suppliers-flag.ts', () => ({
	isPackageCredentialSuppliersEnabled: () => supplierPreflightMocks.isEnabled(),
}))

const runMock = repoMockModule.runBundledModuleWithRegistry
const fromDiscord = {
	source: 'discord-gateway',
	topic: 'discord.message.created',
}
const packageContext = {
	packageId: 'pkg-1',
	kodyId: 'discord-gateway',
	sourceId: 'source-1',
}
const source1 = {
	id: 'source-1',
	user_id: ownerIdFromStored('user-123'),
	entity_kind: 'package',
	entity_id: 'pkg-1',
	repo_id: 'repo-1',
	published_commit: 'commit-1',
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	created_at: '2026-04-27T00:00:00.000Z',
	updated_at: '2026-04-27T00:00:00.000Z',
}

function invalidateSeededInvokeContract() {
	invalidateInvokeContractFreshness({
		userId: ownerIdFromStored('user-123'),
		packageIdOrKodyIds: ['pkg-1', 'discord-gateway'],
		sourceId: 'source-1',
	})
}

function dispatchRequest(
	idempotencyKey: string,
	overrides: Partial<ExportRequest> = {},
): ExportRequest {
	return {
		packageIdOrKodyId: 'discord-gateway',
		exportName: 'dispatch-message-created',
		params: { content: 'hi' },
		idempotencyKey,
		...overrides,
	}
}

function directRunRequest(idempotencyKey: string): ExportRequest {
	return dispatchRequest(idempotencyKey, {
		packageIdOrKodyId: 'sample-package',
		exportName: 'run',
	})
}

function directRunToken() {
	return {
		...createToken({
			packageId: directPackageFixture.packageId,
			exportNames: [directPackageFixture.exportName],
		}),
		tokenId: 'direct-run-token',
		request: { kind: 'api-token', tokenId: 'direct-run-token' },
	} as unknown as ReturnType<typeof createToken>
}

function invoke(
	db: Db,
	request: ExportRequest,
	token: ReturnType<typeof createToken> = createToken(),
	signal?: AbortSignal,
) {
	return invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token,
		request,
		signal,
	})
}

function runOptionsAt(index: number) {
	return runMock.mock.calls[index]?.[4] as
		| {
				packageInvokeTools?: { invoke?: unknown }
				skipCapabilityRegistry?: boolean
				storageTools?: unknown
		  }
		| undefined
}

/**
 * Invokes with a caller signal, lets the sandbox start, then disconnects.
 * `onEnter` runs inside the sandbox before it blocks on the abort.
 */
async function invokeAndDisconnect(
	db: Db,
	request: ExportRequest,
	onEnter: () => void = () => {},
) {
	const controller = new AbortController()
	let sandboxEntered = false
	runMock.mockImplementation(
		async (
			_env: unknown,
			_caller: unknown,
			_bundle: unknown,
			_params: unknown,
			options: { signal?: AbortSignal } | undefined,
		) => {
			sandboxEntered = true
			onEnter()
			const signal = options?.signal
			await new Promise((_resolve, reject) => {
				if (!signal) {
					reject(new Error('expected the caller abort signal'))
					return
				}
				if (signal.aborted) {
					reject(signal.reason)
					return
				}
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				})
			})
			return { result: { late: true }, logs: ['should-not-win'] }
		},
	)
	const pending = invoke(db, request, createToken(), controller.signal)
	await vi.waitFor(() => {
		expect(sandboxEntered).toBe(true)
	})
	controller.abort()
	return await pending
}

beforeEach(() => {
	supplierPreflightMocks.isEnabled.mockReset()
	supplierPreflightMocks.needs = new Map()
	loadRunNeedsSpy
		.mockReset()
		.mockImplementation(async () => supplierPreflightMocks.needs)
	openCredentialClientSpy.mockReset().mockImplementation(async () => {
		throw new Error('Unexpected credential preflight')
	})
})

test('invokePackageExport executes a scoped package export successfully', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const response = await invoke(
		db,
		dispatchRequest('evt-1', { topic: 'discord.message.created' }),
	)

	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		ok: true,
		exportName: './dispatch-message-created',
		idempotency: { key: 'evt-1', replayed: false },
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(runOptionsAt(0)).toMatchObject({ packageContext })
	expect(runOptionsAt(0)).not.toHaveProperty('packageInvokeTools')
})

test('a direct run blocks before execution when a required executor credential is missing', async () => {
	const db = createDatabase()
	seedPackageResolution(directPackageFixture)
	runMock.mockReset().mockResolvedValue({ result: { ok: true }, logs: [] })
	supplierPreflightMocks.needs = new Map([
		[
			'calendar',
			{
				key: 'calendar',
				provider: 'calendar',
				description: 'Calendar access',
				multiple: false,
				supplier: 'executor',
				required: true,
			},
		],
	])
	supplierPreflightMocks.isEnabled.mockResolvedValue(true)
	openCredentialClientSpy.mockRejectedValue(
		new CredentialClientError({
			code: 'credential_unbound',
			message: 'No credential is connected.',
			retryWith: [],
		}),
	)
	const token = directRunToken()

	const response = await invoke(db, directRunRequest('direct-required'), token)

	expect(supplierPreflightMocks.isEnabled).toHaveBeenCalled()
	expect(await supplierPreflightMocks.isEnabled.mock.results[0]?.value).toBe(
		true,
	)
	expect(loadRunNeedsSpy).toHaveBeenCalled()
	expect(response.status).toBe(409)
	expect(response.body).toMatchObject({
		ok: false,
		error: {
			code: 'credential_required',
			message: expect.stringContaining('"calendar"'),
		},
	})
	expect(runMock).not.toHaveBeenCalled()
})

test('a direct run proceeds when its required executor credential is available', async () => {
	const db = createDatabase()
	seedPackageResolution(directPackageFixture)
	runMock.mockReset().mockResolvedValue({ result: { ok: true }, logs: [] })
	supplierPreflightMocks.needs = new Map([
		[
			'calendar',
			{
				key: 'calendar',
				provider: 'calendar',
				description: 'Calendar access',
				multiple: false,
				supplier: 'executor',
				required: true,
			},
		],
	])
	supplierPreflightMocks.isEnabled.mockResolvedValue(true)
	openCredentialClientSpy.mockResolvedValue({} as never)
	const token = directRunToken()

	const response = await invoke(
		db,
		directRunRequest('direct-required-connected'),
		token,
	)

	expect(response.status).toBe(200)
	expect(supplierPreflightMocks.isEnabled).toHaveBeenCalled()
	expect(loadRunNeedsSpy).toHaveBeenCalled()
	expect(openCredentialClientSpy).toHaveBeenCalledWith(
		expect.objectContaining({ packageId: 'package-1' }),
		{ key: 'calendar' },
	)
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('optional executor needs do not block a direct run', async () => {
	const db = createDatabase()
	seedPackageResolution(directPackageFixture)
	runMock.mockReset().mockResolvedValue({ result: { ok: true }, logs: [] })
	supplierPreflightMocks.needs = new Map([
		[
			'calendar',
			{
				key: 'calendar',
				provider: 'calendar',
				description: 'Calendar access',
				multiple: false,
				supplier: 'executor',
				required: false,
			},
		],
	])
	supplierPreflightMocks.isEnabled.mockResolvedValue(true)
	const token = directRunToken()

	const response = await invoke(db, directRunRequest('direct-optional'), token)

	expect(response.status).toBe(200)
	expect(loadRunNeedsSpy).toHaveBeenCalled()
	expect(openCredentialClientSpy).not.toHaveBeenCalled()
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('supplier flag off leaves required executor needs out of the direct-run gate', async () => {
	const db = createDatabase()
	seedPackageResolution(directPackageFixture)
	runMock.mockReset().mockResolvedValue({ result: { ok: true }, logs: [] })
	supplierPreflightMocks.needs = new Map([
		[
			'calendar',
			{
				key: 'calendar',
				provider: 'calendar',
				description: 'Calendar access',
				multiple: false,
				supplier: 'executor',
				required: true,
			},
		],
	])
	supplierPreflightMocks.isEnabled.mockResolvedValue(false)
	const token = directRunToken()

	const response = await invoke(db, directRunRequest('direct-flag-off'), token)

	expect(response.status).toBe(200)
	expect(loadRunNeedsSpy).not.toHaveBeenCalled()
	expect(openCredentialClientSpy).not.toHaveBeenCalled()
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('suspended owners are refused before package code loads, cannot replay stored responses, and the denial is not stored', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'stored before suspension' },
		logs: [],
	})
	const suspendNextCall = () =>
		backgroundUserMocks.resolveBackgroundMcpUser.mockRejectedValueOnce(
			new AccountSuspendedError(),
		)

	suspendNextCall()
	const refused = await invoke(
		db,
		dispatchRequest('evt-suspended', { topic: 'discord.message.created' }),
	)
	expect(refused.status).toBe(403)
	expect(refused.body).toMatchObject({
		ok: false,
		error: { code: 'account_suspended', message: accountSuspendedMessage },
	})
	expect(
		repoMockModule.loadPublishedBundleArtifactByIdentity,
	).not.toHaveBeenCalled()
	expect(runMock).not.toHaveBeenCalled()

	const request = dispatchRequest('evt-replay-while-suspended', {
		topic: 'discord.message.created',
	})
	expect((await invoke(db, request)).status).toBe(200)

	suspendNextCall()
	const whileSuspended = await invoke(db, request)
	expect(whileSuspended.status).toBe(403)
	expect(whileSuspended.body).toMatchObject({
		ok: false,
		error: { code: 'account_suspended' },
	})
	expect(JSON.stringify(whileSuspended.body)).not.toContain(
		'stored before suspension',
	)

	const afterUnsuspend = await invoke(db, request)
	expect(afterUnsuspend.status).toBe(200)
	expect(afterUnsuspend.body).toMatchObject({
		ok: true,
		idempotency: { replayed: true },
		result: { reply: 'stored before suspension' },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('invokePackageExport enforces idempotency replay, mismatch, corruption, and persistence failures', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})
	const replayRequest = dispatchRequest('evt-replay', fromDiscord)

	expect((await invoke(db, replayRequest)).status).toBe(200)
	const replaySecond = await invoke(db, replayRequest)
	expect(replaySecond.status).toBe(200)
	expect(replaySecond.body).toMatchObject({
		ok: true,
		idempotency: { key: 'evt-replay', replayed: true },
	})

	await invoke(db, dispatchRequest('evt-mismatch', fromDiscord))
	const mismatch = await invoke(
		db,
		dispatchRequest('evt-mismatch', {
			...fromDiscord,
			params: { content: 'different' },
		}),
	)
	expect(mismatch.status).toBe(409)
	expect(mismatch.body).toEqual({
		ok: false,
		error: {
			code: 'idempotency_mismatch',
			message:
				'This idempotency key has already been used for a different package invocation request.',
		},
		idempotency: { key: 'evt-mismatch', replayed: false },
	})

	const ignoreCallsBefore = runMock.mock.calls.length
	const ignoreParamsHash = (params: Record<string, unknown>) =>
		dispatchRequest('evt-delivery-ignore', {
			...fromDiscord,
			params,
			idempotencyParamsHash: 'ignore',
		})
	const ignoreFirst = await invoke(
		db,
		ignoreParamsHash({
			content: 'hi',
			receivedAt: '2026-01-01T00:00:00.000Z',
		}),
	)
	const ignoreReplay = await invoke(
		db,
		ignoreParamsHash({
			content: 'different',
			receivedAt: '2026-01-01T00:00:01.000Z',
		}),
	)
	expect(ignoreFirst.status).toBe(200)
	expect(ignoreReplay.status).toBe(200)
	expect(ignoreReplay.body).toEqual(ignoreFirst.body)
	expect(ignoreReplay.body).not.toMatchObject({
		idempotency: { replayed: true },
	})
	expect(runMock.mock.calls.length).toBe(ignoreCallsBefore + 1)

	const corruptRequest = dispatchRequest('evt-corrupt', fromDiscord)
	expect((await invoke(db, corruptRequest)).status).toBe(200)
	db.runLog.corruptStoredResponses()
	const corruptSecond = await invoke(db, corruptRequest)
	expect(corruptSecond.status).toBe(409)
	expect(corruptSecond.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_response_unavailable' },
		idempotency: { key: 'evt-corrupt', replayed: false },
	})
	expect(runMock).toHaveBeenCalledTimes(4)

	const failingDb = createDatabase({ failClaim: true })
	seedPackageResolution()
	consoleError.mockImplementation(() => {})
	const persistenceFailure = await invoke(
		failingDb,
		dispatchRequest('evt-insert-failure', fromDiscord),
	)
	expect(persistenceFailure.status).toBe(500)
	expect(persistenceFailure.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_persistence_failed' },
		idempotency: { key: 'evt-insert-failure', replayed: false },
	})
	expect(consoleError).toHaveBeenCalledWith(
		'package invocation idempotency persistence failed',
		expect.any(Error),
	)
})

test('same claimOwner reclaims a fresh in-progress claim so ack retries are not dropped', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({ result: { handled: true }, logs: ['ok'] })
	// Seed a completed row so seedFreshInvocation can clone ledger shape.
	expect(
		(await invoke(db, dispatchRequest('evt-seed-shape', { source: 'webhook' })))
			.status,
	).toBe(200)
	const deliveryId = 'delivery-ack-reclaim'
	const idempotencyKey = 'heartbeat:1:1:enablement:en-1'
	db.runLog.seedFreshInvocation(idempotencyKey, deliveryId)
	const freshRow = db.runLog.ledgerRows.find(
		(row) => row.idempotencyKey === idempotencyKey,
	)
	if (!freshRow) throw new Error('Expected seeded in-progress claim.')
	runMock.mockClear()
	runMock.mockResolvedValue({ result: { handled: true }, logs: ['retried'] })

	// Without the same claimOwner, a fresh in_progress claim blocks execution
	// for the full stale window (longer than the webhook ack retry budget).
	expect(
		await invoke(
			db,
			dispatchRequest(idempotencyKey, {
				source: 'webhook',
				claimOwner: 'other-delivery',
			}),
		),
	).toMatchObject({
		status: 409,
		body: { ok: false, error: { code: 'invocation_in_progress' } },
	})
	expect(runMock).not.toHaveBeenCalled()

	// Same owner still waits the same-owner grace (not equality alone).
	expect(
		await invoke(
			db,
			dispatchRequest(idempotencyKey, {
				source: 'webhook',
				claimOwner: deliveryId,
			}),
		),
	).toMatchObject({
		status: 409,
		body: { ok: false, error: { code: 'invocation_in_progress' } },
	})
	expect(runMock).not.toHaveBeenCalled()

	// Past the grace window, the same delivery takes over and runs.
	freshRow.updatedAt = new Date(Date.now() - 61_000).toISOString()
	expect(
		await invoke(
			db,
			dispatchRequest(idempotencyKey, {
				source: 'webhook',
				claimOwner: deliveryId,
			}),
		),
	).toMatchObject({
		status: 200,
		body: { ok: true, result: { handled: true } },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(
		db.runLog.ledgerRows.find((row) => row.idempotencyKey === idempotencyKey),
	).toMatchObject({
		status: 'completed',
		claimOwner: deliveryId,
	})
})

test('completed keyed invocation reports terminal persistence failure instead of false success', async () => {
	consoleError.mockImplementation(() => {})
	const db = createDatabase({ failFinish: true })
	seedPackageResolution()
	runMock.mockResolvedValue({ result: { handled: true }, logs: ['completed'] })
	const deliveryId = 'delivery-finish-failure'
	const request = dispatchRequest('evt-finish-failure', {
		source: 'webhook',
		topic: 'webhook:discord-gateway:message',
		claimOwner: deliveryId,
	})

	expect(await invoke(db, request)).toMatchObject({
		status: 500,
		body: { ok: false, error: { code: 'idempotency_persistence_failed' } },
	})
	const rowAfterStage = db.runLog.ledgerRows[0]
	expect(rowAfterStage?.status).toBe('in_progress')
	// Staged response is the execution fence: reclaim must not re-run even
	// after the same-owner grace.
	expect(rowAfterStage?.responseJson).toEqual(expect.any(String))
	const claimAgeMs = Date.now() - Date.parse(rowAfterStage!.updatedAt)
	expect(claimAgeMs).toBeLessThan(5_000)

	rowAfterStage!.updatedAt = new Date(Date.now() - 61_000).toISOString()
	expect(await invoke(db, request)).toMatchObject({
		status: 500,
		body: { ok: false, error: { code: 'idempotency_persistence_failed' } },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'package invocation completed-result persistence failed',
		'RunLog finish unavailable',
	)
})

test('staged completed outcome promotes without re-executing after finish recovers', async () => {
	consoleError.mockImplementation(() => {})
	const db = createDatabase({ failFinish: true })
	seedPackageResolution()
	runMock.mockResolvedValue({ result: { handled: true }, logs: ['completed'] })
	const deliveryId = 'delivery-stage-promote'
	const request = dispatchRequest('evt-stage-promote', {
		source: 'webhook',
		topic: 'webhook:discord-gateway:message',
		claimOwner: deliveryId,
	})

	expect(await invoke(db, request)).toMatchObject({
		status: 500,
		body: { ok: false, error: { code: 'idempotency_persistence_failed' } },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	const staged = db.runLog.ledgerRows[0]
	expect(staged).toMatchObject({
		status: 'in_progress',
		responseJson: expect.any(String),
	})

	// Finish recovers; promote beyond the same-owner grace without re-running.
	db.runLog.options.failFinish = false
	staged!.updatedAt = new Date(Date.now() - 61_000).toISOString()
	expect(await invoke(db, request)).toMatchObject({
		status: 200,
		body: { ok: true, result: { handled: true } },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(db.runLog.ledgerRows[0]?.status).toBe('completed')
})

test('oversized staged outcome still fences reclaim and promotes without re-executing', async () => {
	consoleError.mockImplementation(() => {})
	const db = createDatabase({ failFinish: true })
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { blob: 'x'.repeat(maxStoredInvocationResponseJsonBytes + 1) },
		logs: [],
	})
	const deliveryId = 'delivery-stage-oversized'
	const request = dispatchRequest('evt-stage-oversized', {
		source: 'webhook',
		topic: 'webhook:discord-gateway:message',
		claimOwner: deliveryId,
	})

	expect(await invoke(db, request)).toMatchObject({
		status: 500,
		body: { ok: false, error: { code: 'idempotency_persistence_failed' } },
	})
	const staged = db.runLog.ledgerRows[0]
	// Must be the non-null oversized fence — null would look reclaimable.
	expect(staged?.responseJson).toBe(packageInvocationStagedOversizedFenceJson)

	db.runLog.options.failFinish = false
	staged!.updatedAt = new Date(Date.now() - 61_000).toISOString()
	expect(await invoke(db, request)).toMatchObject({
		status: 500,
		body: { ok: false, error: { code: 'idempotency_response_unavailable' } },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(db.runLog.ledgerRows[0]).toMatchObject({
		status: 'completed',
		responseJson: null,
	})
})

test('oversized terminal responses are not stored so backups stay restorable', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		// Serialized response_json above maxStoredInvocationResponseJsonBytes.
		result: { blob: 'x'.repeat(maxStoredInvocationResponseJsonBytes + 1) },
		logs: [],
	})
	const request = dispatchRequest('evt-oversized', fromDiscord)

	// The first call still returns the live response in full.
	expect(await invoke(db, request)).toMatchObject({
		status: 200,
		body: { ok: true },
	})
	// The duplicate is deduplicated (no re-execution) but cannot replay the
	// dropped oversized response.
	const duplicate = await invoke(db, request)
	expect(duplicate.status).toBe(409)
	expect(duplicate.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_response_unavailable' },
		idempotency: { key: 'evt-oversized', replayed: false },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('invokePackageExport records request source without gating auth', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'hello trusted client' },
		logs: ['invoked'],
	})
	const anyExport = createToken({ exportNames: ['*'] })

	for (const source of ['personal-client', 'shortcuts']) {
		expect(
			await invoke(db, dispatchRequest(`evt-${source}`, { source }), anyExport),
		).toMatchObject({
			status: 200,
			body: {
				ok: true,
				exportName: './dispatch-message-created',
				source,
				result: { reply: 'hello trusted client' },
			},
		})
	}

	const unlabeled = await invoke(
		db,
		dispatchRequest('evt-unlabeled'),
		anyExport,
	)
	expect(unlabeled).toMatchObject({
		status: 200,
		body: { ok: true, result: { reply: 'hello trusted client' } },
	})
	expect(runMock).toHaveBeenCalledTimes(3)

	const scopedDeniedByExport = await invoke(
		db,
		dispatchRequest('evt-scoped-denied-export', { source: 'discord-gateway' }),
		createToken({ exportNames: ['./other-export'] }),
	)
	expect(scopedDeniedByExport).toMatchObject({
		status: 403,
		body: { ok: false, error: { code: 'export_not_allowed' } },
	})

	const deniedByPackage = await invoke(
		db,
		dispatchRequest('evt-wrong-package', { source: 'discord-gateway' }),
		createToken({ packageId: 'pkg-other', exportNames: ['*'] }),
	)
	expect(deniedByPackage).toMatchObject({
		status: 403,
		body: { ok: false, error: { code: 'package_not_allowed' } },
	})
})

test('invokePackageExport stores terminal failures for execution errors and missing exports', async () => {
	const db = createDatabase()
	seedPackageResolution()
	const fromGateway = { source: 'discord-gateway' }
	runMock.mockResolvedValue({
		error: new Error('Discord downstream failed'),
		logs: ['before-error'],
	})
	const executionFailure = await invoke(
		db,
		dispatchRequest('evt-2', fromGateway),
	)
	expect(executionFailure.status).toBe(500)
	expect(executionFailure.body).toMatchObject({
		ok: false,
		error: { code: 'execution_failed', message: 'Discord downstream failed' },
		logs: ['before-error'],
	})

	const resetCases: Array<[key: string, error: Error | string]> = [
		[
			'evt-do-reset',
			new Error('Durable Object reset because its code was updated.'),
		],
		[
			'evt-do-inactive-close',
			'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
		],
	]
	for (const [key, error] of resetCases) {
		runMock.mockResolvedValue({ error, logs: [] })
		expect(await invoke(db, dispatchRequest(key, fromGateway))).toMatchObject({
			status: 503,
			body: {
				ok: false,
				error: {
					code: 'durable_object_reset',
					message: error instanceof Error ? error.message : error,
				},
			},
		})
	}

	runMock.mockClear()
	const missingExport = () =>
		invoke(
			db,
			dispatchRequest('evt-missing-export', {
				...fromGateway,
				exportName: 'missing-export',
			}),
			createToken({ exportNames: ['./missing-export'] }),
		)
	for (const replayed of [false, true]) {
		expect(await missingExport()).toMatchObject({
			status: 404,
			body: {
				ok: false,
				error: { code: 'export_not_found' },
				idempotency: { key: 'evt-missing-export', replayed },
			},
		})
	}
	expect(runMock).not.toHaveBeenCalled()
})

test('invokePackageExport treats a missing npm-backed runtime bundle as retryable artifact prep', async () => {
	invalidateSeededInvokeContract()
	const db = createDatabase()
	seedPackageResolution()
	const missingBundleSource = {
		...source1,
		published_commit: 'commit-missing-bundle',
	}
	const manifest = {
		name: '@kentcdodds/discord-gateway',
		exports: {
			'./dispatch-message-created': './src/dispatch-message-created.ts',
		},
		kody: { id: 'discord-gateway', description: 'Discord gateway helpers' },
	}
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: missingBundleSource,
		manifest,
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	repoMockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: missingBundleSource,
		manifest,
		files: {
			'package.json': JSON.stringify({
				...manifest,
				dependencies: { kleur: '^4.1.5' },
			}),
			'src/dispatch-message-created.ts':
				'import kleur from "kleur"\nexport default async function run(){ return kleur.green("ok") }',
		},
	})

	const response = await invoke(
		db,
		dispatchRequest('evt-republish-needed', { source: 'discord-gateway' }),
	)

	expect(response.status).toBe(503)
	expect(response.body).toMatchObject({
		ok: false,
		error: {
			code: 'artifact_preparation_failed',
			message:
				'Package artifact preparation failed before execution. Please retry.',
		},
	})
	expect(repoMockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
	expect(runMock).not.toHaveBeenCalled()
	// The owner's run record keeps the real cause, not only the generic line.
	const preparationRun = [...db.runLog.runRows.values()].find(
		(row) => row['errorName'] === 'artifact_preparation_failed',
	)
	expect(preparationRun?.['errorMessage']).toMatch(
		/^Package artifact preparation failed before execution\. \S/,
	)
	expect(String(preparationRun?.['errorMessage'])).not.toBe(
		'Package artifact preparation failed before execution.',
	)
})

test('invokePackageSubscription uses the normal capability registry with package storage and source metadata intact', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: source1,
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: { entry: './src/app.ts' },
				subscriptions: {
					'email.message.received': {
						handler: './src/email-message-received.ts',
					},
				},
			},
		},
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: { id: 'artifact-subscription-1', publishedCommit: 'commit-1' },
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/email-message-received.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js':
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext,
			createdAt: '2026-04-27T00:00:00.000Z',
		},
	})
	runMock.mockResolvedValue({ result: { ok: true }, logs: [] })

	const savedPackage = {
		id: 'pkg-1',
		userId: ownerIdFromStored('user-123'),
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord gateway helpers',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
		lockedAt: null,
	}
	const params = {
		event: 'email.message.received',
		message: { id: 'message-123' },
	}
	const deliver = (messageId: string) =>
		invokePackageSubscription({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			savedPackage,
			topic: 'email.message.received',
			params,
			idempotencyKey: `email:${messageId}:pkg-1:email.message.received`,
			source: 'email',
			request: {
				kind: 'inbound-email',
				sourceId: 'inbox-1',
				sender: { kind: 'inbox-owner' },
			},
		})

	expect((await deliver('message-123')).status).toBe(200)
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(runMock).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			baseUrl: 'https://kody.dev',
			user: expect.objectContaining({
				userId: ownerIdFromStored('user-123'),
				email: 'owner@example.com',
				displayName: 'Owner',
			}),
			storageContext: {
				sessionId: null,
				appId: 'pkg-1',
				packageId: 'pkg-1',
				storageId: 'package:pkg-1',
			},
			repoContext: expect.objectContaining({ sourceId: 'source-1' }),
		}),
		expect.anything(),
		params,
		expect.objectContaining({ packageContext }),
	)
	const runOptions = runOptionsAt(0)
	expect(runOptions).toMatchObject({ runSurface: 'subscription' })
	expect(runOptions?.skipCapabilityRegistry).toBeUndefined()
	// Package invocation runs no longer bind ambient `storage`: the package
	// bucket is reached via packageStorage(), granted through packageContext.
	expect(runOptions?.storageTools).toBeUndefined()

	const enablementSuffix = `:enablement:enablement-${savedPackage.userId}`
	db.runLog.seedStaleInvocation(
		`email:message-stale:pkg-1:email.message.received${enablementSuffix}`,
	)
	expect((await deliver('message-stale')).status).toBe(200)
	expect(runMock).toHaveBeenCalledTimes(2)

	const freshKey = `email:message-fresh:pkg-1:email.message.received${enablementSuffix}`
	db.runLog.seedFreshInvocation(freshKey)
	const completionTimer = setTimeout(() => {
		db.runLog.completeInvocation(freshKey)
	}, 150)
	try {
		expect((await deliver('message-fresh')).status).toBe(200)
		expect(runMock).toHaveBeenCalledTimes(2)
	} finally {
		clearTimeout(completionTimer)
	}

	// The commit-keyed artifact cache is warm from the invocations above and
	// would absorb the injected KV failure; bump the published commit so the
	// commit-tier key is cold, matching a same-isolate republish.
	invalidateSeededInvokeContract()
	const transientSource = {
		...source1,
		published_commit: 'commit-transient',
	}
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: transientSource,
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: { entry: './src/app.ts' },
				subscriptions: {
					'email.message.received': {
						handler: './src/email-message-received.ts',
					},
				},
			},
		},
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockRejectedValueOnce(
		new Error('KV timeout'),
	)
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {
			id: 'artifact-subscription-1',
			publishedCommit: 'commit-transient',
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId: 'source-1',
			publishedCommit: 'commit-transient',
			entryPoint: 'src/email-message-received.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js':
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext,
			createdAt: '2026-04-27T00:00:00.000Z',
		},
	})
	expect(await deliver('message-transient')).toMatchObject({
		status: 503,
		body: { error: { code: 'artifact_preparation_failed' } },
	})
	expect((await deliver('message-transient')).status).toBe(200)
})

test('caller disconnect finishes a keyed package invocation instead of leaving it running', async () => {
	const db = createDatabase()
	seedPackageResolution()
	const hasStartedLog = () =>
		[...db.runLog.runLogs.values()].some((lines) =>
			lines.some((line) => line.startsWith('package invocation started:')),
		)
	let sawStartedLogWhileRunning = false
	const request = dispatchRequest('audit-listupcoming')

	const response = await invokeAndDisconnect(db, request, () => {
		sawStartedLogWhileRunning = hasStartedLog()
	})

	expect(sawStartedLogWhileRunning).toBe(true)
	expect(response.status).toBe(408)
	expect(response.body).toMatchObject({
		ok: false,
		error: { code: 'client_disconnected' },
		idempotency: { key: 'audit-listupcoming', replayed: false },
	})
	expect(hasStartedLog()).toBe(true)
	expect(
		[...db.runLog.runRows.values()].some(
			(row) =>
				row['status'] === 'error' && row['errorName'] === 'client_disconnected',
		),
	).toBe(true)
	expect(runMock).toHaveBeenCalledTimes(1)

	const replay = await invoke(db, request)
	expect(replay.status).toBe(408)
	expect(replay.body).toMatchObject({
		ok: false,
		error: { code: 'client_disconnected' },
		idempotency: { key: 'audit-listupcoming', replayed: true },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('disconnect finish failure still allows a terminal ledger finish', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = createDatabase()
	seedPackageResolution()
	const realFinish = runRecords.finishPackageInvocationRecord
	const finishSpy = vi
		.spyOn(runRecords, 'finishPackageInvocationRecord')
		.mockImplementationOnce(async () => {
			throw new Error('transient disconnect finish failure')
		})
		.mockImplementation((...args) => realFinish(...args))

	try {
		const response = await invokeAndDisconnect(
			db,
			dispatchRequest('disconnect-finish-fail'),
		)
		expect(response.status).not.toBe(408)
		expect(
			[...db.runLog.runRows.values()].some(
				(row) => row['status'] === 'error' || row['status'] === 'success',
			),
		).toBe(true)
		expect(
			db.runLog.ledgerRows.some(
				(row) =>
					row.idempotencyKey === 'disconnect-finish-fail' &&
					row.status !== 'in_progress',
			),
		).toBe(true)
		expect(finishSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
		expect(consoleWarn).toHaveBeenCalledWith(
			'package invocation disconnect finish failed',
			'transient disconnect finish failure',
		)
	} finally {
		finishSpy.mockRestore()
		consoleWarn.mockReset()
	}
})

test('disconnect finish fence loss returns the durable ledger response', async () => {
	const db = createDatabase()
	seedPackageResolution()
	const realFinish = runRecords.finishPackageInvocationRecord
	const winnerBody = {
		ok: true,
		result: { winner: true },
		idempotency: { key: 'disconnect-fence-loss', replayed: false },
	}
	const finishSpy = vi
		.spyOn(runRecords, 'finishPackageInvocationRecord')
		.mockImplementationOnce(async (input) => {
			// Simulate a competing terminal write winning the fence first.
			await realFinish({
				...input,
				ledgerStatus: 'completed',
				responseJson: JSON.stringify({ status: 200, body: winnerBody }),
				status: 'success',
				result: { winner: true },
				error: undefined,
			})
			return realFinish(input)
		})
	const request = dispatchRequest('disconnect-fence-loss')
	const durableReplay = {
		status: 200,
		body: {
			ok: true,
			result: { winner: true },
			idempotency: { key: 'disconnect-fence-loss', replayed: true },
		},
	}

	try {
		expect(await invokeAndDisconnect(db, request)).toMatchObject(durableReplay)
		expect(await invoke(db, request)).toMatchObject(durableReplay)
		expect(runMock).toHaveBeenCalledTimes(1)
	} finally {
		finishSpy.mockRestore()
	}
})

test('key-less invokes report the commit they resolve and refuse a moved pinned commit before running', async () => {
	const db = createDatabase()
	invalidateSeededInvokeContract()
	seedPackageResolution()
	runMock.mockReset()
	runMock.mockResolvedValue({ result: { ok: true }, logs: [] })
	const resolved: Array<string | null> = []
	const invokeKeyless = (pinnedCommit: string | null) =>
		invokePackageExport({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			token: createToken(),
			request: dispatchRequest('unused-key'),
			ephemeral: true,
			sourceRevision: {
				pinnedCommit,
				onResolved: (commit) => resolved.push(commit),
			},
		})

	const latest = await invokeKeyless(null)
	expect(latest.status).toBe(200)
	const pinnedMatch = await invokeKeyless('commit-1')
	expect(pinnedMatch.status).toBe(200)
	expect(runMock).toHaveBeenCalledTimes(2)

	const moved = await invokeKeyless('commit-0')
	expect(moved.status).toBe(409)
	expect(moved.body).toMatchObject({
		ok: false,
		error: {
			code: 'source_revision_changed',
			message: expect.stringContaining(
				'pinned to commit commit-0 but the published commit is now commit-1',
			),
		},
	})
	// Refused before any sandbox work.
	expect(runMock).toHaveBeenCalledTimes(2)
	expect(resolved).toEqual(['commit-1', 'commit-1', 'commit-1'])
})
