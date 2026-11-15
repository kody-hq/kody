/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import {
	handleNewsletterConfirmPost,
	rejectNewsletterMethod,
} from '#start/server/newsletter-protocol'
import { NewsletterConfirmRoute } from '../pages/newsletter.tsx'

export const Route = createFileRoute('/newsletter_/confirm')({
	server: {
		handlers: {
			POST: handleNewsletterConfirmPost,
			PUT: rejectNewsletterMethod,
			PATCH: rejectNewsletterMethod,
			DELETE: rejectNewsletterMethod,
			OPTIONS: rejectNewsletterMethod,
		},
	},
	staticData: { documentNavigation: true, sessionVerification: 'public' },
	head: staticDocumentHead('newsletterConfirm'),
	component: Page,
})

function Page() {
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<NewsletterConfirmRoute
			token={new URLSearchParams(location.searchStr).get('token') ?? ''}
		/>
	)
}
