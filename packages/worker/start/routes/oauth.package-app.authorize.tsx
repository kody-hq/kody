import { createFileRoute } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'
import {
	packageAppOauthAuthorizeDocument,
	packageAppOauthAuthorizePost,
	rejectPackageAppOauthMethod,
} from '#start/server/package-app-oauth-protocol'
import { loadPackageAppOauthConsent } from '#start/server/package-app-oauth'
import { PackageAppOauthConsentPage } from '../pages/package-app-oauth-consent.tsx'
import { createElement } from 'react'

export const Route = createFileRoute('/oauth/package-app/authorize')({
	server: {
		handlers: {
			GET: packageAppOauthAuthorizeDocument,
			HEAD: packageAppOauthAuthorizeDocument,
			POST: packageAppOauthAuthorizePost,
			PUT: rejectPackageAppOauthMethod,
			PATCH: rejectPackageAppOauthMethod,
			DELETE: rejectPackageAppOauthMethod,
			OPTIONS: rejectPackageAppOauthMethod,
		},
	},
	staticData: {
		documentNavigation: true,
		sessionVerification: 'public',
		shell: { mode: 'focused', preserveLoginReturn: true },
	},
	head: staticDocumentHead('packageAppOauthAuthorize'),
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) =>
		loadPackageAppOauthConsent({ data: location.searchStr }),
	component: Page,
})
function Page() {
	return createElement(PackageAppOauthConsentPage, {
		data: Route.useLoaderData(),
	})
}
