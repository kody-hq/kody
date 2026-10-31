import type git from 'isomorphic-git'
import { expect, test, vi } from 'vitest'

const mockGit = vi.hoisted(() => ({
	addNote: vi.fn(
		async (..._args: Parameters<typeof git.addNote>) => 'note-commit-1',
	),
	push: vi.fn(async () => ({ ok: true, refs: {} })),
	init: vi.fn(async () => undefined),
	addRemote: vi.fn(async () => undefined),
	fetch: vi.fn(async (): Promise<{ fetchHead: string | null }> => ({
		fetchHead: 'notes-tip-1',
	})),
	writeRef: vi.fn(async () => undefined),
	readNote: vi.fn(async () => new TextEncoder().encode('{"v":1}\n')),
}))

vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({
		git: mockGit,
		http: {},
	}),
}))

vi.mock('@sentry/cloudflare', () => ({
	captureException: vi.fn(),
	instrumentDurableObjectWithSentry: (_options: unknown, base: unknown) => base,
}))

vi.mock('./artifacts.ts', () => ({
	buildArtifactsGitAuth: vi.fn(() => ({
		username: 'x-access-token',
		password: 'token',
	})),
	buildAuthenticatedArtifactsRemote: vi.fn(
		(input: { remote: string; token: string }) => input.remote,
	),
	resolveArtifactSourceRepo: vi.fn(async () => ({
		info: async () => ({
			remote: 'https://example.com/repo.git',
			defaultBranch: 'main',
		}),
		createToken: async () => ({
			plaintext: 'token-1',
			expiresAt: '2099-01-01T00:00:00.000Z',
		}),
	})),
}))

const {
	buildPublishGitNote,
	readPublishGitNoteFromArtifactsRepo,
	writeAndPushPublishGitNote,
} = await import('./publish-git-notes.ts')

