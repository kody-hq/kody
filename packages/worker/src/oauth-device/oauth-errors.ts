import { jsonResponse } from '#worker/json-response.ts'

/** RFC 6749 section 5.2 style error body, never cached. */
export function oauthErrorResponse(
	error: string,
	description: string,
	status = 400,
	extra: Record<string, unknown> = {},
) {
	return jsonResponse(
		{ error, error_description: description, ...extra },
		{
			status,
			headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
		},
	)
}

export function readFormValue(form: FormData | null, key: string) {
	const value = form?.get(key)
	return typeof value === 'string' && value.length > 0 ? value : null
}

export async function readOAuthForm(request: Request) {
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.includes('application/x-www-form-urlencoded')) return null
	return await request.formData().catch(() => null)
}
