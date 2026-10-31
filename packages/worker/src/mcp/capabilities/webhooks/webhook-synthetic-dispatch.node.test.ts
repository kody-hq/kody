import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type McpStorageContext } from '@kody-internal/shared/chat.ts'

const mocks = vi.hoisted(() => ({
	dispatchSyntheticWebhookForUser: vi.fn(),
}))

vi.mock('#worker/webhooks/service.ts', () => ({
	dispatchSyntheticWebhookForUser: (...args: Array<unknown>) =>
		mocks.dispatchSyntheticWebhookForUser(...args),
}))

const { webhookSyntheticDispatchCapability } =
	await import('./webhook-synthetic-dispatch.ts')

function createCtx(
	overrides?: Partial<{
		executionOrigin: 'interactive' | 'background'
		storageContext: McpStorageContext | null
	}>,
) {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin: overrides?.executionOrigin ?? 'interactive',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
				username: 'user',
			},
			storageContext: overrides?.storageContext ?? null,
		}),
	}
}

test('webhookSyntheticDispatch returns synthetic run metadata and rejects runtime callers', async () => {
	mocks.dispatchSyntheticWebhookForUser.mockResolvedValue({
		packageId: 'pkg-1',
		packageKodyId: 'sentry-bridge',
		webhookName: 'sentry',
		inputMode: 'request',
		synthetic: true,
		status: 200,
		runId: 'run-1',
		idempotencyKey: 'synthetic:00000000-0000-4000-8000-000000000001',
		result: { ok: true },
	})

	const requestResult = await webhookSyntheticDispatchCapability.handler(
		{
			kodyId: 'sentry-bridge',
			webhookName: 'sentry',
			request: {
				json: { action: 'created' },
				headers: { 'content-type': 'application/json' },
			},
		},
		createCtx() as never,
	)

	expect(requestResult).toMatchObject({
		package_id: 'pkg-1',
		package_kody_id: 'sentry-bridge',
		webhook_name: 'sentry',
		input_mode: 'request',
		synthetic: true,
		status: 200,
		run_id: 'run-1',
		idempotency_key: 'synthetic:00000000-0000-4000-8000-000000000001',
		result: { ok: true },
		kody_id_deprecation: expect.stringContaining('packageId: "pkg-1"'),
	})
	expect(requestResult).not.toHaveProperty('url')
	expect(requestResult).not.toHaveProperty('url_secret')
	expect(mocks.dispatchSyntheticWebhookForUser).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			kodyId: 'sentry-bridge',
			webhookName: 'sentry',
			request: {
				json: { action: 'created' },
				headers: { 'content-type': 'application/json' },
			},
		}),
	)

	mocks.dispatchSyntheticWebhookForUser.mockResolvedValue({
		packageId: 'pkg-1',
		packageKodyId: 'gateway',
		webhookName: 'message-created',
		inputMode: 'params',
		synthetic: true,
		status: 200,
		runId: 'run-2',
		idempotencyKey: 'synthetic:00000000-0000-4000-8000-000000000002',
		result: { routed: true },
	})

	const paramsResult = await webhookSyntheticDispatchCapability.handler(
		{
			packageId: 'pkg-1',
			webhookName: 'message-created',
			params: {
				route: 'discord',
				dryRun: true,
				params: { text: 'hi' },
				synthetic: true,
			},
		},
		createCtx() as never,
	)

	expect(paramsResult.input_mode).toBe('params')
	expect(paramsResult.synthetic).toBe(true)
	expect(paramsResult).not.toHaveProperty('url_secret')
	expect(mocks.dispatchSyntheticWebhookForUser).toHaveBeenCalledWith(
		expect.objectContaining({
			params: {
				route: 'discord',
				dryRun: true,
				params: { text: 'hi' },
				synthetic: true,
			},
		}),
	)

	mocks.dispatchSyntheticWebhookForUser.mockClear()
	const refusedCallers = [
		{
			ctx: createCtx({
				storageContext: {
					sessionId: null,
					packageId: 'pkg-1',
					appId: null,
					storageId: 'package:pkg-1',
				},
			}),
			error: McpCallerError,
		},
		{
			ctx: createCtx({ executionOrigin: 'background' }),
			error: /unavailable from package runtime contexts/,
		},
		{
			ctx: {
				env: { APP_DB: {} } as Env,
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://heykody.dev',
					executionOrigin: 'interactive',
					user: null,
					storageContext: null,
				}),
			},
			error: /Authenticated MCP user is required/,
		},
	]
	for (const { ctx, error } of refusedCallers) {
		await expect(
			webhookSyntheticDispatchCapability.handler(
				{ kodyId: 'demo', webhookName: 'hook', params: { ok: true } },
				ctx as never,
			),
		).rejects.toThrow(error)
	}
	expect(mocks.dispatchSyntheticWebhookForUser).not.toHaveBeenCalled()
})
