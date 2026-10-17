import { normalizeRedirectTo } from '#app/auth-redirect.ts'

export function resolvePostVerificationRedirect(request: Request) {
	const redirectTo = normalizeRedirectTo(
		new URL(request.url).searchParams.get('redirectTo'),
	)
	return new URL(redirectTo ?? '/onboarding', request.url)
}
