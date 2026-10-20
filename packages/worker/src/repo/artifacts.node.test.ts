import { expect, test, vi } from 'vitest'
import { type ArtifactRepoHandle } from './artifacts.ts'

const gitMocks = vi.hoisted(() => ({
	listServerRefs: vi.fn(),
}))

vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({
		git: {
			listServerRefs: (...args: Array<unknown>) =>
				gitMocks.listServerRefs(...args),
		},
		http: {},
	}),
}))

const {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	ensureArtifactRepoReady,
	artifactsBindingErrorCode,
	getArtifactsBinding,
	getArtifactsNamespace,
	isArtifactRepoNotFoundError,
	parseArtifactTokenSecret,
	resolveArtifactDefaultBranchHead,
	resolveArtifactSourceHead,
	resolveArtifactSourceRepo,
	resolveExistingArtifactSourceRepo,
} = await import('./artifacts.ts')

const restEnv = {
	CLOUDFLARE_ACCOUNT_ID: 'acct',
	CLOUDFLARE_API_TOKEN: 'token-123',
	CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
} as Env

function withArtifactsNamespace(env: Partial<Env>, namespace: string) {
	return { ...env, ARTIFACTS_NAMESPACE: namespace } as unknown as Env
}

const remoteFor = (name: string, namespace = 'default') =>
	`https://acct.artifacts.cloudflare.net/git/${namespace}/${name}.git`

function apiResponse(
	result: unknown,
	{
		status = 200,
		errors = [] as Array<{ code: number; message: string }>,
		headers = {} as Record<string, string>,
	} = {},
) {
	return new Response(
		JSON.stringify({
			success: status < 300,
			result,
			errors,
			messages: [],
		}),
		{ status, headers: { 'content-type': 'application/json', ...headers } },
	)
}

const repoNotFound = (headers?: Record<string, string>) =>
	apiResponse(null, {
		status: 404,
		errors: [{ code: 1000, message: 'Repo not found' }],
		headers,
	})

function restRepo(name: string, overrides: Record<string, unknown> = {}) {
	return {
		id: name.replace('-', '_'),
		name,
		description: null,
		default_branch: 'main',
		created_at: '2026-04-17T00:00:00.000Z',
		updated_at: '2026-04-17T00:00:00.000Z',
		last_push_at: null,
		source: null,
		read_only: false,
		remote: remoteFor(name),
		...overrides,
	}
}

function createdRepo(name: string, token = 'art_v1_create?expires=1760000000') {
	return {
		id: name.replace('-', '_'),
		name,
		description: null,
		default_branch: 'main',
		remote: remoteFor(name),
		token,
	}
}

function mockFetch(
	handle: (
		method: string,
		url: URL,
		init?: RequestInit,
	) => Response | undefined,
) {
	const spy = vi.spyOn(globalThis, 'fetch')
	spy.mockClear()
	return spy.mockImplementation(async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const response = handle(method, url, init)
		if (!response) {
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		}
		return response
	})
}

function nativeRepoHandle(
	name: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id: name.replace('-', '_'),
		name,
		description: null,
		defaultBranch: 'main',
		createdAt: '2026-04-17T00:00:00.000Z',
		updatedAt: '2026-04-17T00:00:00.000Z',
		lastPushAt: null,
		source: null,
		readOnly: false,
		remote: remoteFor(name, 'production'),
		createToken: vi.fn(),
		listTokens: vi.fn(async () => ({ tokens: [], total: 0 })),
		revokeToken: vi.fn(),
		...overrides,
	}
}

