import { expect, test } from 'vitest'
import {
	buildAppleAppSiteAssociation,
	createAppleAppSiteAssociationHandler,
} from './desktop-app-links.ts'

// Mirrors Apple's component matching: `*` is any run of characters and the
// first matching component decides.
function opensInApp(path: string) {
	const { components } = buildAppleAppSiteAssociation().applinks.details[0]!
	for (const component of components) {
		const pattern = component['/']
			.split('*')
			.map((part: string) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*')
		if (new RegExp(`^${pattern}$`).test(path)) return !component.exclude
	}
	return false
}

test('desktop app opens app pages and leaves marketing, files, and auth flows to the browser', () => {
	const app = [
		'/account',
		'/account/secrets',
		'/account/packages/pkg_123/files/src/index.ts',
		'/@acme/-/overview',
		'/@acme/-/jobs/job_1',
		'/@kent',
		'/@kent/my-package',
		'/@kent/my-package/tree/main/src',
		'/onboarding',
		'/onboarding/step-2/gmail',
		'/admin',
		'/admin/users',
		'/community',
		'/community/listing_1',
	]
	const browser = [
		'/',
		'/docs',
		'/docs/getting-started',
		'/blog',
		'/blog/some-post',
		'/pricing',
		'/privacy',
		'/terms',
		'/features/packages',
		'/login',
		'/login/device',
		'/signup',
		'/desktop/login',
		'/desktop/session',
		'/oauth/authorize',
		'/oauth/callback',
		'/device',
		'/connect/oauth',
		'/verify-email',
		'/reset-password',
		'/join/token',
		'/claim/code',
		'/agent/claim',
		'/auth/github/callback',
		'/unsubscribe/tips',
		'/webhooks/stripe',
		'/api/me',
		'/mcp',
		'/.well-known/apple-app-site-association',
		'/account/export.json',
		'/account/packages.json',
		'/account/mcp-servers/oauth/callback',
		'/account/mcp-servers/logos/srv_1',
		'/account/repos/repo_1/icon/abc',
		'/@acme/-/auth/start',
		'/@kent/webhooks/pkg/hook/secret',
		'/@kent/packages/app/index.html',
		'/@kent/my-package/raw/main/README.md',
		'/@kent/my-package/assets/logo.png',
		'/@kent/my-package/icon/abc',
		'/community/listing_1/raw/main/README.md',
		'/community/listing_1/og.png',
	]
	expect(app.filter((path) => !opensInApp(path))).toEqual([])
	expect(browser.filter(opensInApp)).toEqual([])
})

test('apple-app-site-association is plain JSON for the signed desktop app id', async () => {
	const response = await createAppleAppSiteAssociationHandler()()
	expect(response.status).toBe(200)
	expect(response.headers.get('content-type')).toBe('application/json')
	expect(response.headers.get('location')).toBeNull()
	const body = (await response.json()) as ReturnType<
		typeof buildAppleAppSiteAssociation
	>
	expect(body.applinks.details[0]?.appIDs).toEqual([
		'7A84LHNSXV.codes.kody.desktop',
	])
})