test('publish git notes build, parse, write, and read from artifacts repos', async () => {
	const note = buildPublishGitNote({
		publishedBy: 'repo_session',
		source: {
			id: 'source-1',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'package-pkg-1',
			published_commit: 'commit-old',
		},
		commit: 'commit-new',
		publishedAt: '2026-05-28T12:00:00.000Z',
		sessionId: 'session-1',
		conversationId: 'conversation-1',
		baseCommit: 'commit-old',
		checks: {
			runId: 'run-1',
			treeHash: 'tree-1',
			checkedAt: '2026-05-28T11:59:00.000Z',
			ok: true,
			results: [{ kind: 'lint', ok: true, message: 'ok' }],
		},
	})
	const bootstrapNote = buildPublishGitNote({
		publishedBy: 'source_bootstrap',
		source: {
			id: 'source-1',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'package-pkg-1',
			published_commit: 'commit-stale',
		},
		commit: 'commit-new',
		previousPublishedCommit: null,
	})

	expect(note).toEqual({
		v: 1,
		publishedAt: '2026-05-28T12:00:00.000Z',
		publishedBy: 'repo_session',
		sourceId: 'source-1',
		entityKind: 'package',
		entityId: 'pkg-1',
		repoId: 'package-pkg-1',
		commit: 'commit-new',
		sessionId: 'session-1',
		conversationId: 'conversation-1',
		previousPublishedCommit: 'commit-old',
		baseCommit: 'commit-old',
		checks: {
			runId: 'run-1',
			treeHash: 'tree-1',
			checkedAt: '2026-05-28T11:59:00.000Z',
			ok: true,
			results: [{ kind: 'lint', ok: true, message: 'ok' }],
		},
	})
	expect(bootstrapNote.previousPublishedCommit).toBeNull()

	const { parsePublishGitNote } = await import('./publish-git-notes.ts')
	expect(parsePublishGitNote('not-json')).toBeNull()

	mockGit.addNote.mockClear()
	mockGit.push.mockClear()
	const filesystem = {
		readFile: vi.fn(async () => ''),
		readFileBytes: vi.fn(async () => new Uint8Array()),
		writeFile: vi.fn(async () => undefined),
		writeFileBytes: vi.fn(async () => undefined),
		rm: vi.fn(async () => undefined),
		mkdir: vi.fn(async () => undefined),
		readdir: vi.fn(async () => []),
		stat: vi.fn(async () => ({
			type: 'file' as const,
			size: 0,
			mtime: new Date(),
		})),
		lstat: vi.fn(async () => ({
			type: 'file' as const,
			size: 0,
			mtime: new Date(),
		})),
		readlink: vi.fn(async () => ''),
		symlink: vi.fn(async () => undefined),
	}

	await writeAndPushPublishGitNote({
		filesystem,
		dir: '/session',
		commitOid: 'commit-new',
		remote: 'https://example.com/repo.git',
		token: 'token-1?expires=999',
		remoteName: 'source',
		note: buildPublishGitNote({
			publishedBy: 'external_push',
			source: {
				id: 'source-1',
				entity_kind: 'package',
				entity_id: 'package-1',
				repo_id: 'package-package-1',
				published_commit: null,
			},
			commit: 'commit-new',
		}),
	})

	expect(mockGit.addNote).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/session',
			ref: 'refs/notes/commits',
			oid: 'commit-new',
			force: true,
		}),
	)
	const writtenNote = mockGit.addNote.mock.calls[0]?.[0]?.note
	expect(
		parsePublishGitNote(
			typeof writtenNote === 'string'
				? writtenNote
				: new TextDecoder().decode(writtenNote),
		),
	).toMatchObject({
		publishedBy: 'external_push',
		entityKind: 'package',
		commit: 'commit-new',
	})
	expect(mockGit.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/session',
			remote: 'source',
			url: 'https://example.com/repo.git',
			ref: 'refs/notes/commits',
		}),
	)
	expect(mockGit.push).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/session',
			remote: 'source',
			url: 'https://example.com/repo.git',
			ref: 'refs/notes/commits',
			remoteRef: 'refs/notes/commits',
			force: true,
		}),
	)

	// The fetched notes tip must become the local notes ref before addNote,
	// or the force push replaces every earlier note with this one.
	expect(mockGit.writeRef).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/session',
			ref: 'refs/notes/commits',
			value: 'notes-tip-1',
			force: true,
		}),
	)
	expect(mockGit.writeRef.mock.invocationCallOrder[0]).toBeLessThan(
		mockGit.addNote.mock.invocationCallOrder[0]!,
	)

	const readInput = {
		env: {} as Env,
		repoId: 'package-pkg-1',
		commitOid: 'commit-1',
	}

	mockGit.writeRef.mockClear()
	mockGit.readNote.mockClear()
	const existingNote = await readPublishGitNoteFromArtifactsRepo(readInput)
	expect(existingNote).toMatchObject({ found: true, rawNote: '{"v":1}\n' })
	expect(mockGit.writeRef).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			ref: 'refs/notes/commits',
			value: 'notes-tip-1',
		}),
	)
	expect(mockGit.writeRef.mock.invocationCallOrder[0]).toBeLessThan(
		mockGit.readNote.mock.invocationCallOrder[0]!,
	)

	mockGit.init.mockClear()
	mockGit.addRemote.mockClear()
	mockGit.fetch.mockClear()
	mockGit.writeRef.mockClear()
	mockGit.readNote.mockClear()
	mockGit.fetch.mockRejectedValueOnce(
		Object.assign(new Error('Could not find refs/notes/commits.'), {
			code: 'NotFoundError',
		}),
	)

	const missingNotesRef = await readPublishGitNoteFromArtifactsRepo(readInput)
	expect(missingNotesRef.found).toBe(false)
	expect(mockGit.init).toHaveBeenCalledWith(
		expect.objectContaining({ dir: '/repo' }),
	)
	expect(mockGit.addRemote).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			remote: 'origin',
			url: 'https://example.com/repo.git',
		}),
	)
	expect(mockGit.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			remote: 'origin',
			ref: 'refs/notes/commits',
		}),
	)
	expect(mockGit.readNote).not.toHaveBeenCalled()
	expect(mockGit.writeRef).not.toHaveBeenCalled()

	mockGit.fetch.mockRejectedValueOnce(new Error('HTTP Error: 401 Unauthorized'))
	await expect(readPublishGitNoteFromArtifactsRepo(readInput)).rejects.toThrow(
		/401 Unauthorized/,
	)
})
