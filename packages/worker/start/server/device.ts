import { createServerFn } from '@tanstack/react-start'
import { getStartRequestEnv } from './request-env.ts'
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { DeviceVerificationRequest } from '../../src/oauth-device/verification.ts'
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { AccountDeviceVerificationRequest } from '../../src/app/account-device-sign-in.ts'

export type DevicePageError =
	| 'invalid_code'
	| 'not_found'
	| 'rate_limited'
	| 'email_unverified'
	| 'org_error'
	| 'confirm_required'

export type DevicePageData =
	| { kind: 'signed_out'; userCode: string | null; redirectTo: string }
	| {
			kind: 'enter'
			userCode: string | null
			error: DevicePageError | null
	  }
	| {
			kind: 'consent'
			request: DeviceVerificationRequest
			account: { email: string; displayName: string }
			error: DevicePageError | null
	  }
	| {
			/** A browser asking to sign in to the full Kody account (ADR 0094). */
			kind: 'account_consent'
			request: AccountDeviceVerificationRequest
			account: { email: string; displayName: string }
			error: DevicePageError | null
	  }
	| {
			kind: 'done'
			result: 'approved' | 'denied'
			/** Who was signed in: the Kody CLI, a package app, or a browser. */
			target: 'cli' | 'package_app' | 'account'
	  }

const devicePageErrors = new Set<DevicePageError>([
	'invalid_code',
	'not_found',
	'rate_limited',
	'email_unverified',
	'org_error',
	'confirm_required',
])

function readDevicePageError(value: string | null): DevicePageError | null {
	return value && devicePageErrors.has(value as DevicePageError)
		? (value as DevicePageError)
		: null
}

export const loadDevicePage = createServerFn({ method: 'GET' })
	.validator((search: string) => {
		if (
			typeof search !== 'string' ||
			(search !== '' && !search.startsWith('?'))
		)
			throw new Error('Invalid search')
		return search
	})
	.handler(async ({ data: search }): Promise<DevicePageData> => {
		const [
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ readAuthenticatedAppUser },
			{ lookupDeviceAuthorization },
			{ redirect },
		] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/authenticated-user.ts'),
			import('../../src/oauth-device/verification.ts'),
			import('@tanstack/react-router'),
		])
		const env = getStartRequestEnv()
		const request = getRequest()
		setAuthSessionSecret(env.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'private, no-store')
		const params = new URLSearchParams(search)
		const result = params.get('result')
		if (result === 'approved' || result === 'denied') {
			const kind = params.get('kind')
			return {
				kind: 'done',
				result,
				target: kind === 'package_app' || kind === 'account' ? kind : 'cli',
			}
		}
		const userCode = params.get('user_code')?.trim() || null
		const user = await readAuthenticatedAppUser(request, env)
		if (!user) {
			const redirectTo = new URL('/device', request.url)
			if (userCode) redirectTo.searchParams.set('user_code', userCode)
			return {
				kind: 'signed_out',
				userCode,
				redirectTo: `${redirectTo.pathname}${redirectTo.search}`,
			}
		}
		const error = readDevicePageError(params.get('error'))
		if (!userCode) {
			return { kind: 'enter', userCode: null, error }
		}
		const lookup = await lookupDeviceAuthorization({
			request,
			env,
			user: { personId: user.mcpUser.userId, email: user.email },
			userCode,
		})
		if (lookup.kind === 'package_app') {
			// App visitor sign-ins are approved on that app's consent screen.
			const consent = new URL('/oauth/package-app/authorize', request.url)
			consent.searchParams.set('device_user_code', lookup.userCode)
			throw redirect({
				href: `${consent.pathname}${consent.search}`,
				reloadDocument: true,
			})
		}
		if (lookup.kind === 'account') {
			return {
				kind: 'account_consent',
				request: lookup.request,
				account: { email: user.email, displayName: user.displayName },
				error,
			}
		}
		if (lookup.kind !== 'found') {
			return {
				kind: 'enter',
				userCode,
				error: lookup.kind,
			}
		}
		return {
			kind: 'consent',
			request: lookup.request,
			account: { email: user.email, displayName: user.displayName },
			error,
		}
	})
