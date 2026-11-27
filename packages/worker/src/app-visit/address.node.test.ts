import { expect, test, vi } from 'vitest'

vi.mock('#app/package-app-origin.ts', () => ({
	resolveVerifiedCustomHostnameIfEnabled: async (request: Request) =>
		new URL(request.url).host === 'board.example.org'
			? { bindingKind: 'app', username: 'acme', kodyId: 'board' }
			: null,
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
