/** @jsxImportSource @emotion/react */
import { useCallback } from 'react'
import { type OnboardingLocation } from '#universal/onboarding-process.ts'
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute, useMatches } from '@tanstack/react-router'
import { usePageQuery } from '../page-query.ts'
import { onboardingQuery, onboardingNeedsRefresh } from '../onboarding-query.ts'
import { OnboardingRoute } from '../pages/onboarding.tsx'

export const Route = createFileRoute('/onboarding')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		motionGroup: 'onboarding',
		shell: { gutters: 'page' },
	},
	head: staticDocumentHead('onboarding'),
	component: OnboardingLayout,
})
function OnboardingLayout() {
	const selection = useMatches({
		select: (matches): OnboardingLocation | null => {
			for (const match of [...matches].reverse()) {
				if ('onboardingSelection' in match.context)
					return match.context.onboardingSelection
			}
			return null
		},
	})
	const { actorKey } = Route.useRouteContext()
	const { data, refetch } = usePageQuery({
		...onboardingQuery(actorKey, undefined),
		refetchInterval: (query) =>
			onboardingNeedsRefresh(query.state.data?.payload) ? 4000 : false,
	})
	const refresh = useCallback(() => {
		if (data.payload.loggedIn) void refetch({ cancelRefetch: false })
	}, [data.payload.loggedIn, refetch])
	return (
		<OnboardingRoute
			payload={data.payload}
			selection={selection}
			initialAgentChooser={data.onboardingAgentChooser}
			refresh={refresh}
		/>
	)
}