test('artifacts REST client scopes API paths to configured or stored namespaces', async () => {
	const fetchMock = mockFetch((method, url) => {
		expect(url.pathname).toContain('/artifacts/namespaces/preview/repos/repo-1')
		return method === 'GET'
			? apiResponse(
					restRepo('repo-1', { remote: remoteFor('repo-1', 'preview') }),
				)
			: undefined
	})

	await expect(
		getArtifactsBinding(withArtifactsNamespace(restEnv, 'preview')).get(
			'repo-1',
		),
	).resolves.toMatchObject({ status: 'ready' })
	expect(fetchMock).toHaveBeenCalledTimes(1)

	const storedFetch = mockFetch((method, url) => {
		expect(url.pathname).toContain('/artifacts/namespaces/stored/repos/repo-1')
		return method === 'GET'
			? apiResponse(
					restRepo('repo-1', { remote: remoteFor('repo-1', 'stored') }),
				)
			: undefined
	})
	await expect(
		getArtifactsBinding(
			withArtifactsNamespace(restEnv, 'preview'),
			' stored ',
		).get('repo-1'),
	).resolves.toMatchObject({ status: 'ready' })
	expect(storedFetch).toHaveBeenCalledTimes(1)
	expect(getArtifactsNamespace({} as Env)).toBe('default')
	expect(getArtifactsNamespace(withArtifactsNamespace({}, ' preview '))).toBe(
		'preview',
	)
})

test('artifacts REST client supports get, create, token, and delete operations', async () => {
	let getRepo1Count = 0
	const fetchMock = mockFetch((method, url) => {
		if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
			getRepo1Count += 1
			return getRepo1Count === 1
				? repoNotFound()
				: apiResponse(restRepo('repo-1', { description: 'Repo 1' }))
		}
		if (method === 'POST' && url.pathname.endsWith('/repos')) {
			return apiResponse(createdRepo('repo-1'))
		}
		if (method === 'POST' && url.pathname.endsWith('/tokens')) {
			return apiResponse({
				id: 'tok_1',
				plaintext: 'art_v1_read?expires=1760000100',
				scope: 'read',
				expires_at: '2026-10-09T08:55:00.000Z',
			})
		}
		if (method === 'DELETE' && url.pathname.endsWith('/repos/repo-1')) {
			return apiResponse({ id: 'repo_1' }, { status: 202 })
		}
		return undefined
	})

	const binding = getArtifactsBinding(restEnv)
	await expect(binding.get('repo-1')).resolves.toEqual({ status: 'not_found' })
	await expect(binding.create('repo-1')).resolves.toMatchObject({
		id: 'repo_1',
		name: 'repo-1',
		defaultBranch: 'main',
		remote: remoteFor('repo-1'),
		token: 'art_v1_create?expires=1760000000',
	})

	const repo = await resolveArtifactSourceRepo(restEnv, 'repo-1')
	await expect(repo.info()).resolves.toMatchObject({
		id: 'repo_1',
		name: 'repo-1',
		defaultBranch: 'main',
		remote: remoteFor('repo-1'),
	})
	await expect(repo.createToken('read', 120)).resolves.toEqual({
		id: 'tok_1',
		plaintext: 'art_v1_read?expires=1760000100',
		scope: 'read',
		expiresAt: '2026-10-09T08:55:00.000Z',
	})
	await expect(binding.delete('repo-1')).resolves.toEqual({
		id: 'repo_1',
		alreadyDeleted: false,
	})
	expect(fetchMock).toHaveBeenCalledTimes(6)

	expect(parseArtifactTokenSecret('art_v1_secret?expires=1760000100')).toBe(
		'art_v1_secret',
	)
	expect(
		buildArtifactsGitAuth({ token: 'art_v1_secret?expires=1760000100' }),
	).toEqual({ username: 'x', password: 'art_v1_secret' })
	expect(
		buildAuthenticatedArtifactsRemote({
			remote: 'http://127.0.0.1:8787/git/default/repo-1.git',
			token: 'art_v1_secret?expires=1760000100',
		}),
	).toBe('http://x:art_v1_secret@127.0.0.1:8787/git/default/repo-1.git')
})

