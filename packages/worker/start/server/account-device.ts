import { createServerFn } from '@tanstack/react-start'
import { getStartRequestEnv } from './request-env.ts'
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { AccountDeviceSignInView } from '../../src/app/account-device-sign-in.ts'

export type { AccountDeviceSignInView }

export const loadAccountDeviceSignIn = createServerFn({ method: 'GET' })
	.validator((search: string) => {
		if (
			typeof search !== 'string' ||
			(search !== '' && !search.startsWith('?'))
		)
			throw new Error('Invalid search')
		return search
	})
	.handler(async ({ data: search }): Promise<AccountDeviceSignInView> => {
		const [
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ loadAccountDeviceSignInView },
		] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/account-device-sign-in.ts'),
		])
		const env = getStartRequestEnv()
		setAuthSessionSecret(env.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'private, no-store')
		return loadAccountDeviceSignInView({
			request: getRequest(),
			env,
			error: new URLSearchParams(search).get('error'),
		})
	})
