/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadNewsletterPage } from '#start/server/newsletter'
import {
	handleNewsletterSignupPost,
	rejectNewsletterMethod,
} from '#start/server/newsletter-protocol'
import { NewsletterRoute } from '../pages/newsletter.tsx'

export const Route = createFileRoute('/newsletter')({
	server: {
		handlers: {
			POST: handleNewsletterSignupPost,
			PUT: rejectNewsletterMethod,
			PATCH: rejectNewsletterMethod,
			DELETE: rejectNewsletterMethod,
			OPTIONS: rejectNewsletterMethod,
		},
	},
	staticData: { documentNavigation: true, sessionVerification: 'public' },
	head: staticDocumentHead('newsletter'),
	loaderDeps: ({ search }) => search,
	loader: ({ location }) => loadNewsletterPage({ data: location.searchStr }),
	component: Page,
})

function Page() {
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<NewsletterRoute key={location.searchStr} data={Route.useLoaderData()} />
	)
}
