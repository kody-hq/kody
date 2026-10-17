import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PackageFilesData from '#app/package-files-data.ts'
import type * as PackageFilesRawViewer from '#app/package-files-raw-viewer.ts'
import { ApiError } from '#worker/open-api/errors.ts'

const mockModule = vi.hoisted(() => ({
	loadAccessiblePackageFileRaw:
		vi.fn<typeof PackageFilesData.loadAccessiblePackageFileRaw>(),
	loadCommunityPackageFileRaw:
		vi.fn<typeof PackageFilesData.loadCommunityPackageFileRaw>(),
	resolvePackageFileRawViewer:
		vi.fn<typeof PackageFilesRawViewer.resolvePackageFileRawViewer>(),
}))

vi.mock('#app/package-files-data.ts', () => ({
	loadAccessiblePackageFileRaw: (
		...args: Parameters<typeof PackageFilesData.loadAccessiblePackageFileRaw>
	) => mockModule.loadAccessiblePackageFileRaw(...args),
	loadCommunityPackageFileRaw: (
		...args: Parameters<typeof PackageFilesData.loadCommunityPackageFileRaw>
	) => mockModule.loadCommunityPackageFileRaw(...args),
}))

vi.mock('#app/package-files-raw-viewer.ts', () => ({
	resolvePackageFileRawViewer: (
		...args: Parameters<
			typeof PackageFilesRawViewer.resolvePackageFileRawViewer
		>
	) => mockModule.resolvePackageFileRawViewer(...args),
}))

const { createCommunityDetailRawHandler, createCommunityPackageRawHandler } =
	await import('./package-files-raw.ts')

const kentSkillGetUrl =
	'https://kody.codes/@kentcdodds/skills/raw/main/src/skill-get.ts'
const skillGetSource = "export const skillGet = 'skill'\n"

const pngBytes = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
])

function requestPackageRaw(
	url: string,
	params: { relativePath: string; ref?: string },
	init?: RequestInit,
) {
	return createCommunityPackageRawHandler({} as Env)({
		request: new Request(url, init),
		params: {
			username: 'kentcdodds',
			kodyId: 'skills',
			ref: params.ref ?? 'main',
			relativePath: params.relativePath,
		},
		url: new URL(url),
	} as never)
}

function expectInertHeaders(response: Response) {
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(response.headers.get('Content-Security-Policy')).toBe(
		"default-src 'none'; sandbox",
	)
}

test("signed-in owner reads Kent's private /raw/main/ source file as text/plain", async () => {
	mockModule.resolvePackageFileRawViewer.mockResolvedValue({ kind: 'session' })
	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: new TextEncoder().encode(skillGetSource),
		contentType: 'text/plain; charset=utf-8',
		disposition: 'inline',
		filename: 'skill-get.ts',
		isPrivate: true,
	})

	const response = await requestPackageRaw(
		kentSkillGetUrl,
		{ relativePath: 'src/skill-get.ts' },
		{ headers: { Cookie: 'kody_session=abc' } },
	)

	expect(response.status).toBe(200)
	expect(await response.text()).toBe(skillGetSource)
	expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
	expect(response.headers.get('Content-Disposition')).toBe(
		'inline; filename="skill-get.ts"',
	)
	expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	expectInertHeaders(response)
	const call = mockModule.loadAccessiblePackageFileRaw.mock.calls[0]?.[0]
	expect(call).toMatchObject({
		username: 'kentcdodds',
		kodyId: 'skills',
		ref: 'main',
		selectedPath: 'src/skill-get.ts',
	})
	expect(call && 'viewer' in call).toBe(false)
})

test('raw 404s with inert headers for viewers without access and unauthenticated requests', async () => {
	mockModule.resolvePackageFileRawViewer.mockResolvedValue({ kind: 'session' })
	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'not-found',
	})

	const anonymous = await requestPackageRaw(kentSkillGetUrl, {
		relativePath: 'src/skill-get.ts',
	})
	expect(anonymous.status).toBe(404)
	expect(anonymous.headers.get('Cache-Control')).toBe('no-store')
	expectInertHeaders(anonymous)

	const otherViewer = await requestPackageRaw(
		kentSkillGetUrl,
		{ relativePath: 'src/skill-get.ts' },
		{ headers: { Cookie: 'kody_session=someone-else' } },
	)
	expect(otherViewer.status).toBe(404)
	expect(await otherViewer.text()).toBe('Not found')
})