test('ensureArtifactRepoReady uses the create result, recovers from concurrent create conflicts, and surfaces other conflicts', async () => {
	const createFetch = mockFetch((method, url) => {
		if (method === 'GET' && url.pathname.endsWith('/repos/repo-new')) {
			return repoNotFound({ 'cf-ray': 'create-miss-ray' })
		}
		if (method === 'POST' && url.pathname.endsWith('/repos')) {
			return apiResponse(createdRepo('repo-new'), {
				status: 201,
				headers: { 'cf-ray': 'create-post-ray' },
			})
		}
		return undefined
	})
	await expect(
		ensureArtifactRepoReady(restEnv, 'repo-new'),
	).resolves.toMatchObject({
		recreated: true,
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: remoteFor('repo-new'),
			token: 'art_v1_create?expires=1760000000',
		},
		repo: expect.any(Object),
	})
	// No follow-up GET after a successful create.
	expect(createFetch).toHaveBeenCalledTimes(2)

	let getRepoCount = 0
	const racedFetch = mockFetch((method, url) => {
		if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
			getRepoCount += 1
			return getRepoCount === 1
				? repoNotFound()
				: apiResponse(restRepo('repo-1'))
		}
		if (method === 'POST' && url.pathname.endsWith('/repos')) {
			return apiResponse(null, {
				status: 409,
				errors: [{ code: 10201, message: 'Create failed' }],
			})
		}
		return undefined
	})
	await expect(
		ensureArtifactRepoReady(restEnv, 'repo-1'),
	).resolves.toMatchObject({
		recreated: false,
		repo: expect.any(Object),
	})
	expect(racedFetch).toHaveBeenCalledTimes(3)

	const conflictFetch = mockFetch((method, url) => {
		if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
			return repoNotFound()
		}
		if (method === 'POST' && url.pathname.endsWith('/repos')) {
			return apiResponse(null, {
				status: 409,
				errors: [{ code: 9000, message: 'Different conflict' }],
			})
		}
		return undefined
	})
	await expect(ensureArtifactRepoReady(restEnv, 'repo-1')).rejects.toThrow(
		'Different conflict',
	)
	expect(conflictFetch).toHaveBeenCalledTimes(2)
})

test('ensureArtifactRepoReady retries create when conflict leaves get not_found', async () => {
	let getRepoCount = 0
	let createCount = 0
	const fetchMock = mockFetch((method, url) => {
		if (method === 'GET' && url.pathname.endsWith('/repos/repo-ghost')) {
			getRepoCount += 1
			return repoNotFound()
		}
		if (method === 'POST' && url.pathname.endsWith('/repos')) {
			createCount += 1
			if (createCount <= 2) {
				return apiResponse(null, {
					status: 409,
					errors: [{ code: 10201, message: 'Create failed' }],
				})
			}
			return apiResponse(createdRepo('repo-ghost'), {
				status: 201,
			})
		}
		return undefined
	})
	await expect(
		ensureArtifactRepoReady(restEnv, 'repo-ghost'),
	).resolves.toMatchObject({
		recreated: true,
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: remoteFor('repo-ghost'),
			token: 'art_v1_create?expires=1760000000',
		},
	})
	expect(getRepoCount).toBeGreaterThanOrEqual(2)
	expect(createCount).toBe(3)
	expect(fetchMock).toHaveBeenCalled()
})

test('artifacts REST client error paths and missing source repos', async () => {
	const missingRepoFetch = mockFetch((method, url) =>
		method === 'GET' && url.pathname.endsWith('/repos/repo-1')
			? repoNotFound()
			: undefined,
	)
	await expect(
		resolveExistingArtifactSourceRepo(restEnv, 'repo-1'),
	).resolves.toBe(null)
	await expect(resolveArtifactSourceHead(restEnv, 'repo-1')).resolves.toEqual({
		branch: 'main',
		commit: null,
	})
	expect(missingRepoFetch).toHaveBeenCalledTimes(2)

	mockFetch(() => apiResponse(null, { status: 500 }))
	await expect(getArtifactsBinding(restEnv).get('repo-1')).rejects.toThrow(
		/Artifacts API request failed \(500\)/,
	)

	const invalidTokenFetch = mockFetch((method, url) =>
		method === 'POST' && url.pathname.endsWith('/repos')
			? apiResponse(createdRepo('repo-1', 'art_v1_missing_expiry'))
			: undefined,
	)
	await expect(getArtifactsBinding(restEnv).create('repo-1')).rejects.toThrow(
		/parseable expires timestamp/,
	)
	expect(invalidTokenFetch).toHaveBeenCalledTimes(1)
})

