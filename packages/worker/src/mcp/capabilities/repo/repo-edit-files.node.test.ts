import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mocks.repoSessionRpc(...args),
}))

vi.mock('./authorize-repo-session-package.ts', () => ({
	authorizeRepoSessionPackageWrite: async () => undefined,
}))

const { repoEditFilesCapability } = await import('./repo-edit-files.ts')

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

const deleteMiss =
	'repo session delete edit target "src/index.js" was not found.'
const directoryMiss =
	'repo session write edit target "src" is a directory. Pass a file path (for example src/index.ts), not a folder.'

test('repoEditFiles maps structural delete and move failures to McpCallerError', async () => {
	const applyEdits = vi.fn().mockRejectedValue(new Error(deleteMiss))
	mocks.repoSessionRpc.mockReturnValue({ applyEdits })

	const topLevelError = await repoEditFilesCapability
		.handler(
			{
				session_id: 'session-1',
				edits: [{ kind: 'delete', path: 'src/index.js' }],
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(topLevelError).toBeInstanceOf(McpCallerError)
	expect((topLevelError as Error).message).toBe(deleteMiss)

	const nestedMessage =
		'repo session move edit source "index.ts" was not found.'
	mocks.repoSessionRpc.mockReturnValue({
		applyEdits: vi.fn().mockRejectedValue(
			new Error('Repo session applyEdits failed', {
				cause: new Error(nestedMessage),
			}),
		),
	})

	const nestedError = await repoEditFilesCapability
		.handler(
			{
				session_id: 'session-1',
				edits: [{ kind: 'move', path: 'index.ts', to: 'src/index.ts' }],
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(nestedError).toBeInstanceOf(McpCallerError)
	expect((nestedError as Error).message).toBe(nestedMessage)

	mocks.repoSessionRpc.mockReturnValue({
		applyEdits: vi.fn().mockRejectedValue(new Error(directoryMiss)),
	})
	const directoryError = await repoEditFilesCapability
		.handler(
			{
				session_id: 'session-1',
				edits: [{ kind: 'write', path: 'src', content: 'export {}\n' }],
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	expect(directoryError).toBeInstanceOf(McpCallerError)
	expect((directoryError as Error).message).toBe(directoryMiss)

	const boom = new Error('Durable Object storage unavailable')
	mocks.repoSessionRpc.mockReturnValue({
		applyEdits: vi.fn().mockRejectedValue(boom),
	})

	await expect(
		repoEditFilesCapability.handler(
			{
				session_id: 'session-1',
				edits: [{ kind: 'delete', path: 'src/index.js' }],
			},
			createContext(),
		),
	).rejects.toBe(boom)
})
