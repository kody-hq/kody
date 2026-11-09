import {
	array,
	createSchema,
	fail,
	literal,
	object,
	optional,
	string,
	type InferOutput,
	union,
} from 'remix/data-schema'
import { minLength } from 'remix/data-schema/checks'

const nonEmptyStringSchema = string().pipe(minLength(1))

const optionalHeadersSchema = createSchema<
	unknown,
	Record<string, string> | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	) {
		return fail('Expected headers object', context.path)
	}
	const headers: Record<string, string> = {}
	for (const [key, headerValue] of Object.entries(value)) {
		if (typeof headerValue !== 'string') {
			return fail(`Expected string header value for "${key}"`, context.path)
		}
		headers[key] = headerValue
	}
	return { value: headers }
})

const outboundEmailAttachmentSchema = object({
	/** Base64-encoded bytes, as the Cloudflare Email REST API expects. */
	content: nonEmptyStringSchema,
	filename: nonEmptyStringSchema,
	type: nonEmptyStringSchema,
	disposition: union([literal('attachment'), literal('inline')]),
	contentId: optional(nonEmptyStringSchema),
})

const outboundEmailSchema = object({
	from: nonEmptyStringSchema,
	to: union([nonEmptyStringSchema, array(nonEmptyStringSchema)]),
	subject: nonEmptyStringSchema,
	html: nonEmptyStringSchema,
	text: optional(nonEmptyStringSchema),
	replyTo: optional(nonEmptyStringSchema),
	headers: optionalHeadersSchema,
	attachments: optional(array(outboundEmailAttachmentSchema)),
})

export type OutboundEmail = InferOutput<typeof outboundEmailSchema>

export { outboundEmailSchema }
