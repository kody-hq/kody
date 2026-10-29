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
	authorizeRepoSessionPackageRead: async () => undefined,
}))

const { repoReadFileCapability } = await import('./repo-read-file.ts')

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

const source = Array.from(
	{ length: 200 },
	(_, index) => `line ${String(index + 1)}`,
).join('\n')

const readme = `# Package

## Export JSDoc

How to document an export.

## Intent

What the package does.
`

test('repoReadFile focuses # line and heading anchors and rejects missing ones', async () => {
	const readFile = vi.fn(async ({ path }: { path: string }) => {
		if (path === 'src/file.ts') return { path, content: source }
		if (path === 'README.md') return { path, content: readme }
		return { path, content: null }
	})
	mocks.repoSessionRpc.mockReturnValue({ readFile })

	const line = await repoReadFileCapability.handler(
		{ session_id: 'session-1', path: 'src/file.ts#L165' },
		createContext(),
	)
	expect(readFile).toHaveBeenCalledWith(
		expect.objectContaining({ path: 'src/file.ts' }),
	)
	expect(line.path).toBe('src/file.ts')
	expect(line.anchor).toMatchObject({ kind: 'lines' })
	expect(line.content).toContain('165|line 165')
	expect(line.content).not.toContain('144|line 144')
	expect(line.content).not.toBe(source)

	const heading = await repoReadFileCapability.handler(
		{ session_id: 'session-1', path: 'README.md#export-jsdoc' },
		createContext(),
	)
	expect(heading.anchor).toMatchObject({
		kind: 'heading',
		heading: { slug: 'export-jsdoc' },
	})
	expect(heading.content).toContain('How to document an export.')
	expect(heading.content).not.toContain('What the package does.')

	const whole = await repoReadFileCapability.handler(
		{ session_id: 'session-1', path: 'src/file.ts' },
		createContext(),
	)
	expect(whole).toEqual({ path: 'src/file.ts', content: source })

	const missingLine = await repoReadFileCapability
		.handler(
			{ session_id: 'session-1', path: 'src/file.ts#L999' },
			createContext(),
		)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingLine).toBeInstanceOf(McpCallerError)
	expect((missingLine as Error).message).toMatch(/past the end/)
})

test('repoReadFile rewraps a folder path as a caller error (KODY-CA)', async () => {
	const directoryMessage =
		'repo session read target "src" is a directory. Pass a file path (for example src/index.ts), or use repoTree to list the folder.'
	mocks.repoSessionRpc.mockReturnValue({
		readFile: vi.fn(async () => {
			throw new Error(directoryMessage)
		}),
	})

	const error = await repoReadFileCapability
		.handler({ session_id: 'session-1', path: 'src' }, createContext())
		.then(
			() => null,
			(caught: unknown) => caught,
		)
	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toBe(directoryMessage)
})

test('repoReadFile rewraps a nested directory-target cause as a caller error', async () => {
	const directoryMessage =
		'repo session read target "src" is a directory. Pass a file path (for example src/index.ts), or use repoTree to list the folder.'
	mocks.repoSessionRpc.mockReturnValue({
		readFile: vi.fn(async () => {
			throw new Error('Repo session read failed.', {
				cause: new Error(directoryMessage),
			})
		}),
	})

	const error = await repoReadFileCapability
		.handler({ session_id: 'session-1', path: 'src' }, createContext())
		.then(
			() => null,
			(caught: unknown) => caught,
		)
	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toBe(directoryMessage)
})

test('repoReadFile leaves other read failures platform-visible', async () => {
	mocks.repoSessionRpc.mockReturnValue({
		readFile: vi.fn(async () => {
			throw new Error('SQLITE_BUSY: database is locked')
		}),
	})

	const error = await repoReadFileCapability
		.handler({ session_id: 'session-1', path: 'src/index.ts' }, createContext())
		.then(
			() => null,
			(caught: unknown) => caught,
		)
	expect(error).toBeInstanceOf(Error)
	expect(error).not.toBeInstanceOf(McpCallerError)
})
