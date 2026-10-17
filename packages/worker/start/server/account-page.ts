import { getStartRequestEnv } from './request-env.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import { accountReturnLocation } from './auth-return-location.ts'

export const loadAccountPage = createServerFn({ method: 'GET' })
	.validator((search: string) => {
		if (
			typeof search !== 'string' ||
			(search !== '' && !search.startsWith('?'))
		)
			throw new Error('Invalid search')
		return search
	})
	.handler(async ({ data: search }) => {
		const [
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ requireAuthenticatedPageUser },
			{ loadAccountConnectionsData },
			{ loadAccountProfileData },
			{ loadOnboardingData },
			{ loadChecklist },
		] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/page-auth.ts'),
			import('../../src/app/account-connections-data.ts'),
			import('../../src/app/account-profile-data.ts'),
			import('../../src/app/onboarding-data.ts'),
			import('../../src/app/handlers/onboarding.ts'),
		])
		const appEnv = getStartRequestEnv()
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		const request = getRequest()
		setResponseHeader('Cache-Control', 'private, no-store')
		const pageUrl = new URL(request.url)
		pageUrl.pathname = '/account'
		pageUrl.search = search
		const user = await requireAuthenticatedPageUser(request, appEnv, {
			redirectTo: accountReturnLocation(
				request,
				pageUrl.pathname + pageUrl.search,
			),
		})
		if (user instanceof Response) {
			const cookie = user.headers.get('Set-Cookie')
			if (cookie) setResponseHeader('Set-Cookie', cookie)
			throw redirect({
				href: user.headers.get('Location') ?? '/login',
				statusCode: user.status,
			})
		}
		const [accountProfile, accountConnections, onboarding] = await Promise.all([
			loadAccountProfileData(user, appEnv),
			loadAccountConnectionsData({ env: appEnv, userId: user.userId }),
			loadOnboardingData({
				env: appEnv,
				requestUrl: pageUrl.href,
				personId: personalOrgId(user.mcpUser.userId),
				username: user.username,
				emailVerified: user.emailVerified,
			}),
		])
		if (user.emailVerified)
			onboarding.checklist = await loadChecklist(
				appEnv,
				personalOrgIdForPerson(user.mcpUser),
				personalOrgId(user.mcpUser.userId),
				user.username,
				onboarding.hasMcpClient,
				{ hasSecondMcpClient: onboarding.hasSecondMcpClient },
			)
		const payloads = { accountProfile, accountConnections, onboarding }
		// Profile, Security and Data share this resource, but own distinct route heads.
		return { payloads }
	})
