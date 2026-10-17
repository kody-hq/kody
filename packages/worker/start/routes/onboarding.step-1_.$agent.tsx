/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadOnboardingRoute, onboardingQuery } from '../onboarding-query.ts'
import {
	type OnboardingLocation,
	readOnboardingAgentSegment,
} from '#universal/onboarding-process.ts'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute('/onboarding/step-1_/$agent')({
	context: ({ params }) => {
		const agent = readOnboardingAgentSegment(params.agent)
		return {
			onboardingSelection: {
				step: 1,
				agent: agent,
				valid: agent !== null,
			} satisfies OnboardingLocation,
		}
	},
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => ({ redirectTo: search.redirectTo }),
	loader: ({ context, location, preload }) =>
		loadOnboardingRoute(
			context.queryClient,
			onboardingQuery(context.actorKey, undefined),
			location,
			preload,
			context.onboardingSelection,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
})
