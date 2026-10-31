import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listWebhooksForUser: vi.fn(),
	mintWebhookUrlForUser: vi.fn(),
	rotateWebhookUrlForUser: vi.fn(),
	applyWebhookUrlForUser: vi.fn(),
	resolveSavedPackage: vi.fn(),
	getWebhookEndpointByKey: vi.fn(),
	listRunRecords: vi.fn(),
}))

vi.mock('#worker/webhooks/service.ts', () => ({
	listWebhooksForUser: (...args: Array<unknown>) =>
		mockModule.listWebhooksForUser(...args),
	mintWebhookUrlForUser: (...args: Array<unknown>) =>
		mockModule.mintWebhookUrlForUser(...args),
	rotateWebhookUrlForUser: (...args: Array<unknown>) =>
		mockModule.rotateWebhookUrlForUser(...args),
	applyWebhookUrlForUser: (...args: Array<unknown>) =>
		mockModule.applyWebhookUrlForUser(...args),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackage(...args),
}))

vi.mock('#worker/webhooks/repo.ts', () => ({
	getWebhookEndpointByKey: (...args: Array<unknown>) =>
		mockModule.getWebhookEndpointByKey(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
}))

const approvalMock = vi.hoisted(() => ({
	requireWebhookApplyDestinationGrantOrPending: vi.fn(),
}))

vi.mock('#worker/webhooks/apply-destination-approval.ts', () => ({
	requireWebhookApplyDestinationGrantOrPending: (...args: Array<unknown>) =>
		approvalMock.requireWebhookApplyDestinationGrantOrPending(...args),
}))

const { webhookListCapability } = await import('./webhook-list.ts')
const { webhookUrlMintCapability } = await import('./webhook-url-mint.ts')
const { webhookUrlRotateCapability } = await import('./webhook-url-rotate.ts')
const { webhookUrlApplyCapability, webhookUrlApplyDestinationSchema } =
	await import('./webhook-url-apply.ts')
const { webhookDeliveryListCapability } =
	await import('./webhook-delivery-list.ts')

const sentry = { kodyId: 'sentry-bridge', webhookName: 'sentry' }

function createCapabilityContext(
	executionOrigin: 'interactive' | 'background' = 'interactive',
) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin,
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
				username: 'user',
			},
		}),
	}
}

function mockSavedWebhook(webhookName = 'sentry') {
	mockModule.resolveSavedPackage.mockResolvedValue({
		id: 'pkg-1',
		kodyId: 'sentry-bridge',
		name: '@user/sentry-bridge',
		userId: ownerIdFromStored('user-1'),
		sourceId: 'src-1',
	})
	mockModule.getWebhookEndpointByKey.mockResolvedValue(
		endpoint({ webhookName }),
	)
}

function endpoint(overrides: Record<string, unknown> = {}) {
	return {
		id: 'ep-1',
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		webhookName: 'sentry',
		urlSecretHash: 'hash',
		createdAt: '2026-07-24T00:00:00.000Z',
		rotatedAt: '2026-07-24T00:00:00.000Z',
		...overrides,
	}
}

function mintedUrl(overrides: Record<string, unknown> = {}) {
	return {
		packageId: 'pkg-1',
		packageKodyId: 'sentry-bridge',
		name: 'sentry',
		endpointId: 'ep-1',
		instanceLabel: null,
		handle: 'whh_ep-1',
		urlHost: 'heykody.dev',
		createdAt: '2026-07-24T00:00:00.000Z',
		rotatedAt: '2026-07-24T00:00:00.000Z',
		previousUrlActiveUntil: null,
		approvalUrl:
			'https://heykody.dev/@owner/sentry-bridge/approve-credentials?enable=webhook%3Asentry%3Aep-1',
		...overrides,
	}
}

function makeWebhookRun(input: {
	id: string
	name?: string
	status?: 'success' | 'error'
	startedAt: string
	metadata: Record<string, unknown>
	errorMessage?: string | null
}) {
	return {
		id: input.id,
		surface: 'webhook' as const,
		status: input.status ?? 'success',
		name: input.name ?? 'sentry',
		packageId: 'pkg-1',
		kodyId: 'sentry-bridge',
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: input.startedAt,
		finishedAt: input.startedAt,
		durationMs: 0,
		errorName: input.errorMessage ? 'Error' : null,
		errorMessage: input.errorMessage ?? null,
		metadata: input.metadata,
		logCount: 0,
	}
}

