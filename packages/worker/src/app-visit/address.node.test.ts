import { expect, test, vi } from 'vitest'

vi.mock('#app/package-app-origin.ts', () => ({
	resolveVerifiedCustomHostnameIfEnabled: async (request: Request) => {
		const { host } = new URL(request.url)
		if (host === 'board.example.org') {
			return { bindingKind: 'app', username: 'acme', kodyId: 'board' }
		}
		if (host === 'apps.example.org') {
			return { bindingKind: 'org', username: 'acme' }
		}
		return null
	},
}))
vi.mock('#worker/package-app-profile-host.ts', () => ({
	hasProfilePackageApp: async () => false,
}))

const { resolveAppAddress } = await import('./address.ts')

const env = {
	APP_BASE_URL: 'https://kody.example',
	PACKAGE_APP_BASE_URL: 'https://apps.example',
} as unknown as Env

function resolve(address: string) {
	return resolveAppAddress({
		env,
		address,
		appBaseUrl: 'https://kody.example',
	})
}

test('an app address names the owning org as @org/app or as a hosted URL', async () => {
	expect(await resolve('@acme/board')).toEqual({
		ownerHandle: 'acme',
		appSlug: 'board',
		path: null,
	})
	expect(await resolve(' @acme/board/api/cards?x=1 ')).toEqual({
		ownerHandle: 'acme',
		appSlug: 'board',
		path: '/api/cards?x=1',
	})
	expect(await resolve('https://board--acme.apps.example/')).toEqual({
		ownerHandle: 'acme',
		appSlug: 'board',
		path: null,
	})
	expect(
		await resolve('https://board--acme.apps.example/api/cards?x=1'),
	).toEqual({ ownerHandle: 'acme', appSlug: 'board', path: '/api/cards?x=1' })
	expect(await resolve('https://board.example.org/export.csv')).toEqual({
		ownerHandle: 'acme',
		appSlug: 'board',
		path: '/export.csv',
		// The custom domain stays the app's host for the visit.
		customMount: {
			baseUrl: 'https://board.example.org',
			mount: 'custom-hostname',
		},
	})
	expect(await resolve('https://kody.example/@acme/board')).toEqual({
		ownerHandle: 'acme',
		appSlug: 'board',
		path: null,
	})
})

test('a path mount names the app by its first path segment', async () => {
	// The owner's shared host is not kept as the host of the visit.
	expect(await resolve('https://acme.apps.example/board/cards?x=1')).toEqual({
		ownerHandle: 'acme',
		appSlug: 'board',
		path: '/cards?x=1',
	})
	// An org's custom domain is, with the app mounted under its name.
	expect(await resolve('https://apps.example.org/board/cards?x=1')).toEqual({
		ownerHandle: 'acme',
		appSlug: 'board',
		path: '/cards?x=1',
		customMount: {
			baseUrl: 'https://apps.example.org/board',
			mount: 'user-subdomain',
		},
	})
	expect(await resolve('https://apps.example.org/board')).toMatchObject({
		path: null,
		customMount: { baseUrl: 'https://apps.example.org/board' },
	})
})

test('anything else is refused with the address forms to pass', async () => {
	for (const address of [
		'board',
		'ftp://board--acme.apps.example/',
		'https://elsewhere.example/@acme/board',
	]) {
		await expect(resolve(address)).rejects.toThrow(
			'Pass the app as @org/app or its hosted URL',
		)
	}
})
