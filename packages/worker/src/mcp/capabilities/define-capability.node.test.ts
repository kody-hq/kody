import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { defineCapability } from './define-capability.ts'
import { defineDomain } from './define-domain.ts'

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

test('Zod capability validation failures identify the capability, fields, and repair path', async () => {
	const inputHandler = vi.fn(async () => ({ package_id: 'github' }))
	const inputCapability = defineCapability({
		name: 'packageGet',
		orgPermission: 'none',
		domain: 'packages',
		description: 'Get a package.',
		inputSchema: z.object({ package_id: z.string() }),
		outputSchema: z.object({ package_id: z.string() }),
		handler: inputHandler,
	})

	const inputError = await inputCapability
		.handler({ kody_id: 'github' }, createCapabilityContext())
		.catch((error: unknown) => error)

	expect(inputError).toBeInstanceOf(McpCallerError)
	expect(inputError).toMatchObject({
		cause: expect.any(z.ZodError),
	})
	expect(inputHandler).not.toHaveBeenCalled()

	const outputHandler = vi.fn(async () => ({ package_id: 123 }) as never)
	const outputCapability = defineCapability({
		name: 'packageSave',
		orgPermission: 'none',
		domain: 'packages',
		description: 'Save a package.',
		inputSchema: z.object({ package_id: z.string() }),
		outputSchema: z.object({ package_id: z.string() }),
		handler: outputHandler,
	})

	const outputError = await outputCapability
		.handler({ package_id: 'github' }, createCapabilityContext())
		.catch((error: unknown) => error)

	expect(outputHandler).toHaveBeenCalledOnce()
	expect(outputError).toBeInstanceOf(Error)
	expect(outputError).not.toBeInstanceOf(McpCallerError)
	expect(outputError).toMatchObject({
		cause: expect.any(z.ZodError),
	})
})

test('builtin identifiers reject snake_case while MCP tool names may use it', () => {
	expect(() =>
		defineCapability({
			name: 'package_get',
			orgPermission: 'none',
			domain: 'packages',
			description: 'Get a package.',
			inputSchema: z.object({}),
			handler: async () => ({}),
		}),
	).toThrow(/camelCase/)

	expect(() =>
		defineCapability({
			name: 'package-get',
			orgPermission: 'none',
			domain: 'packages',
			description: 'Get a package.',
			inputSchema: z.object({}),
			handler: async () => ({}),
		}),
	).toThrow(/JavaScript identifier/)

	defineCapability({
		name: 'create_issue',
		orgPermission: 'none',
		domain: 'mcp:linear',
		description: 'Create an issue.',
		source: 'mcp-server',
		inputSchema: z.object({}),
		handler: async () => ({}),
	})
	expect(() =>
		defineDomain({
			name: 'mcp_servers',
			description: 'MCP servers.',
			capabilities: [],
		}),
	).toThrow(/camelCase/)
})

test('the dispatch gate checks the declared org permission before the handler runs', async () => {
	const handler = vi.fn(async () => ({}))
	const gated = defineCapability({
		name: 'gatedCapability',
		orgPermission: 'package:read',
		domain: 'packages',
		description: 'Needs package:read.',
		inputSchema: z.object({}),
		handler,
	})
	const anonymous = {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: null,
		}),
	}

	await expect(gated.handler({}, anonymous)).rejects.toBeInstanceOf(
		AuthorizationError,
	)
	expect(handler).not.toHaveBeenCalled()
	await expect(gated.handler({}, createCapabilityContext())).resolves.toEqual(
		{},
	)
	expect(handler).toHaveBeenCalledTimes(1)
})