test('webhook capabilities expose mint once and never leak secrets on list', async () => {
	const listedRow = {
		packageId: 'pkg-1',
		packageKodyId: 'sentry-bridge',
		packageName: '@user/sentry-bridge',
		description: null,
		responseMode: 'ack',
		inputMode: 'request',
		rateLimitPerMinute: 60,
		replay: null,
	}
	mockModule.listWebhooksForUser.mockResolvedValue([
		{
			...listedRow,
			...mintedUrl(),
			exportName: './handle-sentry-webhook',
			verification: {
				type: 'hmac-sha256',
				header: 'sentry-hook-signature',
				secretName: 'sentryWebhookSecret',
				encoding: 'hex',
			},
			challenge: {
				type: 'subscription-challenge',
				method: 'GET',
				challenge: { in: 'query', key: 'hub.challenge' },
				when: { query: { 'hub.mode': 'subscribe' } },
				prove: {
					kind: 'verify-token',
					in: 'query',
					key: 'hub.verify_token',
					secretName: 'metaVerify',
					required: true,
				},
				respond: { as: 'text' },
			},
			minted: true,
			approved: false,
		},
		{
			...listedRow,
			name: 'unchallenged',
			exportName: './handle-unchallenged',
			verification: null,
			challenge: null,
			minted: false,
			endpointId: null,
			instanceLabel: null,
			handle: null,
			urlHost: null,
			createdAt: null,
			rotatedAt: null,
			previousUrlActiveUntil: null,
			approved: false,
			approvalUrl: null,
		},
	])
	mockModule.mintWebhookUrlForUser.mockResolvedValue(mintedUrl())
	mockModule.rotateWebhookUrlForUser.mockResolvedValue(
		mintedUrl({
			rotatedAt: '2026-07-24T01:00:00.000Z',
			previousUrlActiveUntil: '2026-07-25T01:00:00.000Z',
		}),
	)
	mockSavedWebhook()
	mockModule.listRunRecords.mockResolvedValue({
		runs: [
			{
				...makeWebhookRun({
					id: 'del-1',
					startedAt: '2026-07-24T01:00:00.000Z',
					metadata: {
						outcome: 'delivered',
						http_status: 202,
						payload_bytes: 10,
					},
				}),
				finishedAt: '2026-07-24T01:00:01.000Z',
				durationMs: 1000,
			},
		],
		nextCursor: null,
	})

	const ctx = createCapabilityContext()
	const listed = await webhookListCapability.handler({}, ctx)
	expect(listed.webhooks[0]).toMatchObject({
		minted: true,
		approved: false,
		approval_url:
			'https://heykody.dev/@owner/sentry-bridge/approve-credentials?enable=webhook%3Asentry%3Aep-1',
		handle: 'whh_ep-1',
		previous_url_active_until: null,
		challenge: {
			type: 'subscription-challenge',
			prove: {
				kind: 'verify-token',
				secretName: 'metaVerify',
				required: true,
			},
		},
	})
	expect(listed.webhooks[1]?.challenge).toBeNull()
	expect(JSON.stringify(listed)).not.toContain('secret-once')

	const minted = await webhookUrlMintCapability.handler(sentry, ctx)
	expect(minted.webhook.handle).toBe('whh_ep-1')
	expect(minted.webhook.url_host).toBe('heykody.dev')
	expect(minted.webhook).not.toHaveProperty('url')
	expect(minted.webhook).not.toHaveProperty('url_secret')
	expect(minted.webhook.approval_url).toBe(
		'https://heykody.dev/@owner/sentry-bridge/approve-credentials?enable=webhook%3Asentry%3Aep-1',
	)

	const rotated = await webhookUrlRotateCapability.handler(sentry, ctx)
	expect(rotated.webhook.handle).toBe('whh_ep-1')
	expect(rotated.webhook.previous_url_active_until).toBe(
		'2026-07-25T01:00:00.000Z',
	)
	expect(rotated.webhook).not.toHaveProperty('url_secret')

	mockModule.applyWebhookUrlForUser.mockResolvedValue({
		ok: true,
		urlHost: 'heykody.dev',
		httpStatus: 201,
		remoteId: '4242',
		error: null,
	})
	const githubHooksDestination = {
		type: 'http' as const,
		url: 'https://api.github.com/repos/acme/api/hooks',
		method: 'POST' as const,
		headers: {
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'User-Agent': 'kody',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		body: JSON.stringify({
			name: 'web',
			active: true,
			events: ['push', 'pull_request'],
			config: {
				url: '{{webhookUrl}}',
				content_type: 'json',
				insecure_ssl: '0',
			},
		}),
		integration: 'github',
	}
	approvalMock.requireWebhookApplyDestinationGrantOrPending.mockResolvedValue({
		status: 'granted',
		fingerprint: 'fp-github-hooks',
		credentialId: null,
	})
	await expect(
		webhookUrlApplyCapability.handler(
			{ handle: 'whh_ep-1', destination: githubHooksDestination },
			ctx,
		),
	).resolves.toMatchObject({
		ok: true,
		http_status: 201,
	})
	expect(mockModule.applyWebhookUrlForUser).toHaveBeenCalledWith(
		expect.objectContaining({
			handle: 'whh_ep-1',
		}),
	)
	const destinationCases = [
		[
			{
				url: 'https://hooks.example/register',
				body: '{"url":"{{webhookUrl}}"}',
			},
			true,
		],
		[{ url: 'https://hooks.example/register', body: '{"ok":true}' }, false],
		[
			{
				url: 'http://hooks.example/register',
				body: '{"url":"{{webhookUrl}}"}',
			},
			false,
		],
		[
			{
				type: 'https',
				url: 'https://attacker.example/exfil',
				body: '{"url":"{{webhookUrl}}"}',
			},
			false,
		],
		[githubHooksDestination, true],
	] as const
	expect(
		destinationCases.filter(
			([destination, valid]) =>
				webhookUrlApplyDestinationSchema.safeParse({
					type: 'http',
					...destination,
				}).success !== valid,
		),
	).toEqual([])

	const deliveries = await webhookDeliveryListCapability.handler(sentry, ctx)
	expect(deliveries.deliveries).toMatchObject([
		{ id: 'del-1', outcome: 'delivered', http_status: 202 },
	])
	expect(mockModule.listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			filter: { surface: 'webhook', packageId: 'pkg-1', name: 'sentry' },
		}),
	)
})