test('resolveArtifactDefaultBranchHead reuses a provided token and still works without one', async () => {
	gitMocks.listServerRefs.mockResolvedValue([
		{ ref: 'refs/heads/main', oid: 'abc123' },
	])
	const readToken = {
		id: 'tok_read',
		plaintext: 'art_v1_throwaway',
		scope: 'read',
		expiresAt: '2026-10-09T08:55:00.000Z',
	}
	const createToken = vi.fn<ArtifactRepoHandle['createToken']>(
		async () => readToken,
	)
	const info = vi.fn(async () => ({
		id: 'repo_1',
		name: 'repo-1',
		description: null,
		defaultBranch: 'main',
		createdAt: '2026-04-17T00:00:00.000Z',
		updatedAt: '2026-04-17T00:00:00.000Z',
		lastPushAt: null,
		source: null,
		readOnly: false,
		remote: remoteFor('repo-1'),
	}))
	const repo = { info, createToken }
	const head = (commit: string) => ({
		remote: remoteFor('repo-1'),
		defaultBranch: 'main',
		commit,
	})

	await expect(resolveArtifactDefaultBranchHead({ repo })).resolves.toEqual(
		head('abc123'),
	)
	expect(createToken).toHaveBeenCalledTimes(1)
	expect(createToken).toHaveBeenCalledWith('read', 300)
	expect(gitMocks.listServerRefs).toHaveBeenCalledWith(
		expect.objectContaining({
			url: 'https://x:art_v1_throwaway@acct.artifacts.cloudflare.net/git/default/repo-1.git',
			prefix: 'refs/heads/main',
			protocolVersion: 1,
		}),
	)

	const knownInfo = await info()
	createToken.mockClear()
	info.mockClear()
	gitMocks.listServerRefs.mockClear()
	await expect(
		resolveArtifactDefaultBranchHead({
			repo,
			token: 'art_v1_reused_write',
			info: knownInfo,
		}),
	).resolves.toEqual(head('abc123'))
	expect(createToken).not.toHaveBeenCalled()
	expect(info).not.toHaveBeenCalled()
	expect(gitMocks.listServerRefs).toHaveBeenCalledTimes(1)

	// @ts-expect-error createToken omits plaintext to exercise runtime validation
	createToken.mockResolvedValueOnce({ ...readToken, plaintext: undefined })
	await expect(resolveArtifactDefaultBranchHead({ repo })).rejects.toThrow(
		'Artifacts createToken result is missing plaintext.',
	)
	expect(gitMocks.listServerRefs).toHaveBeenCalledTimes(1)

	gitMocks.listServerRefs.mockReset()
	gitMocks.listServerRefs
		.mockRejectedValueOnce(
			Object.assign(new Error('HTTP Error: 500 Internal Server Error'), {
				code: 'HttpError',
				name: 'HttpError',
				data: {
					statusCode: 500,
					statusMessage: 'Internal Server Error',
					response: '',
				},
			}),
		)
		.mockResolvedValueOnce([{ ref: 'refs/heads/main', oid: 'retried-oid' }])
	await expect(resolveArtifactDefaultBranchHead({ repo })).resolves.toEqual(
		head('retried-oid'),
	)
	expect(gitMocks.listServerRefs).toHaveBeenCalledTimes(2)
})

