import { createServerFn } from '@tanstack/react-start'
import { getStartRequestEnv } from './request-env.ts'
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { AgentClaimRequest } from '../../src/agent-registration/claim-types.ts'

export type AgentClaimPageError =
	| 'invalid_code'
	| 'rate_limited'
	| 'email_unverified'
	| 'org_error'

export type AgentClaimPageData =
	| { kind: 'signed_out'; redirectTo: string }
	| { kind: 'not_found' }
	| { kind: 'email_mismatch'; claimEmail: string; accountEmail: string }
	| { kind: 'email_unverified'; accountEmail: string }
	| {
			kind: 'consent'
			attemptToken: string
			request: AgentClaimRequest
			account: { email: string; displayName: string }
			error: AgentClaimPageError | null
	  }
	| { kind: 'done'; result: 'approved' | 'denied' }

const agentClaimPageErrors = new Set<AgentClaimPageError>([
	'invalid_code',
	'rate_limited',
	'email_unverified',
	'org_error',
])

function readAgentClaimPageError(
	value: string | null,
): AgentClaimPageError | null {
	return value && agentClaimPageErrors.has(value as AgentClaimPageError)
		? (value as AgentClaimPageError)
		: null
}

export const loadAgentClaimPage = createServerFn({ method: 'GET' })
	.validator((search: string) => {
		if (
			typeof search !== 'string' ||
			(search !== '' && !search.startsWith('?'))
		)
			throw new Error('Invalid search')
		return search
	})
	.handler(async ({ data: search }): Promise<AgentClaimPageData> => {
		const [
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ readAuthenticatedAppUser },
			{ lookupAgentClaim },
		] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/authenticated-user.ts'),
			import('../../src/agent-registration/verification.ts'),
		])
		const env = getStartRequestEnv()
		const request = getRequest()
		setAuthSessionSecret(env.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'private, no-store')
		setResponseHeader('Referrer-Policy', 'no-referrer')
		const params = new URLSearchParams(search)
		const result = params.get('result')
		if (result === 'approved' || result === 'denied') {
			return { kind: 'done', result }
		}
		const attemptToken = params.get('claim_attempt_token')?.trim() || null
		if (!attemptToken) return { kind: 'not_found' }
		const user = await readAuthenticatedAppUser(request, env)
		if (!user) {
			const redirectTo = new URL('/agent/claim', request.url)
			redirectTo.searchParams.set('claim_attempt_token', attemptToken)
			return {
				kind: 'signed_out',
				redirectTo: `${redirectTo.pathname}${redirectTo.search}`,
			}
		}
		const lookup = await lookupAgentClaim({
			env,
			user: { personId: user.mcpUser.userId, email: user.email },
			attemptToken,
		})
		if (lookup.kind === 'not_found') return { kind: 'not_found' }
		if (lookup.kind === 'email_mismatch') {
			return {
				kind: 'email_mismatch',
				claimEmail: lookup.claimEmail,
				accountEmail: user.email,
			}
		}
		if (!user.emailVerified) {
			return { kind: 'email_unverified', accountEmail: user.email }
		}
		return {
			kind: 'consent',
			attemptToken,
			request: lookup.request,
			account: { email: user.email, displayName: user.displayName },
			error: readAgentClaimPageError(params.get('error')),
		}
	})
