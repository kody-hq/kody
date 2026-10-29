import { redirect } from '@tanstack/react-router'
import { type QueryClient } from '@tanstack/react-query'
import { loadOnboarding } from '#start/server/onboarding'
import { createPageQuery, ensurePageQuery } from './page-query.ts'
import { type OnboardingPayload } from '#universal/onboarding-types.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	onboardingIndexRedirectHref,
	onboardingWizardStepHref,
	type OnboardingLocation,
} from '#universal/onboarding-process.ts'
import { absolutizeDocumentHead } from '#universal/document-head-contract.ts'

export const onboardingQuery = createPageQuery('loadOnboarding', loadOnboarding)

export function onboardingNeedsRefresh(payload: OnboardingPayload | undefined) {
	return Boolean(
		payload?.loggedIn &&
		!(
			payload.hasMcpClient &&
			payload.hasAccessWin &&
			payload.hasSecondMcpClient
		),
	)
}

export async function loadOnboardingRoute(
	queryClient: QueryClient,
	options: ReturnType<typeof onboardingQuery>,
	location: { pathname: string; searchStr: string },
	preload: boolean,
	selection: OnboardingLocation | 'index',
) {
	const [{ payload, canonicalBaseUrl }, { resolveDocumentHead }] =
		await Promise.all([
			ensurePageQuery(queryClient, options, preload),
			import('#universal/document-head-resolver.ts'),
		])
	const search = location.searchStr
	const redirectTo = normalizeRedirectTo(
		new URLSearchParams(search).get('redirectTo'),
	)
	if (payload.loggedIn && !payload.emailVerified)
		throw redirect({
			href: `/pending-verification${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ''}`,
		})
	if (selection === 'index')
		throw redirect({ href: onboardingIndexRedirectHref(search, payload) })
	if (!selection.valid)
		throw redirect({ href: onboardingWizardStepHref(selection.step, search) })
	return {
		head: absolutizeDocumentHead(
			resolveDocumentHead(
				'onboarding',
				location.pathname,
				{ onboarding: payload },
				search,
			),
			canonicalBaseUrl,
		),
	}
}