test('native createToken maps token when JSRPC omits plaintext and defers to REST tokens when both are configured', async () => {
	const nativeCreateToken = vi.fn(
		async (): Promise<{ id: string; scope: 'read'; token?: string }> => ({
			id: 'tok_native',
			token: 'art_v2_read?expires=1760000100',
			scope: 'read',
		}),
	)
	const env = {
		ARTIFACTS_NAMESPACE: 'production',
		ARTIFACTS: {
			create: vi.fn(),
			get: vi.fn(async () =>
				nativeRepoHandle('repo-1', { createToken: nativeCreateToken }),
			),
			delete: vi.fn(),
			list: vi.fn(async () => ({ repos: [], total: 0 })),
		},
	} as unknown as Env

	const result = await getArtifactsBinding(env).get('repo-1')
	if (result.status !== 'ready') {
		throw new Error('expected native repo to be ready')
	}
	await expect(result.repo.createToken('read', 120)).resolves.toEqual({
		id: 'tok_native',
		plaintext: 'art_v2_read?expires=1760000100',
		scope: 'read',
		expiresAt: '2025-10-09T08:55:00.000Z',
	})
	expect(nativeCreateToken).toHaveBeenCalledWith('read', 120)

	nativeCreateToken.mockResolvedValueOnce({ id: 'tok_empty', scope: 'read' })
	await expect(result.repo.createToken('read', 120)).rejects.toThrow(
		'Artifacts native createToken failed: Artifacts createToken result is missing plaintext.',
	)

	const restFetch = mockFetch((method, url) =>
		method === 'POST' && url.pathname.endsWith('/tokens')
			? apiResponse({
					id: 'tok_rest',
					plaintext: 'art_v1_rest?expires=1760000100',
					scope: 'read',
					expires_at: '2026-10-09T08:55:00.000Z',
				})
			: undefined,
	)
	nativeCreateToken.mockClear()
	const hybrid = await getArtifactsBinding({
		...env,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'mock-email-token',
		CLOUDFLARE_API_BASE_URL: 'https://kody-pr-42-mock-cloudflare.example',
		CLOUDFLARE_ARTIFACTS_API_TOKEN: 'real-artifacts-token',
	} as unknown as Env).get('repo-1')
	if (hybrid.status !== 'ready') {
		throw new Error('expected hybrid native repo to be ready')
	}
	await expect(hybrid.repo.createToken('read', 120)).resolves.toEqual({
		id: 'tok_rest',
		plaintext: 'art_v1_rest?expires=1760000100',
		scope: 'read',
		expiresAt: '2026-10-09T08:55:00.000Z',
	})
	expect(nativeCreateToken).not.toHaveBeenCalled()
	expect(restFetch).toHaveBeenCalledTimes(1)
	const restUrl = new URL(String(restFetch.mock.calls[0]?.[0]))
	expect(restUrl.origin).toBe('https://api.cloudflare.com')
	expect(restFetch.mock.calls[0]?.[1]).toMatchObject({
		headers: expect.objectContaining({
			authorization: 'Bearer real-artifacts-token',
		}),
	})
})

test('native ARTIFACTS with a mock API base and no Artifacts token skips REST createToken', async () => {
	const nativeCreateToken = vi.fn(
		async (): Promise<{
			id: string
			scope: 'read'
			token?: string
			plaintext?: string
		}> => ({
			id: 'tok_native',
			token: 'art_v2_read?expires=1760000100',
			scope: 'read',
		}),
	)
	const restFetch = mockFetch(() => {
		throw new Error('REST must not be called against the mock for Artifacts')
	})
	const binding = getArtifactsBinding({
		ARTIFACTS_NAMESPACE: 'kody-pr-42',
		ARTIFACTS: {
			create: vi.fn(),
			get: vi.fn(async () =>
				nativeRepoHandle('repo-1', { createToken: nativeCreateToken }),
			),
			delete: vi.fn(),
			list: vi.fn(async () => ({ repos: [], total: 0 })),
		},
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'mock-email-token',
		CLOUDFLARE_API_BASE_URL: 'https://kody-pr-42-mock-cloudflare.example',
	} as unknown as Env)
	const result = await binding.get('repo-1')
	if (result.status !== 'ready') {
		throw new Error('expected native repo to be ready')
	}
	await expect(result.repo.createToken('read', 120)).resolves.toMatchObject({
		id: 'tok_native',
		plaintext: 'art_v2_read?expires=1760000100',
	})
	expect(nativeCreateToken).toHaveBeenCalled()
	expect(restFetch).not.toHaveBeenCalled()
})

