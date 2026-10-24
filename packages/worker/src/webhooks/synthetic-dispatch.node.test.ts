import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import type * as InfrastructureCodes from '#worker/package-invocations/infrastructure-codes.ts'
import type * as PackageManifest from '#worker/package-registry/manifest.ts'
import type * as WebhookDelivery from './delivery.ts'
import type * as WebhookHeaders from './headers.ts'
import type * as WebhookParams from './params.ts'

const mocks = vi.hoisted(() => ({
	resolveSavedPackage: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	listPackageWebhooks: vi.fn(),
	getWebhookEndpointByKey: vi.fn(),
	dispatchWebhookInvocation: vi.fn(),
	readWebhookInvocationResult: vi.fn<
		typeof WebhookDelivery.readWebhookInvocationResult
	>((body) =>
		body && typeof body === 'object'
			? (body as Record<string, unknown>)['result']
			: undefined,
	),
	recordWebhookDelivery: vi.fn(),
	readPreExecutionPackageInvocationInfrastructureCode: vi.fn<
		typeof InfrastructureCodes.readPreExecutionPackageInvocationInfrastructureCode
	>(() => null),
	collectSafeWebhookHeaders: vi.fn<
		typeof WebhookHeaders.collectSafeWebhookHeaders
	>(() => ({
		'content-type': 'application/json',
	})),
	buildWebhookExportParams: vi.fn<
		typeof WebhookParams.buildWebhookExportParams
	>((input) => ({
		webhook: {
			packageKodyId: input.packageKodyId,
			name: input.webhookName,
			receivedAt: input.receivedAt,
		},
		request: {
			method: 'POST',
			contentType: 'application/json',
			headers: { 'content-type': 'application/json' },
			body: input.bodyText,
			json: input.bodyText ? JSON.parse(input.bodyText) : null,
		},
	})),
	resolveWebhookParamsModeFirstArg: vi.fn<
		typeof WebhookParams.resolveWebhookParamsModeFirstArg
	>((json) => {
		if (!json || typeof json !== 'object' || Array.isArray(json)) {
			return { ok: false as const, code: 'invalid_params' as const }
		}
		return { ok: true as const, params: json as Record<string, unknown> }
	}),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('#worker/package-registry/manifest.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageManifest>()),
	listPackageWebhooks: (...args: Array<unknown>) =>
		mocks.listPackageWebhooks(...args),
}))

vi.mock('./repo.ts', () => ({
	getWebhookEndpointByKey: (...args: Array<unknown>) =>
		mocks.getWebhookEndpointByKey(...args),
	getWebhookEndpointByIdForUser: vi.fn(),
	listWebhookEndpointsForUser: vi.fn(),
	setWebhookEndpointEnabled: vi.fn(),
	upsertWebhookEndpointSecret: vi.fn(),
}))

vi.mock('./delivery.ts', () => ({
	dispatchWebhookInvocation: (...args: Array<unknown>) =>
		mocks.dispatchWebhookInvocation(...args),
	readWebhookInvocationResult: (
		...args: Parameters<typeof WebhookDelivery.readWebhookInvocationResult>
	) => mocks.readWebhookInvocationResult(...args),
	recordWebhookDelivery: (...args: Array<unknown>) =>
		mocks.recordWebhookDelivery(...args),
}))

vi.mock('#worker/package-invocations/infrastructure-codes.ts', () => ({
	readPreExecutionPackageInvocationInfrastructureCode: (
		...args: Parameters<
			typeof InfrastructureCodes.readPreExecutionPackageInvocationInfrastructureCode
		>
	) => mocks.readPreExecutionPackageInvocationInfrastructureCode(...args),
}))

vi.mock('./headers.ts', () => ({
	collectSafeWebhookHeaders: (
		...args: Parameters<typeof WebhookHeaders.collectSafeWebhookHeaders>
	) => mocks.collectSafeWebhookHeaders(...args),
}))

vi.mock('./params.ts', () => ({
	buildWebhookExportParams: (
		...args: Parameters<typeof WebhookParams.buildWebhookExportParams>
	) => mocks.buildWebhookExportParams(...args),
	resolveWebhookParamsModeFirstArg: (
		...args: Parameters<typeof WebhookParams.resolveWebhookParamsModeFirstArg>
	) => mocks.resolveWebhookParamsModeFirstArg(...args),
}))

const { dispatchSyntheticWebhookForUser } = await import('./service.ts')

type DispatchInput = Parameters<typeof dispatchSyntheticWebhookForUser>[0]

function declaredHook(extra: Record<string, unknown> = {}) {
	return {
		name: 'hook',
		exportName: './handle-hook',
		description: null,
		responseMode: 'ack',
		inputMode: 'request',
		rateLimitPerMinute: 60,
		verification: null,
		replay: null,
		challenge: null,
		...extra,
	}
}

function mockPackage(
	input: { inputMode?: 'request' | 'params'; minted?: boolean } = {},
) {
	mocks.resolveSavedPackage.mockResolvedValue({
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
		kodyId: 'demo',
		name: '@user/demo',
	})
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: { name: '@user/demo' },
	})
	mocks.listPackageWebhooks.mockReturnValue([
		declaredHook({ inputMode: input.inputMode ?? 'request' }),
	])
	mocks.getWebhookEndpointByKey.mockResolvedValue(
		input.minted === false
			? null
			: {
					id: 'endpoint-1',
					userId: ownerIdFromStored('user-1'),
					packageId: 'pkg-1',
					webhookName: 'hook',
					enabled: true,
				},
	)
	mocks.dispatchWebhookInvocation.mockResolvedValue({
		status: 200,
		body: { result: { ok: true } },
	})
	mocks.recordWebhookDelivery.mockResolvedValue({ id: 'run-1' })
}

