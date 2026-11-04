import { createServerFn } from '@tanstack/react-start'
import { getStartRequestEnv } from './request-env.ts'

export type GuestComesWithCounts = {
	packages?: number
	memories?: number
	jobs?: number
	runs?: number
}

export type GuestClaimPageError =
	| 'email_invalid'
	| 'code_missing'
	| 'code_invalid'
	| 'code_expired'
	| 'too_many_attempts'
	| 'send_failed'
	| 'already_claimed'
	| 'deleted'
	| 'username_invalid'
	| 'username_taken'
	| 'email_taken'
	| 'no_account'
	| 'merge_blocked'
	| 'no_verified_email'
	| 'account_unavailable'
	| 'provider_unavailable'

const pageErrors = new Set<GuestClaimPageError>([
	'email_invalid',
	'code_missing',
	'code_invalid',
	'code_expired',
	'too_many_attempts',
	'send_failed',
	'already_claimed',
	'deleted',
	'username_invalid',
	'username_taken',
	'email_taken',
	'no_account',
	'merge_blocked',
	'no_verified_email',
	'account_unavailable',
	'provider_unavailable',
])

export type GuestClaimPageData =
	| { kind: 'not_found' }
	| {
			kind: 'claimed'
			mode: 'new' | 'merge'
			username: string | null
			comesWith: GuestComesWithCounts
	  }
	| {
			kind: 'claim'
			code: string
			phase: 'active' | 'hold'
			fullAccessUntil: string
			deleteAt: string
			comesWith: GuestComesWithCounts
			signedInAccount: { username: string } | null
			providers: { github: boolean; google: boolean }
			step: 'choose' | 'code'
			codeEmail: string | null
			devCode: string | null
			error: GuestClaimPageError | null
	  }

function readCount(params: URLSearchParams, key: string) {
	const value = Number(params.get(key))
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function nonZero(counts: Record<string, number>): GuestComesWithCounts {
	const out: GuestComesWithCounts = {}
	for (const key of ['packages', 'memories', 'jobs', 'runs'] as const) {
		if ((counts[key] ?? 0) > 0) out[key] = counts[key]
	}
	return out
}

export const loadGuestClaimPage = createServerFn({ method: 'GET' })
	.validator((input: { code: string; search: string }) => {
		if (
			!input ||
			typeof input.code !== 'string' ||
			typeof input.search !== 'string'
		)
			throw new Error('Invalid claim input')
		return input
	})
	.handler(async ({ data }): Promise<GuestClaimPageData> => {
		const [
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ readAuthenticatedAppUser },
			{ readGuestAccountByClaimCode, guestPhase, guestEmailDomain },
			{ guestComesWithCounts },
			{ getOauthClientConfig },
		] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/authenticated-user.ts'),
			import('../../src/guest/guest-accounts.ts'),
			import('../../src/guest/guest-claim.ts'),
			import('../../src/app/oauth-providers.ts'),
		])
		const env = getStartRequestEnv()
		const request = getRequest()
		setAuthSessionSecret(env.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'private, no-store')
		setResponseHeader('Referrer-Policy', 'no-referrer')
		const params = new URLSearchParams(data.search)
		const user = await readAuthenticatedAppUser(request, env)
		if (params.get('result') === 'claimed') {
			return {
				kind: 'claimed',
				mode: params.get('mode') === 'merge' ? 'merge' : 'new',
				username:
					user && !user.email.endsWith(`@${guestEmailDomain}`)
						? user.username
						: null,
				comesWith: {
					packages: readCount(params, 'packages'),
					memories: readCount(params, 'memories'),
					jobs: readCount(params, 'jobs'),
					runs: readCount(params, 'runs'),
				},
			}
		}
		const guest = await readGuestAccountByClaimCode(env.APP_DB, data.code)
		if (!guest || guest.claimedAt || Date.parse(guest.deleteAt) <= Date.now()) {
			return { kind: 'not_found' }
		}
		const errorParam = params.get('error')
		const step = params.get('step') === 'code' ? 'code' : 'choose'
		return {
			kind: 'claim',
			code: data.code,
			phase: guestPhase(guest.expiresAt),
			fullAccessUntil: guest.expiresAt,
			deleteAt: guest.deleteAt,
			comesWith: nonZero(await guestComesWithCounts(env, guest)),
			signedInAccount:
				user && !user.email.endsWith(`@${guestEmailDomain}`)
					? { username: user.username }
					: null,
			providers: {
				github: Boolean(getOauthClientConfig(env, 'github')),
				google: Boolean(getOauthClientConfig(env, 'google')),
			},
			step,
			codeEmail: step === 'code' ? params.get('email') : null,
			devCode: step === 'code' ? params.get('dev_code') : null,
			error:
				errorParam && pageErrors.has(errorParam as GuestClaimPageError)
					? (errorParam as GuestClaimPageError)
					: null,
		}
	})
