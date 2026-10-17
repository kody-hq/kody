import * as Sentry from '@sentry/cloudflare'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { getRequestIp } from '#worker/audit-log.ts'
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

function readTrimmedString(body: PublicFormBody, fieldName: string) {
	const value = body[fieldName]
	return typeof value === 'string' ? value.trim() : ''
}

export function getTurnstileSiteKey(env: PublicFormProtectionEnv) {
	const siteKey = env.TURNSTILE_SITE_KEY?.trim()
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim()
	return siteKey && secretKey ? siteKey : null
}

export type PublicFormProtectionResult =
	| { ok: true }
	| { ok: false; error: string; status?: number }

const turnstileKeysMissingProductionMessage =
	'Production public forms require TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.'

export async function checkPublicFormProtection(input: {
	env: PublicFormProtectionEnv
	request: Request
	body: PublicFormBody
}): Promise<PublicFormProtectionResult> {
	if (readTrimmedString(input.body, honeypotFieldName)) {
		return {
			ok: false,
			error: 'Unable to submit this form.',
		}
	}

	const siteKey = input.env.TURNSTILE_SITE_KEY?.trim()
	const secretKey = input.env.TURNSTILE_SECRET_KEY?.trim()
	// Local development, previews, and tests may omit Turnstile. Every other
	// runtime (including unset SENTRY_ENVIRONMENT) must never fail open: refuse
	// with a server error and report to Sentry. Boot also refuses when keys are
	// missing (getEnv / env.ts).
	if (!siteKey || !secretKey) {
		if (isNonProductionRuntime(input.env)) return { ok: true }

		const error = new Error(turnstileKeysMissingProductionMessage)
		Sentry.captureException(error, {
			tags: {
				surface: 'public-form-protection',
				reason: 'turnstile-keys-missing',
			},
		})
		return {
			ok: false,
			error:
				'Human verification is not configured on this deployment. Please try again later.',
			status: 503,
		}
	}

	const token = readTrimmedString(input.body, turnstileResponseFieldName)
	if (!token) {
		return {
			ok: false,
			error: 'Please complete the human verification challenge.',
		}
	}

	const verificationBody = new URLSearchParams({
		secret: secretKey,
		response: token,
	})
	const requestIp = getRequestIp(input.request)
	if (requestIp) verificationBody.set('remoteip', requestIp)

	try {
		const response = await fetch(
			'https://challenges.cloudflare.com/turnstile/v0/siteverify',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: verificationBody,
			},
		)
		const payload = (await response.json().catch(() => null)) as {
			success?: unknown
			hostname?: unknown
		} | null
		if (response.ok && payload?.success === true) {
			// A token is bound to the hostname that rendered the widget. Without
			// this check a token minted on any other site sharing the sitekey
			// (a preview deploy, a phishing page embedding the widget) would be
			// accepted here.
			const expectedHostname = new URL(input.request.url).hostname
			if (
				typeof payload.hostname === 'string' &&
				payload.hostname.toLowerCase() === expectedHostname.toLowerCase()
			) {
				return { ok: true }
			}
			console.warn('turnstile-hostname-mismatch', {
				expected: expectedHostname,
				received:
					typeof payload.hostname === 'string' ? payload.hostname : null,
			})
		}
	} catch {
		// The challenge is configured, so a verification outage must not turn
		// into an authentication bypass.
	}

	return {
		ok: false,
		error: 'Human verification failed. Please try again.',
	}
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
