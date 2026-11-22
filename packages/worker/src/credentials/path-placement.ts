import { z } from 'zod'
import { CredentialRequestRefusedError } from './credential-request.ts'

const segmentPattern = /^[a-zA-Z0-9_~-][a-zA-Z0-9._~-]{0,127}$/
const segment = z.string().regex(segmentPattern)

const origin = z
	.string()
	.max(500)
	.refine((value) => {
		try {
			const parsed = new URL(value)
			return parsed.protocol === 'https:' && parsed.origin === value
		} catch {
			return false
		}
	}, 'Use a canonical HTTPS origin.')

export const pathPlacementSchema = z.strictObject({
	kind: z.literal('path'),
	packageId: z.string().min(1).max(100),
	origin,
	method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
	segments: z
		.array(
			z.union([
				segment,
				z.strictObject({ parameter: z.enum(['slug', 'integer', 'uuid']) }),
				z.strictObject({ credential: z.literal(true) }),
			]),
		)
		.min(2)
		.max(24)
		.refine(
			(segments) =>
				segments.filter(
					(part) => typeof part === 'object' && 'credential' in part,
				).length === 1,
			'Include exactly one credential segment.',
		),
})

type PathPlacement = z.infer<typeof pathPlacementSchema>

function matchesParameter(
	value: string,
	parameter: 'slug' | 'integer' | 'uuid',
) {
	switch (parameter) {
		case 'slug':
			return /^[a-zA-Z0-9_-]{1,80}$/.test(value)
		case 'integer':
			return /^(?:0|[1-9]\d{0,19})$/.test(value)
		case 'uuid':
			return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
	}
}

export function preparePathPlacement(
	placement: PathPlacement,
	request: Request,
) {
	const url = new URL(request.url)
	const parts = url.pathname.slice(1).split('/')
	const output: Array<string> = []
	let parameterIndex = 0
	let secretIndex = -1
	const invalid = () =>
		new CredentialRequestRefusedError(
			'invalid_request',
			'This request does not match the approved credential path and method.',
		)
	if (
		url.origin !== placement.origin ||
		url.href !== `${url.origin}${url.pathname}` ||
		request.method !== placement.method
	)
		throw invalid()
	for (const part of placement.segments) {
		if (typeof part !== 'string' && 'credential' in part) {
			secretIndex = output.length
			output.push('')
			continue
		}
		const value = parts[parameterIndex++]
		if (
			value === undefined ||
			(typeof part === 'string'
				? value !== part
				: !matchesParameter(value, part.parameter))
		)
			throw invalid()
		output.push(value)
	}
	if (parts.length !== parameterIndex || secretIndex < 0) throw invalid()
	return (value: string) => {
		// Only allow a single unambiguous URL segment at an HTTP server, even
		// if that server decodes or normalizes its path before routing.
		if (!segmentPattern.test(value)) {
			throw new CredentialRequestRefusedError(
				'invalid_request',
				'This credential is not a valid single path segment.',
			)
		}
		output[secretIndex] = value
		url.pathname = `/${output.join('/')}`
		return { url, substitutedValues: [value, url.href] }
	}
}
