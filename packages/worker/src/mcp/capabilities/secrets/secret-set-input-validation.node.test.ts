import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as observability from '#mcp/observability.ts'
import { secretSetCapability } from './secret-set.ts'
import { secretSetManyCapability } from './secret-set-many.ts'

function createCapabilityContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
}

async function expectParseInputCallerError(args: {
	capability: typeof secretSetCapability | typeof secretSetManyCapability
	input: Record<string, unknown>
}) {
	const logSpy = vi.spyOn(observability, 'logMcpEvent')
	const error = await args.capability
		.handler(args.input, createCapabilityContext())
		.catch((caught: unknown) => caught)

	const failure = logSpy.mock.calls
		.map(([event]) => event)
		.find(
			(event) =>
				event.capabilityName === args.capability.name &&
				event.outcome === 'failure',
		)
	logSpy.mockRestore()
	return { error, failure, capabilityName: args.capability.name }
}

test('secretSet and secretSetMany reject invalid scopes without exposing values', async () => {
	const secretValue = 'hunter2-should-never-echo'
	const secretSet = await expectParseInputCallerError({
		capability: secretSetCapability,
		input: { name: 'api-key', scope: 'not-a-scope', value: secretValue },
	})
	const secretSetMany = await expectParseInputCallerError({
		capability: secretSetManyCapability,
		input: {
			secrets: [{ name: 'api-key', scope: 'not-a-scope', value: secretValue }],
		},
	})
	for (const failure of [secretSet, secretSetMany]) {
		expect(failure.error).toBeInstanceOf(McpCallerError)
		expect(failure.error).not.toBeInstanceOf(z.ZodError)
		expect(failure.error).toMatchObject({
			message: expect.stringContaining(
				`Invalid input for capability "${failure.capabilityName}".`,
			),
		})
		const errorMessage =
			failure.error instanceof Error
				? failure.error.message
				: String(failure.error)
		expect(errorMessage).not.toContain(secretValue)
		expect(failure.failure).toMatchObject({
			failurePhase: 'parse_input',
			errorName: 'McpCallerError',
		})
	}
})
