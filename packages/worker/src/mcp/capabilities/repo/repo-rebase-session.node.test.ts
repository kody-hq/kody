import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { toRepoSessionRebaseCallerError } from '#worker/repo/repo-session-caller-error.ts'

const mocks = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mocks.repoSessionRpc(...args),
}))

vi.mock('./authorize-repo-session-package.ts', () => ({
	authorizeRepoSessionPackageWrite: async () => undefined,
}))

const { repoRebaseSessionCapability } = await import('./repo-rebase-session.ts')

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

function rebase(rebaseSession: ReturnType<typeof vi.fn>) {
	mocks.repoSessionRpc.mockReturnValue({ rebaseSession })
	return repoRebaseSessionCapability
		.handler({ session_id: 'session-1' }, createContext())
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
}

test('repoRebaseSession maps rebase conflicts to McpCallerError', async () => {
	const conflict = toRepoSessionRebaseCallerError(
		Object.assign(new Error('raw'), {
			code: 'MergeConflictError',
			data: { filepaths: ['src/client/index.ts'] },
		}),
	)!
	// DO RPC flattens Error subclasses to a plain Error with the message.
	const thrown = await rebase(
		vi.fn().mockRejectedValue(new Error(conflict.message)),
	)
	expect(thrown).toBeInstanceOf(McpCallerError)
	expect((thrown as Error).message).toBe(conflict.message)
})

test('repoRebaseSession keeps platform failures as plain errors', async () => {
	const platform = new Error('Artifacts storage read failed')
	const thrown = await rebase(vi.fn().mockRejectedValue(platform))
	expect(thrown).toBe(platform)
})
