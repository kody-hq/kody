import { createFileRoute, redirect } from '@tanstack/react-router'
export const Route = createFileRoute('/features_/integrations')({
	staticData: { sessionVerification: 'public' },
	beforeLoad: ({ location }) => {
		throw redirect({
			href: `/features/credentials${location.searchStr}`,
			statusCode: 301,
			headers: { 'Cache-Control': 'public, max-age=3600' },
		})
	},
})