test('local Artifacts REST refuses the Cloudflare production API host without a mock base URL', () => {
	expect(() =>
		getArtifactsBinding({
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'live-token',
			ARTIFACTS_NAMESPACE: 'production',
		} as unknown as Env),
	).toThrow(/Local Artifacts REST refuses api\.cloudflare\.com/)
	expect(() =>
		getArtifactsBinding({
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'live-token',
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
			ARTIFACTS_NAMESPACE: 'production',
		} as unknown as Env),
	).toThrow(/Local Artifacts REST refuses api\.cloudflare\.com/)
	expect(() =>
		getArtifactsBinding({
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'live-token',
			CLOUDFLARE_API_BASE_URL: 'http://api.cloudflare.com',
			ARTIFACTS_NAMESPACE: 'production',
		} as unknown as Env),
	).toThrow(/Local Artifacts REST refuses api\.cloudflare\.com/)
	expect(() =>
		getArtifactsBinding({
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'live-token',
			CLOUDFLARE_API_BASE_URL: 'https://API.cloudflare.com/',
			ARTIFACTS_NAMESPACE: 'production',
		} as unknown as Env),
	).toThrow(/Local Artifacts REST refuses api\.cloudflare\.com/)
	expect(() =>
		getArtifactsBinding({
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'mock-token',
			CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
			ARTIFACTS_NAMESPACE: 'production',
		} as unknown as Env),
	).not.toThrow()
})

test('getArtifactsBinding prefers the native ARTIFACTS binding for the env namespace', async () => {
	const created = {
		id: 'repo_native',
		name: 'repo-native',
		description: null,
		defaultBranch: 'main',
		remote: remoteFor('repo-native', 'production'),
		token: 'art_v2_native',
		tokenExpiresAt: '2026-10-09T08:53:20.000Z',
	}
	const notFound = (name: string) => ({
		name: 'ArtifactsError',
		code: 'NOT_FOUND',
		message: `Repository not found: ${name}`,
	})
	const nativeGet = vi.fn(async (): Promise<unknown> => {
		throw Object.assign(new Error('not found'), {
			name: 'ArtifactsError',
			code: 'NOT_FOUND',
		})
	})
	const nativeCreate = vi.fn(async (): Promise<unknown> => created)
	const env = {
		ARTIFACTS_NAMESPACE: 'production',
		ARTIFACTS: {
			create: nativeCreate,
			get: nativeGet,
			delete: vi.fn(async () => true),
			list: vi.fn(async () => ({ repos: [], total: 0 })),
		},
	} as unknown as Env
	const binding = getArtifactsBinding(env)

	await expect(binding.get('repo-native')).resolves.toEqual({
		status: 'not_found',
	})
	await expect(
		ensureArtifactRepoReady(env, 'repo-native', binding),
	).resolves.toMatchObject({
		recreated: true,
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: created.remote,
			token: created.token,
			expiresAt: created.tokenExpiresAt,
		},
	})
	expect(nativeCreate).toHaveBeenCalledWith('repo-native', { readOnly: false })
	expect(nativeGet).toHaveBeenCalledTimes(2)

	// Duck-typed (non-Error) NOT_FOUND; expiry comes from the token suffix.
	nativeGet.mockImplementation(async () => {
		throw notFound('repo-native-duck')
	})
	nativeCreate.mockImplementation(async () => ({
		...created,
		id: 'repo_native_duck',
		name: 'repo-native-duck',
		remote: remoteFor('repo-native-duck', 'production'),
		token: 'art_v2_native?expires=1760000000',
		tokenExpiresAt: undefined,
	}))
	await expect(binding.get('repo-native-duck')).resolves.toEqual({
		status: 'not_found',
	})
	await expect(
		ensureArtifactRepoReady(env, 'repo-native-duck', binding),
	).resolves.toMatchObject({
		recreated: true,
		bootstrapAccess: {
			token: 'art_v2_native?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
	})
	expect(nativeCreate).toHaveBeenCalledWith('repo-native-duck', {
		readOnly: false,
	})

	nativeGet.mockImplementation(async () => {
		throw new Error('git: repository not found on the remote')
	})
	await expect(binding.get('repo-unrelated-not-found')).rejects.toThrow(
		/git: repository not found/,
	)

	// ALREADY_EXISTS on create after a NOT_FOUND get re-reads the ready repo.
	let existsGets = 0
	nativeGet.mockImplementation(async () => {
		existsGets += 1
		if (existsGets === 1) throw notFound('repo-native-exists')
		return nativeRepoHandle('repo-native-exists')
	})
	nativeCreate.mockReset()
	nativeCreate.mockImplementation(async () => {
		throw {
			name: 'ArtifactsError',
			code: 'ALREADY_EXISTS',
			message: 'Repository already exists: repo-native-exists',
		}
	})
	await expect(
		ensureArtifactRepoReady(env, 'repo-native-exists', binding),
	).resolves.toMatchObject({ recreated: false, repo: expect.any(Object) })
	expect(nativeCreate).toHaveBeenCalledTimes(1)
	expect(existsGets).toBeGreaterThan(1)
})

