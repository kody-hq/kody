import { createFileRoute, redirect } from '@tanstack/react-router'
import { routes } from '#universal/routes.ts'
export const Route = createFileRoute('/@{$orgSlug}_/-/packages')({
	staticData: {
		navigation: { rail: 'workspace', item: 'packages' },
		orgScope: {},
	},
	beforeLoad: ({ params, location }) => {
		throw redirect({
			href:
				routes.orgRepositories.href({ orgSlug: params.orgSlug }) +
				location.searchStr +
				(location.hash ? `#${location.hash}` : ''),
			statusCode: 301,
			headers: { 'Cache-Control': 'public, max-age=3600' },
		})
	},
})
