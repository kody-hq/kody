import { jsonResponse } from '#worker/json-response.ts'

export const appleAppSiteAssociationPath =
	'/.well-known/apple-app-site-association'

export const desktopAppId = '7A84LHNSXV.codes.kody.desktop'

type AppLinkComponent = { '/': string; exclude?: true; comment: string }

const browserOnly = (path: string, comment: string): AppLinkComponent => ({
	'/': path,
	exclude: true,
	comment,
})
const inApp = (path: string, comment: string): AppLinkComponent => ({
	'/': path,
	comment,
})

// The first matching component wins, so files, downloads, and callbacks under
// app paths are excluded before the app paths themselves. Anything unlisted
// (homepage, docs, blog, pricing, auth, and token flows) stays in the browser.
export const desktopAppLinkComponents: Array<AppLinkComponent> = [
	browserOnly('/account/*.json', 'Exports download in the browser'),
	browserOnly('/account/mcp-servers/oauth/*', 'OAuth callback'),
	browserOnly('/account/mcp-servers/logos/*', 'Image'),
	browserOnly('/account/repos/*', 'Image'),
	browserOnly('/@*/-/auth/*', 'Auth flow'),
	browserOnly('/@*/webhooks/*', 'Webhook endpoint'),
	browserOnly('/@*/packages/*', 'Hosted package app'),
	browserOnly('/@*/*/raw/*', 'Raw file'),
	browserOnly('/@*/*/assets/*', 'Package asset'),
	browserOnly('/@*/*/icon/*', 'Image'),
	browserOnly('/community/*/raw/*', 'Raw file'),
	browserOnly('/community/*/assets/*', 'Package asset'),
	browserOnly('/community/*/icon/*', 'Image'),
	browserOnly('/community/*/og.png', 'Image'),
	inApp('/account', 'Account'),
	inApp('/account/*', 'Account pages'),
	inApp('/@*', 'Org workspaces, profiles, and packages'),
	inApp('/onboarding', 'Onboarding'),
	inApp('/onboarding/*', 'Onboarding steps'),
	inApp('/admin', 'Admin'),
	inApp('/admin/*', 'Admin pages'),
	inApp('/community', 'Community listings'),
	inApp('/community/*', 'Community listing pages'),
]

export function buildAppleAppSiteAssociation() {
	return {
		applinks: {
			details: [
				{ appIDs: [desktopAppId], components: desktopAppLinkComponents },
			],
		},
	}
}

export function createAppleAppSiteAssociationHandler() {
	return async () =>
		jsonResponse(buildAppleAppSiteAssociation(), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'public, max-age=3600',
			},
		})
}