test('artifacts REST logs redact plaintext tokens on revoke', async () => {
	const plaintext = 'art_v1_secret?expires=1760000100'
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	mockFetch((method, url) => {
		expect(method).toBe('DELETE')
		expect(url.pathname).toContain(`/tokens/${encodeURIComponent(plaintext)}`)
		return apiResponse(null, { headers: { 'cf-ray': 'revoke-ray-1' } })
	})

	await getArtifactsBinding(restEnv).repo('repo-1').revokeToken?.(plaintext)

	const logged = info.mock.calls.filter((call) => call[0] === 'artifacts-rest')
	expect(logged).toHaveLength(1)
	expect(logged[0]?.[1]).toEqual({
		method: 'DELETE',
		path: '/client/v4/accounts/acct/artifacts/namespaces/default/tokens/:token',
		status: 200,
		cfRay: 'revoke-ray-1',
	})
	expect(JSON.stringify(logged)).not.toContain(plaintext)
	expect(JSON.stringify(logged)).not.toContain(encodeURIComponent(plaintext))
})

test('artifacts REST client forks a repo without sending file contents', async () => {
	mockFetch((method, url, init) => {
		expect(method).toBe('POST')
		expect(url.pathname).toBe(
			'/client/v4/accounts/acct/artifacts/namespaces/default/repos/package-origin/fork',
		)
		expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
			name: 'package-dest',
			read_only: false,
			default_branch_only: true,
		})
		return apiResponse(
			createdRepo('package-dest', 'art_v1_fork?expires=1760000000'),
		)
	})

	await expect(
		getArtifactsBinding(restEnv).fork('package-origin', 'package-dest', {
			readOnly: false,
			defaultBranchOnly: true,
		}),
	).resolves.toMatchObject({
		id: 'package_dest',
		name: 'package-dest',
		token: 'art_v1_fork?expires=1760000000',
	})
})

test('isArtifactRepoNotFoundError matches repo-scoped messages only', () => {
	const cases: Array<[string, boolean]> = [
		['Artifacts repo "package-origin" was not found.', true],
		['Repository not found: package-origin', true],
		['Repo not found', true],
		['Secret not found', false],
		['git: repository not found on the remote', false],
		['User was not found', false],
	]
	expect(
		cases.filter(
			([message, want]) =>
				isArtifactRepoNotFoundError(new Error(message)) !== want,
		),
	).toEqual([])
	expect(
		artifactsBindingErrorCode(
			new Error('ArtifactsError: Repository not found: package-origin'),
		),
	).toBe('NOT_FOUND')
})
