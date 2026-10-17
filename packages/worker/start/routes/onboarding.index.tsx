/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadOnboardingRoute, onboardingQuery } from '../onboarding-query.ts'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute('/onboarding/')({
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => ({ redirectTo: search.redirectTo }),
	loader: ({ context, location, preload }) =>
		loadOnboardingRoute(
			context.queryClient,
			onboardingQuery(context.actorKey, undefined),
			location,
			preload,
			'index',
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
})
