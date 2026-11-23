import type { z } from 'zod'
import { parseJsonText } from '#worker/outbound/typed-failure.ts'
import { readRequestBodyUpTo } from '#worker/read-request-body-up-to.ts'

/**
 * Edge decoding for untrusted input. Every request handler decodes its body
 * with a zod schema here, so a malformed body becomes a typed failure the
 * handler maps to a 400 instead of an exception deeper in the code.
 */
export type UntrustedDecodeFailure =
	| { kind: 'body_too_large'; maxBytes: number; byteLength: number }
	| { kind: 'invalid_json'; message: string }
	| { kind: 'invalid_shape'; message: string }

export type UntrustedDecodeResult<Schema extends z.ZodType> =
	| { kind: 'ok'; value: z.output<Schema> }
	| UntrustedDecodeFailure

function describeIssues(issues: z.ZodError['issues']) {
	return issues
		.slice(0, 3)
		.map((issue) => {
			const path = issue.path.map(String).join('.')
			return path ? `${path}: ${issue.message}` : issue.message
		})
		.join('; ')
}

/** Decode an already-parsed untrusted value (a stored document, a header). */
export function decodeUntrusted<Schema extends z.ZodType>(
	schema: Schema,
	value: unknown,
):
	| { kind: 'ok'; value: z.output<Schema> }
	| { kind: 'invalid_shape'; message: string } {
	const result = schema.safeParse(value)
	if (result.success) return { kind: 'ok', value: result.data }
	return { kind: 'invalid_shape', message: describeIssues(result.error.issues) }
}

/** Read at most `maxBytes` of a JSON request body and decode it with `schema`. */
export async function decodeJsonRequestBody<Schema extends z.ZodType>(
	request: Request,
	input: { schema: Schema; maxBytes: number },
): Promise<UntrustedDecodeResult<Schema>> {
	const read = await readRequestBodyUpTo(request, input.maxBytes)
	if (!read.ok) {
		return {
			kind: 'body_too_large',
			maxBytes: input.maxBytes,
			byteLength: read.byteLength,
		}
	}
	const parsed = parseJsonText(new TextDecoder().decode(read.bytes))
	if (parsed.kind === 'invalid_json') return parsed
	return decodeUntrusted(input.schema, parsed.value)
}
