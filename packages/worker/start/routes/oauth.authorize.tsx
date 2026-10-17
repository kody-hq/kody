import {
	oauthAuthorizeDocument,
	oauthAuthorizePost,
	rejectOAuthAuthorizeMethod,
} from '#start/server/oauth-protocol'
/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadOAuthPage } from '#start/server/oauth'
import { OAuthAuthorizeRoute } from '../pages/oauth-authorize.tsx'

export const Route = createFileRoute('/oauth/authorize')({
	server: {
		handlers: {
			GET: oauthAuthorizeDocument,
			POST: oauthAuthorizePost,
			HEAD: rejectOAuthAuthorizeMethod,
			PUT: rejectOAuthAuthorizeMethod,
			PATCH: rejectOAuthAuthorizeMethod,
			DELETE: rejectOAuthAuthorizeMethod,
			OPTIONS: rejectOAuthAuthorizeMethod,
		},
	},
	staticData: {
		documentNavigation: true,
		shell: { preserveLoginReturn: true },
	},
	head: staticDocumentHead('oauthAuthorize'),
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) => loadOAuthPage({ data: location.searchStr }),
	component: Page,
})

function Page() {
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<OAuthAuthorizeRoute key={location.searchStr} {...Route.useLoaderData()} />
	)
}
