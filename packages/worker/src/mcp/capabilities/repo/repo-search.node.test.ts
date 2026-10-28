import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	buildRepoSearchEmptyPatternCallerMessage,
	buildRepoSearchInvalidRegexCallerMessage,
} from '#worker/repo/repo-session-caller-error.ts'

const mocks = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mocks.repoSessionRpc(...args),
}))

vi.mock('./authorize-repo-session-package.ts', () => ({
	authorizeRepoSessionPackageRead: async () => undefined,
}))

const { repoSearchCapability } = await import('./repo-search.ts')

function createContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-alice'),
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}
}

test('repoSearch maps invalid regex failures to McpCallerError and rethrows other errors', async () => {
	const compileMessage =
		'Invalid regular expression: /(?s).|^$/gi: Invalid group'
	const topLevel = vi
		.fn()
		.mockRejectedValue(
			new Error(buildRepoSearchInvalidRegexCallerMessage(compileMessage)),
		)
	mocks.repoSessionRpc.mockReturnValue({ search: topLevel })

	const topLevelError = await repoSearchCapability
		.handler(
			{
				session_id: 'session-1',
				pattern: '(?s).|^$',
				mode: 'regex',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(topLevelError).toBeInstanceOf(McpCallerError)
	expect((topLevelError as Error).message).toContain('invalid regex')
	expect((topLevelError as Error).message).toContain('JavaScript RegExp')

	const nestedMessage = buildRepoSearchInvalidRegexCallerMessage(
		'Invalid regular expression: /(?i)foo/: Invalid group',
	)
	const nested = vi.fn().mockRejectedValue(
		new Error('Repo session search failed', {
			cause: new Error(nestedMessage),
		}),
	)
	mocks.repoSessionRpc.mockReturnValue({ search: nested })

	const nestedError = await repoSearchCapability
		.handler(
			{
				session_id: 'session-1',
				pattern: '(?i)foo',
				mode: 'regex',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(nestedError).toBeInstanceOf(McpCallerError)
	expect((nestedError as Error).message).toBe(nestedMessage)

	const boom = new Error('Durable Object storage unavailable')
	const search = vi.fn().mockRejectedValue(boom)
	mocks.repoSessionRpc.mockReturnValue({ search })

	await expect(
		repoSearchCapability.handler(
			{
				session_id: 'session-1',
				pattern: 'hello',
			},
			createContext(),
		),
	).rejects.toBe(boom)
})

test('repoSearch rejects whitespace-only patterns at the schema boundary', async () => {
	mocks.repoSessionRpc.mockReturnValue({ search: vi.fn() })

	const error = await repoSearchCapability
		.handler(
			{
				session_id: 'session-1',
				pattern: ' ',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toContain('Invalid input for capability')
	expect((error as Error).message).toContain('pattern')
	expect(mocks.repoSessionRpc).not.toHaveBeenCalled()
})

test('repoSearch maps blank-pattern DO failures to McpCallerError', async () => {
	// Schema rejects whitespace at the boundary; pass a real pattern so the
	// handler reaches RPC and exercises DO-phrase re-wrapping (Open API / CLI /
	// in-flight DO builds that still throw). KODY-BA.
	const emptyPatternMessage = buildRepoSearchEmptyPatternCallerMessage()
	const search = vi.fn().mockRejectedValue(new Error(emptyPatternMessage))
	mocks.repoSessionRpc.mockReturnValue({ search })

	const error = await repoSearchCapability
		.handler(
			{
				session_id: 'session-1',
				pattern: 'hello',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toBe(emptyPatternMessage)

	// Legacy exact phrase from pre-KODY-BA DO builds.
	const legacy = vi
		.fn()
		.mockRejectedValue(new Error('repoSearch requires a non-empty pattern.'))
	mocks.repoSessionRpc.mockReturnValue({ search: legacy })

	const legacyError = await repoSearchCapability
		.handler(
			{
				session_id: 'session-1',
				pattern: 'hello',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(legacyError).toBeInstanceOf(McpCallerError)
	expect((legacyError as Error).message).toBe(
		'repoSearch requires a non-empty pattern.',
	)
})
