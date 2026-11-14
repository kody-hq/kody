import type { z } from 'zod'

type NativeOutputCheckEnv = {
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

/**
 * Native `/v1` handlers return plain objects with no output validation, so a
 * handler can drift from the `outputSchema` published in `/openapi.json`
 * (the `login_org` drop in #5102). Tests and local dev check every native
 * response; production and previews never run this.
 */
export function shouldCheckNativeOutput(env: unknown) {
	const runtime = env as NativeOutputCheckEnv
	return (
		runtime.SENTRY_ENVIRONMENT === 'test' ||
		runtime.WRANGLER_IS_LOCAL_DEV === 'true'
	)
}

export function assertNativeOutputMatchesSchema(input: {
	operationId: string
	outputSchema: z.ZodType
	result: unknown
}) {
	const parsed = input.outputSchema.safeParse(input.result)
	if (parsed.success) return
	const issues = parsed.error.issues
		.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
		.join('; ')
	throw new Error(
		`Native operation "${input.operationId}" returned a response that does not match its documented outputSchema (${issues}). Fix the handler or the schema in open-api/native-operations.ts so /openapi.json stays truthful.`,
	)
}