test('raw accepts a kody_at_ bearer and rejects invalid credentials before lookup', async () => {
	const tokenUser = {
		userId: personIdFromStored('owner-1'),
		email: 'kent@example.com',
		username: 'kentcdodds',
		displayName: 'Kent',
	}
	mockModule.resolvePackageFileRawViewer.mockResolvedValue({
		kind: 'token',
		user: tokenUser,
		orgId: 'team-a',
	})
	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: new TextEncoder().encode(skillGetSource),
		contentType: 'text/plain; charset=utf-8',
		disposition: 'inline',
		filename: 'skill-get.ts',
		isPrivate: false,
	})
	const withToken = await requestPackageRaw(
		kentSkillGetUrl,
		{ relativePath: 'src/skill-get.ts' },
		{ headers: { Authorization: 'Bearer kody_at_abc_def' } },
	)
	expect(withToken.status).toBe(200)
	// Credentialed reads never land in a shared cache, even for public files.
	expect(withToken.headers.get('Cache-Control')).toBe('private, no-store')
	expect(mockModule.loadAccessiblePackageFileRaw).toHaveBeenCalledWith(
		expect.objectContaining({ viewer: tokenUser, viewerOrgId: 'team-a' }),
	)

	mockModule.loadAccessiblePackageFileRaw.mockClear()
	mockModule.resolvePackageFileRawViewer.mockResolvedValue({
		kind: 'invalid',
		error: new ApiError({
			status: 401,
			code: 'unauthorized',
			message: 'Invalid API token.',
			headers: { 'WWW-Authenticate': 'Bearer realm="kody-api"' },
		}),
	})
	const invalid = await requestPackageRaw(
		kentSkillGetUrl,
		{ relativePath: 'src/skill-get.ts' },
		{ headers: { Authorization: 'Bearer nope' } },
	)
	expect(invalid.status).toBe(401)
	expect(invalid.headers.get('WWW-Authenticate')).toContain('Bearer')
	expectInertHeaders(invalid)
	expect(mockModule.loadAccessiblePackageFileRaw).not.toHaveBeenCalled()
})

test('raw serves images inline, binaries as downloads, and rejects traversal', async () => {
	mockModule.resolvePackageFileRawViewer.mockResolvedValue({ kind: 'session' })
	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: pngBytes,
		contentType: 'image/png',
		disposition: 'inline',
		filename: 'logo.png',
		isPrivate: false,
	})
	const image = await requestPackageRaw(
		'https://kody.codes/@kentcdodds/skills/raw/main/docs/logo.png',
		{ relativePath: 'docs/logo.png' },
	)
	expect(image.status).toBe(200)
	expect(image.headers.get('Content-Type')).toBe('image/png')
	expect(image.headers.get('Cache-Control')).toBe('public, max-age=60')
	expectInertHeaders(image)
	expect(new Uint8Array(await image.arrayBuffer())).toEqual(pngBytes)

	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: Uint8Array.from([0, 97, 115, 109]),
		contentType: 'application/octet-stream',
		disposition: 'attachment',
		filename: 'app.wasm',
		isPrivate: false,
	})
	const binary = await requestPackageRaw(
		'https://kody.codes/@kentcdodds/skills/raw/main/app.wasm',
		{ relativePath: 'app.wasm' },
	)
	expect(binary.headers.get('Content-Type')).toBe('application/octet-stream')
	expect(binary.headers.get('Content-Disposition')).toBe(
		'attachment; filename="app.wasm"',
	)

	mockModule.loadAccessiblePackageFileRaw.mockClear()
	const traversal = await requestPackageRaw(
		'https://kody.codes/@kentcdodds/skills/raw/main/../secret.ts',
		{ relativePath: '../secret.ts' },
	)
	expect(traversal.status).toBe(404)
	expect(mockModule.loadAccessiblePackageFileRaw).not.toHaveBeenCalled()

	const head = await requestPackageRaw(
		'https://kody.codes/@kentcdodds/skills/raw/main/app.wasm',
		{ relativePath: 'app.wasm' },
		{ method: 'HEAD' },
	)
	expect(head.status).toBe(200)
	expect(head.body).toBeNull()
})

test('listing raw serves public files and 404s unknown listings', async () => {
	const handler = createCommunityDetailRawHandler({} as Env)
	mockModule.loadCommunityPackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: new TextEncoder().encode('<html><script>alert(1)</script></html>'),
		contentType: 'text/plain; charset=utf-8',
		disposition: 'inline',
		filename: 'index.html',
		isPrivate: false,
	})
	const html = await handler({
		request: new Request(
			'https://kody.codes/community/listing-1/raw/index.html',
		),
		params: { listingId: 'listing-1', relativePath: 'index.html' },
		url: new URL('https://kody.codes/community/listing-1/raw/index.html'),
	} as never)
	expect(html.status).toBe(200)
	expect(html.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
	expectInertHeaders(html)

	mockModule.loadCommunityPackageFileRaw.mockResolvedValue({
		kind: 'not-found',
	})
	const missing = await handler({
		request: new Request('https://kody.codes/community/nope/raw/index.html'),
		params: { listingId: 'nope', relativePath: 'index.html' },
		url: new URL('https://kody.codes/community/nope/raw/index.html'),
	} as never)
	expect(missing.status).toBe(404)
})