function dispatch(input: Partial<DispatchInput>) {
	return dispatchSyntheticWebhookForUser({
		env: { APP_DB: {} } as Env,
		requestContext: sessionRequestContext('user-1'),
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://heykody.dev',
		kodyId: 'demo',
		webhookName: 'hook',
		...input,
	} as DispatchInput)
}

test('dispatchSyntheticWebhookForUser stamps request and params fixtures synthetic: true', async () => {
	mockPackage({ inputMode: 'request' })

	const result = await dispatch({
		request: { json: { hello: 'world' }, headers: { 'x-test': '1' } },
	})

	expect(result).toMatchObject({
		packageId: 'pkg-1',
		packageKodyId: 'demo',
		webhookName: 'hook',
		inputMode: 'request',
		synthetic: true,
		status: 200,
		runId: 'run-1',
		result: { ok: true },
	})
	expect(result.idempotencyKey).toMatch(/^synthetic:/)
	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledWith(
		expect.objectContaining({
			exportName: './handle-hook',
			endpoint: expect.objectContaining({ id: 'endpoint-1' }),
			params: expect.objectContaining({
				synthetic: true,
				webhook: expect.objectContaining({
					packageKodyId: 'demo',
					name: 'hook',
				}),
				request: expect.objectContaining({ json: { hello: 'world' } }),
			}),
		}),
	)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			synthetic: true,
			outcome: 'delivered',
			kodyId: 'demo',
		}),
	)

	mocks.dispatchWebhookInvocation.mockClear()
	mockPackage({ inputMode: 'params' })
	await dispatch({
		kodyId: undefined,
		packageId: 'pkg-1',
		params: {
			route: 'discord',
			dryRun: true,
			params: { text: 'hi' },
			synthetic: false,
		},
	})

	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledWith(
		expect.objectContaining({
			params: {
				route: 'discord',
				dryRun: true,
				params: { text: 'hi' },
				synthetic: true,
			},
		}),
	)
})

test('dispatchSyntheticWebhookForUser rejects unminted, mismatched, foreign, and oversized fixtures', async () => {
	mockPackage({ minted: false })
	await expect(dispatch({ request: { json: {} } })).rejects.toThrow(
		McpCallerError,
	)

	mockPackage({ inputMode: 'request' })
	await expect(dispatch({ params: { ok: true } })).rejects.toThrow(
		/inputMode "request"/,
	)

	mocks.resolveSavedPackage.mockResolvedValue(null)
	await expect(
		dispatch({
			userId: ownerIdFromStored('other-user'),
			request: { json: {} },
		}),
	).rejects.toThrow(/not found for this user/)

	mockPackage({ inputMode: 'request' })
	mocks.dispatchWebhookInvocation.mockClear()
	await expect(
		dispatch({ request: { body: 'x'.repeat(1_048_577) } }),
	).rejects.toThrow(/payload limit/)
	expect(mocks.dispatchWebhookInvocation).not.toHaveBeenCalled()
})

test('dispatchSyntheticWebhookForUser forwards declared verification headers like ingress', async () => {
	mockPackage({ inputMode: 'request' })
	mocks.listPackageWebhooks.mockReturnValue([
		declaredHook({
			verification: {
				type: 'hmac-sha256',
				header: 'x-acme-signature',
				secretName: 'acmeWebhookSecret',
				encoding: 'hex',
			},
			replay: {
				timestampHeader: 'x-acme-timestamp',
				deliveryIdHeader: 'x-acme-delivery',
			},
			challenge: undefined,
		}),
	])

	await dispatch({
		request: {
			json: { ok: true },
			headers: {
				'x-acme-signature': 'sig',
				'x-acme-timestamp': '1',
				'x-acme-delivery': 'd1',
			},
		},
	})

	expect(mocks.collectSafeWebhookHeaders).toHaveBeenCalledWith(
		expect.any(Request),
		expect.arrayContaining([
			'x-acme-signature',
			'x-acme-timestamp',
			'x-acme-delivery',
			'Idempotency-Key',
		]),
	)
})

test('dispatchSyntheticWebhookForUser does not re-finish a successful invoke as failed when persistence throws', async () => {
	mockPackage({ inputMode: 'params' })
	mocks.recordWebhookDelivery.mockRejectedValueOnce(
		new Error('Webhook synthetic delivery record was not persisted.'),
	)
	await expect(dispatch({ params: { ok: true } })).rejects.toThrow(
		/not persisted/,
	)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledTimes(1)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
		expect.objectContaining({ outcome: 'delivered' }),
	)
})
