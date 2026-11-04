/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadGuestClaimPage } from '#start/server/guest-claim'
import {
	handleGuestClaimPost,
	rejectGuestClaimMethod,
} from '#start/server/guest-claim-protocol'
import { GuestClaimRoute } from '../pages/guest-claim.tsx'

export const Route = createFileRoute('/claim/$code')({
	server: {
		handlers: {
			POST: handleGuestClaimPost,
			PUT: rejectGuestClaimMethod,
			PATCH: rejectGuestClaimMethod,
			DELETE: rejectGuestClaimMethod,
			OPTIONS: rejectGuestClaimMethod,
		},
	},
	staticData: {
		documentNavigation: true,
	},
	head: () => ({
		meta: [
			{ title: 'Claim your Kody account' },
			{ name: 'robots', content: 'noindex' },
		],
	}),
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ params, location }) =>
		loadGuestClaimPage({
			data: { code: params.code, search: location.searchStr },
		}),
	component: Page,
})

function Page() {
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<GuestClaimRoute key={location.searchStr} data={Route.useLoaderData()} />
	)
}
