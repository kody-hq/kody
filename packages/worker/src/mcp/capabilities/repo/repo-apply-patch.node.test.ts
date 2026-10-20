import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildRepoApplyPatchParseCallerMessage } from '#worker/repo/repo-session-caller-error.ts'

const mocks = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mocks.repoSessionRpc(...args),
}))

vi.mock('./authorize-repo-session-package.ts', () => ({
	authorizeRepoSessionPackageWrite: async () => undefined,
}))

const { repoApplyPatchCapability } = await import('./repo-apply-patch.ts')

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

const malformedHunk = buildRepoApplyPatchParseCallerMessage(
	'Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@',
)
const uncleanApply = 'git apply patch did not apply cleanly to src/index.ts.'
const emptyPatch = 'git apply patch did not contain any file changes.'

test('repoApplyPatch maps malformed, unclean, and empty patch failures to McpCallerError', async () => {
	const applyPatch = vi.fn().mockRejectedValue(new Error(malformedHunk))
	mocks.repoSessionRpc.mockReturnValue({ applyPatch })

	const topLevelError = await repoApplyPatchCapability
		.handler(
			{
				session_id: 'session-1',
				patch: '@@ -8,8 +8,8 @@\nbad',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(topLevelError).toBeInstanceOf(McpCallerError)
	expect((topLevelError as Error).message).toBe(malformedHunk)

	mocks.repoSessionRpc.mockReturnValue({
		applyPatch: vi.fn().mockRejectedValue(
			new Error('Repo session applyPatch failed', {
				cause: new Error(uncleanApply),
			}),
		),
	})

	const nestedUnclean = await repoApplyPatchCapability
		.handler(
			{
				session_id: 'session-1',
				patch:
					'--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(nestedUnclean).toBeInstanceOf(McpCallerError)
	expect((nestedUnclean as Error).message).toBe(uncleanApply)

	mocks.repoSessionRpc.mockReturnValue({
		applyPatch: vi.fn().mockRejectedValue(new Error(emptyPatch)),
	})

	const emptyError = await repoApplyPatchCapability
		.handler(
			{
				session_id: 'session-1',
				// Schema requires a non-empty string; DO still reports no file changes.
				patch: 'not a unified diff',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(emptyError).toBeInstanceOf(McpCallerError)
	expect((emptyError as Error).message).toBe(emptyPatch)

	const rawDiffParse = 'Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@'
	mocks.repoSessionRpc.mockReturnValue({
		applyPatch: vi.fn().mockRejectedValue(new Error(rawDiffParse)),
	})

	const rawParseError = await repoApplyPatchCapability
		.handler(
			{
				session_id: 'session-1',
				patch: 'malformed',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(rawParseError).toBeInstanceOf(McpCallerError)
	expect((rawParseError as Error).message).toBe(rawDiffParse)

	const boom = new Error('Durable Object storage unavailable')
	mocks.repoSessionRpc.mockReturnValue({
		applyPatch: vi.fn().mockRejectedValue(boom),
	})

	await expect(
		repoApplyPatchCapability.handler(
			{
				session_id: 'session-1',
				patch: '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n',
			},
			createContext(),
		),
	).rejects.toBe(boom)
})

test('repoApplyPatch still returns a successful patch result', async () => {
	mocks.repoSessionRpc.mockReturnValue({
		applyPatch: vi.fn().mockResolvedValue({
			dryRun: false,
			totalChanged: 1,
			edits: [
				{
					path: 'src/index.ts',
					changed: true,
					content: 'export {}\n',
					diff: 'diff',
				},
			],
		}),
	})

	const result = await repoApplyPatchCapability.handler(
		{
			session_id: 'session-1',
			patch:
				'--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-\n+export {}\n',
		},
		createContext(),
	)

	expect(result).toEqual({
		dry_run: false,
		total_changed: 1,
		edits: [
			{
				path: 'src/index.ts',
				changed: true,
				content: 'export {}\n',
				diff: 'diff',
			},
		],
	})
})
