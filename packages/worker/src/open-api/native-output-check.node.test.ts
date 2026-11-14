import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import * as cliCredentialBootstrap from '#worker/api-tokens/cli-credential-bootstrap.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createOpenApiTestHarness } from '#worker/test-support/open-api-http.ts'
import { nativeApiOperationDefinitions } from './native-operations.ts'
import {
	assertNativeOutputMatchesSchema,
	shouldCheckNativeOutput,
} from './native-output-check.ts'

test('a native handler that drifts from its outputSchema fails under the test harness', async () => {
	const api = await createOpenApiTestHarness()
	const token = await api.mint(['org:read'])
	const ok = await api.call('GET', '/v1/tokens/current', { token })
	expect(ok.status).toBe(200)

	consoleError.mockImplementation(() => {})
	vi.spyOn(
		nativeApiOperationDefinitions.tokenGetCurrent,
		'handler',
	).mockResolvedValueOnce({ id: 'tok_drifted' })
	const drifted = await api.call('GET', '/v1/tokens/current', { token })
	expect(drifted.status).toBe(500)
	expect(consoleError).toHaveBeenCalledWith(
		'open-api-operation-failed',
		'tokenGetCurrent',
		expect.objectContaining({
			message: expect.stringContaining(
				'Native operation "tokenGetCurrent" returned a response that does not match its documented outputSchema',
			),
		}),
	)
})

test('bootstrap redeem fails under the test harness when login_org is dropped', async () => {
	const api = await createOpenApiTestHarness()
	const minted = await cliCredentialBootstrap.mintCliCredentialBootstrap({
		db: api.db,
		userId: ownerIdFromStored(api.userId),
		orgId: api.userId,
		lifetime: 'short',
	})
	const realRedeem = cliCredentialBootstrap.redeemCliCredentialBootstrap
	vi.spyOn(
		cliCredentialBootstrap,
		'redeemCliCredentialBootstrap',
	).mockImplementationOnce(async (input) => {
		const redeemed = await realRedeem(input)
		return { ...redeemed, loginOrg: undefined as never }
	})
	consoleError.mockImplementation(() => {})
	const redeemed = await api.call('POST', '/v1/tokens/bootstrap/redeem', {
		body: { code: minted.bootstrap_code },
	})
	expect(redeemed.status).toBe(500)
	expect(consoleError).toHaveBeenCalledWith(
		'open-api-request-failed',
		'/v1/tokens/bootstrap/redeem',
		expect.objectContaining({
			message: expect.stringContaining(
				'Native operation "cliCredentialBootstrapRedeem" returned a response that does not match its documented outputSchema (login_org',
			),
		}),
	)
})

test('only tests and local dev check native output', () => {
	expect(shouldCheckNativeOutput({ SENTRY_ENVIRONMENT: 'test' })).toBe(true)
	expect(shouldCheckNativeOutput({ WRANGLER_IS_LOCAL_DEV: 'true' })).toBe(true)
	expect(shouldCheckNativeOutput({ SENTRY_ENVIRONMENT: 'production' })).toBe(
		false,
	)
	expect(shouldCheckNativeOutput({ SENTRY_ENVIRONMENT: 'preview' })).toBe(false)
	expect(shouldCheckNativeOutput({})).toBe(false)
})

test('names each drifted field in the error', () => {
	const outputSchema = z.object({
		content: z.array(z.unknown()),
		isError: z.boolean(),
	})
	expect(() =>
		assertNativeOutputMatchesSchema({
			operationId: 'searchTool',
			outputSchema,
			result: { content: [] },
		}),
	).toThrow(/"searchTool".*isError: Invalid input: expected boolean/)
	expect(() =>
		assertNativeOutputMatchesSchema({
			operationId: 'searchTool',
			outputSchema,
			result: { content: [], isError: false },
		}),
	).not.toThrow()
})