test('webhookDeliveryList pushes the name filter, round-trips outcomes, and treats missing packages and unminted URLs as caller errors', async () => {
	const ctx = createCapabilityContext()
	mockSavedWebhook('alpha')
	const limit = 10
	mockModule.listRunRecords.mockResolvedValue({
		runs: Array.from({ length: limit }, (_, index) =>
			makeWebhookRun({
				id: `alpha-${index}`,
				name: 'alpha',
				startedAt: `2026-07-24T02:${String(index).padStart(2, '0')}:00.000Z`,
				metadata: { outcome: 'delivered', httpStatus: 202, payloadBytes: 8 },
			}),
		),
		nextCursor: null,
	})
	const page = await webhookDeliveryListCapability.handler(
		{ kodyId: 'sentry-bridge', webhookName: 'alpha', limit },
		ctx,
	)
	expect(page.deliveries).toHaveLength(limit)
	expect(page.deliveries.every((row) => row.webhook_name === 'alpha')).toBe(
		true,
	)
	expect(mockModule.listRunRecords).toHaveBeenCalledTimes(1)
	expect(mockModule.listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			filter: { surface: 'webhook', packageId: 'pkg-1', name: 'alpha' },
		}),
	)

	mockSavedWebhook()
	mockModule.listRunRecords.mockResolvedValue({
		runs: [
			['delivered-1', 'delivered', 202, '03', null],
			['rejected-1', 'rejected', 401, '02', 'invalid_signature'],
			['failed-1', 'failed', 502, '01', 'invocation_failed'],
		].map(([id, outcome, httpStatus, hour, errorMessage]) =>
			makeWebhookRun({
				id: String(id),
				status: errorMessage ? 'error' : 'success',
				startedAt: `2026-07-24T${hour}:00:00.000Z`,
				metadata: { outcome, httpStatus, payloadBytes: 1 },
				errorMessage: errorMessage as string | null,
			}),
		),
		nextCursor: null,
	})
	const outcomes = await webhookDeliveryListCapability.handler(
		{ ...sentry, limit: 50 },
		ctx,
	)
	expect(outcomes.deliveries.map((row) => [row.id, row.outcome])).toEqual([
		['delivered-1', 'delivered'],
		['rejected-1', 'rejected'],
		['failed-1', 'failed'],
	])

	mockModule.listRunRecords.mockClear()
	mockModule.getWebhookEndpointByKey.mockClear()
	mockModule.resolveSavedPackage.mockResolvedValue(null)
	await expect(
		webhookDeliveryListCapability.handler(
			{ packageId: 'missing-pkg', webhookName: 'sentry' },
			ctx,
		),
	).rejects.toBeInstanceOf(McpCallerError)
	expect(mockModule.getWebhookEndpointByKey).not.toHaveBeenCalled()
	expect(mockModule.listRunRecords).not.toHaveBeenCalled()

	mockSavedWebhook()
	mockModule.getWebhookEndpointByKey.mockResolvedValue(null)
	await expect(
		webhookDeliveryListCapability.handler(sentry, ctx),
	).rejects.toBeInstanceOf(McpCallerError)
	expect(mockModule.listRunRecords).not.toHaveBeenCalled()
})

