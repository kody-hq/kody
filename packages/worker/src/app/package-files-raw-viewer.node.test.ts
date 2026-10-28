import type * as CloudflareWorkers from 'cloudflare:workers'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type ApiTokenScope } from '#worker/api-tokens/scopes.ts'
import type * as Authenticate from '#worker/open-api/authenticate.ts'
import { type ApiInvocationContext } from '#worker/open-api/context.ts'
import { ApiError } from '#worker/open-api/errors.ts'

const mockModule = vi.hoisted(() => ({
	authenticateApiRequest: vi.fn<typeof Authenticate.authenticateApiRequest>(),
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return { ...actual, waitUntil: () => {} }
})

vi.mock('#worker/open-api/authenticate.ts', () => ({
	authenticateApiRequest: (
		...args: Parameters<typeof Authenticate.authenticateApiRequest>
	) => mockModule.authenticateApiRequest(...args),
}))

const { resolvePackageFileRawViewer } =
	await import('./package-files-raw-viewer.ts')

const env = { APP_ORIGIN: 'https://kody.codes' } as unknown as Env
const tokenUser = {
	userId: personIdFromStored('owner-1'),
	email: 'kent@example.com',
	username: 'kentcdodds',
	displayName: 'Kent',
}

function tokenContext(
	scopes: Array<ApiTokenScope>,
	binding: { org_binding: 'user' | 'org'; org_id: string } = {
		org_binding: 'user',
		org_id: 'owner-1',
	},
) {
	return {
		callerContext: { user: tokenUser },
		principal: { kind: 'token', token: { scopes, ...binding } },
	} as unknown as ApiInvocationContext
}

function rawRequest(headers?: HeadersInit) {
	return new Request(
		'https://kody.codes/@kentcdodds/skills/raw/main/src/skill-get.ts',
		{ headers },
	)
}

test('raw viewer defers to the session cookie when no Authorization is sent', async () => {
	expect(
		await resolvePackageFileRawViewer({ env, request: rawRequest() }),
	).toEqual({ kind: 'session' })
	expect(mockModule.authenticateApiRequest).not.toHaveBeenCalled()
})

test('raw viewer uses a package:read token and reads as anonymous without it', async () => {
	mockModule.authenticateApiRequest.mockResolvedValue(
		tokenContext(['package:read']),
	)
	const request = rawRequest({ Authorization: 'Bearer kody_at_abc_def' })
	expect(await resolvePackageFileRawViewer({ env, request })).toEqual({
		kind: 'token',
		callerContext: { user: tokenUser },
		user: tokenUser,
		orgId: null,
	})
	expect(mockModule.authenticateApiRequest).toHaveBeenCalledWith(
		expect.not.objectContaining({ allowMcpOauth: true }),
	)

	mockModule.authenticateApiRequest.mockResolvedValue(
		tokenContext(['org:execute']),
	)
	expect(await resolvePackageFileRawViewer({ env, request })).toEqual({
		kind: 'token',
		callerContext: { user: tokenUser },
		user: null,
		orgId: null,
	})

	mockModule.authenticateApiRequest.mockResolvedValue(
		tokenContext(['package:read'], { org_binding: 'org', org_id: 'team-a' }),
	)
	expect(await resolvePackageFileRawViewer({ env, request })).toEqual({
		kind: 'token',
		callerContext: { user: tokenUser },
		user: tokenUser,
		orgId: 'team-a',
	})
})

test('raw viewer reports invalid credentials instead of reading as anonymous', async () => {
	const error = new ApiError({
		status: 401,
		code: 'unauthorized',
		message: 'Invalid API token.',
	})
	mockModule.authenticateApiRequest.mockRejectedValue(error)
	expect(
		await resolvePackageFileRawViewer({
			env,
			request: rawRequest({ Authorization: 'Bearer nope' }),
		}),
	).toEqual({ kind: 'invalid', error })
})
