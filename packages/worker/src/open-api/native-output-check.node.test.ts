import { expect, test, vi } from 'vitest'
import { z } from 'zod'
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