test('webhookUrlApply http destination requires owner website approval before outbound registration', async () => {
	const destination = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		headers: { 'Content-Type': 'application/json' },
		body: '{"url":"{{webhookUrl}}"}',
		secretName: 'hooksRegistrationToken',
	}
	const approvalUrl =
		'https://heykody.dev/connect/webhook-apply?handle=whh_ep-1&fingerprint=fp-1'
	expect(webhookUrlApplyDestinationSchema.safeParse(destination).success).toBe(
		true,
	)
	approvalMock.requireWebhookApplyDestinationGrantOrPending.mockResolvedValue({
		status: 'approval_required',
		fingerprint: 'fp-1',
		approvalUrl,
		destination: {
			method: 'POST',
			url: destination.url,
			headers: [{ name: 'Content-Type', value: 'application/json' }],
			body: destination.body,
			secretName: destination.secretName,
			integration: null,
			injectionSites: ['body'],
			auth: 'secretName=hooksRegistrationToken',
		},
		message: `HTTP webhookUrlApply requires owner approval\n\napproval_url: ${approvalUrl}\nmethod: POST\nurl: ${destination.url}`,
	})
	const input = { handle: 'whh_ep-1', destination }

	const approvalRequired = await webhookUrlApplyCapability
		.handler(input, createCapabilityContext())
		.catch((error: unknown) => error)
	expect(approvalRequired).toBeInstanceOf(Error)
	expect(String(approvalRequired)).toMatch(/approval_url:/)
	expect(String(approvalRequired)).toContain('/connect/webhook-apply')
	expect(String(approvalRequired)).toContain('https://hooks.example/register')
	expect(mockModule.applyWebhookUrlForUser).not.toHaveBeenCalled()

	await expect(
		webhookUrlApplyCapability.handler(
			input,
			createCapabilityContext('background'),
		),
	).rejects.toThrow(/interactive/)
	expect(mockModule.applyWebhookUrlForUser).not.toHaveBeenCalled()

	approvalMock.requireWebhookApplyDestinationGrantOrPending.mockResolvedValue({
		status: 'granted',
		fingerprint: 'fp-1',
		credentialId: null,
	})
	mockModule.applyWebhookUrlForUser.mockResolvedValue({
		ok: true,
		urlHost: 'heykody.dev',
		httpStatus: 200,
		remoteId: 'reg-1',
		error: null,
	})
	await expect(
		webhookUrlApplyCapability.handler(input, createCapabilityContext()),
	).resolves.toEqual({
		ok: true,
		url_host: 'heykody.dev',
		http_status: 200,
		remote_id: 'reg-1',
		error: null,
	})
	expect(mockModule.applyWebhookUrlForUser).toHaveBeenCalledWith(
		expect.objectContaining({ handle: 'whh_ep-1', destination }),
	)
	expect(
		mockModule.applyWebhookUrlForUser.mock.calls.at(-1)?.[0].destination,
	).not.toHaveProperty('user_confirmed')
})
