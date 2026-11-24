import {
	runPublicFormProtection,
	type PublicFormProtectionResult,
} from '#worker/effect/public-form-protection.ts'
import {
	honeypotFieldName,
	turnstileResponseFieldName,
} from '#universal/public-form-protection.ts'

export { honeypotFieldName, turnstileResponseFieldName }

type PublicFormBody = Record<string, unknown>

type PublicFormProtectionEnv = {
	TURNSTILE_SITE_KEY?: string | undefined
	TURNSTILE_SECRET_KEY?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

export function getTurnstileSiteKey(env: PublicFormProtectionEnv) {
	const siteKey = env.TURNSTILE_SITE_KEY?.trim()
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim()
	return siteKey && secretKey ? siteKey : null
}

export type { PublicFormProtectionResult }

export function checkPublicFormProtection(input: {
	env: PublicFormProtectionEnv
	request: Request
	body: PublicFormBody
}): Promise<PublicFormProtectionResult> {
	return runPublicFormProtection(input)
}

export async function verifyPublicFormProtection(
	input: Parameters<typeof checkPublicFormProtection>[0],
) {
	const result = await checkPublicFormProtection(input)
	return result.ok
		? result
		: {
				ok: false as const,
				response: Response.json(
					{ error: result.error },
					{ status: result.status ?? 400 },
				),
			}
}
