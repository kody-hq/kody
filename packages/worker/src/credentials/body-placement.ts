import { visit } from 'jsonc-parser'
import { z } from 'zod'
import { CredentialRequestRefusedError } from './credential-request.ts'
import { sealToRecipientPublicKey } from './sealed-box.ts'

const maxBodyBytes = 256 * 1024
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const fieldName = z
	.string()
	.min(1)
	.max(100)
	.refine((key) => !forbiddenKeys.has(key), 'This field name is reserved.')
const fieldPath = z
	.array(z.union([fieldName, z.int().min(0).max(999)]))
	.min(1)
	.max(12)
type FieldPath = z.infer<typeof fieldPath>

export function isCanonicalEndpoint(endpoint: string) {
	try {
		const url = new URL(endpoint)
		return (
			url.protocol === 'https:' &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			`${url.origin}${url.pathname}` === endpoint &&
			!/%|\/\//.test(url.pathname)
		)
	} catch {
		return false
	}
}

function overlaps(left: FieldPath, right: FieldPath): boolean {
	return left.length <= right.length
		? left.every((key, index) => key === right[index])
		: overlaps(right, left)
}

export const bodyPlacementSchema = z
	.strictObject({
		kind: z.literal('body'),
		packageId: z.string().min(1).max(100),
		endpoint: z
			.string()
			.max(2000)
			.refine(
				isCanonicalEndpoint,
				'Use a canonical HTTPS endpoint without user info, query, fragment, or encoded path segments.',
			),
		method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
		mediaType: z.literal('application/json'),
		fields: z.array(fieldPath).min(1).max(16),
		selectors: z
			.array(
				z.strictObject({
					path: fieldPath,
					value: z.union([z.string().max(1000), z.boolean(), z.int()]),
				}),
			)
			.max(16)
			.default([]),
		graphql: z
			.strictObject({
				document: z.string().min(1).max(20_000),
				operationName: z
					.string()
					.regex(/^[_A-Za-z][_0-9A-Za-z]*$/)
					.max(100),
			})
			.optional(),
		output: z
			.discriminatedUnion('format', [
				z.strictObject({ format: z.literal('plaintext') }),
				z.strictObject({
					format: z.literal('sealed-box-base64'),
					recipientPublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
					recipientKeyId: z.string().min(1).max(256),
					keyIdField: fieldPath,
				}),
			])
			.default({ format: 'plaintext' }),
	})
	.superRefine((placement, ctx) => {
		const writes = [...placement.fields]
		if (placement.output.format === 'sealed-box-base64') {
			writes.push(placement.output.keyIdField)
		}
		const paths = [...writes, ...placement.selectors.map(({ path }) => path)]
		for (const [index, path] of paths.entries()) {
			if (
				paths.slice(0, index).some((prior) => overlaps(prior, path)) ||
				typeof path[0] !== 'string' ||
				(placement.graphql &&
					(path[0] !== 'variables' ||
						path.length < 2 ||
						typeof path[1] !== 'string'))
			) {
				ctx.addIssue({
					code: 'custom',
					message:
						'Placement paths must be distinct, non-overlapping object fields (inside variables for GraphQL).',
				})
				return
			}
		}
		if (writes.some((path) => typeof path.at(-1) !== 'string')) {
			ctx.addIssue({
				code: 'custom',
				message: 'A placed value must end at an object field.',
			})
		}
		if (placement.graphql && placement.selectors.length === 0) {
			ctx.addIssue({
				code: 'custom',
				message: 'Pin at least one GraphQL resource selector.',
			})
		}
	})

export type BodyPlacement = z.infer<typeof bodyPlacementSchema>
type JsonObject = Record<string, unknown>

function refuse(message: string): never {
	throw new CredentialRequestRefusedError('invalid_request', message)
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJsonObject(request: Request) {
	if (!request.body)
		refuse('The credential placement requires a JSON object body.')
	const reader = request.body.getReader()
	const decoder = new TextDecoder('utf-8', { fatal: true })
	let text = ''
	let bytes = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			if (bytes > maxBodyBytes) {
				void reader.cancel().catch(() => {})
				refuse('The credential placement request body is too large.')
			}
			text += decoder.decode(value, { stream: true })
		}
		text += decoder.decode()
	} catch (error) {
		if (error instanceof CredentialRequestRefusedError) throw error
		void reader.cancel().catch(() => {})
		refuse('The credential placement requires a UTF-8 JSON body.')
	} finally {
		reader.releaseLock()
	}
	const containers: Array<Set<string> | null> = []
	function open(container: Set<string> | null) {
		if (containers.length >= 32)
			refuse('The credential placement body is nested too deeply.')
		containers.push(container)
	}
	const body: unknown = (() => {
		try {
			visit(
				text,
				{
					onObjectBegin: () => open(new Set()),
					onArrayBegin: () => open(null),
					onObjectEnd: () => {
						containers.pop()
					},
					onArrayEnd: () => {
						containers.pop()
					},
					onObjectProperty: (key) => {
						const keys = containers.at(-1)
						if (!keys || keys.has(key) || forbiddenKeys.has(key)) {
							refuse(
								'The credential placement body contains an ambiguous field.',
							)
						}
						keys.add(key)
					},
					onError: () =>
						refuse('The credential placement requires valid JSON.'),
				},
				{ disallowComments: true },
			)
			return JSON.parse(text)
		} catch (error) {
			if (error instanceof CredentialRequestRefusedError) throw error
			refuse('The credential placement requires valid JSON.')
		}
	})()
	if (!isObject(body))
		refuse('The credential placement requires a JSON object body.')
	return body
}

function child(container: unknown, key: string | number): unknown {
	if (typeof key === 'number' && Array.isArray(container)) {
		return Object.hasOwn(container, key) ? container[key] : undefined
	}
	if (typeof key === 'string' && isObject(container)) {
		return Object.hasOwn(container, key) ? container[key] : undefined
	}
	return undefined
}

function writableField(body: JsonObject, path: FieldPath) {
	const parent = path.slice(0, -1).reduce<unknown>(child, body)
	const key = path.at(-1)
	if (
		!isObject(parent) ||
		typeof key !== 'string' ||
		Object.hasOwn(parent, key)
	) {
		refuse(
			'Omit placed fields and supply their containing objects in the JSON body.',
		)
	}
	return (value: string) => {
		parent[key] = value
	}
}

export type PrepareBodyPlacement = Awaited<
	ReturnType<typeof prepareBodyPlacement>
>

/** Checks the owner-approved target and caller data before the resolver reads the value. */
export async function prepareBodyPlacement(
	placement: BodyPlacement,
	request: Request,
) {
	const apply = await prepareBodyPlacements([placement], request)
	return (value: string) => apply([value])
}

export async function prepareBodyPlacements(
	placements: ReadonlyArray<BodyPlacement>,
	request: Request,
) {
	const [placement] = placements
	if (
		!placement ||
		placements.some(
			(entry) =>
				entry.endpoint !== placement.endpoint ||
				entry.method !== placement.method ||
				JSON.stringify(entry.graphql) !== JSON.stringify(placement.graphql),
		)
	) {
		refuse('Body placements must agree on the approved request and operation.')
	}
	if (
		request.url !== placement.endpoint ||
		request.method !== placement.method ||
		!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(
			request.headers.get('content-type') ?? '',
		) ||
		request.headers.has('content-encoding')
	) {
		refuse(
			'This request does not match the approved credential placement endpoint, method, and media type.',
		)
	}
	const body = await readJsonObject(request)
	if (placement.graphql) {
		if (
			Object.keys(body).some((key) => key !== 'variables') ||
			!isObject(body.variables)
		) {
			refuse(
				'Supply only variables for this credential’s approved GraphQL operation.',
			)
		}
		body.query = placement.graphql.document
		body.operationName = placement.graphql.operationName
	}
	const paths = placements.flatMap(({ fields, output }) =>
		output.format === 'sealed-box-base64'
			? [...fields, output.keyIdField]
			: fields,
	)
	if (
		paths.some((path, index) =>
			paths.slice(0, index).some((other) => overlaps(path, other)),
		)
	) {
		refuse('Approved credential body fields must not overlap.')
	}
	const prepared = placements.map(({ fields, selectors, output }) => {
		for (const { path, value } of selectors) {
			if (
				paths.some((other) => overlaps(path, other)) ||
				path.reduce<unknown>(child, body) !== value
			) {
				refuse(
					'The request does not match the approved credential placement resource.',
				)
			}
		}
		return {
			setters: fields.map((path) => writableField(body, path)),
			output,
			setKeyId:
				output.format === 'sealed-box-base64'
					? writableField(body, output.keyIdField)
					: null,
		}
	})
	return (values: ReadonlyArray<string>) => {
		const substitutedValues = new Set<string>()
		let sealed = false
		for (const [index, { setters, output, setKeyId }] of prepared.entries()) {
			const value = values[index]!
			let wireValue = value
			if (output.format === 'sealed-box-base64') {
				try {
					wireValue = sealToRecipientPublicKey(value, output.recipientPublicKey)
				} catch {
					refuse(
						'The approved recipient key cannot be used for this credential placement.',
					)
				}
				setKeyId!(output.recipientKeyId)
				sealed = true
			}
			for (const set of setters) set(wireValue)
			substitutedValues.add(value)
			substitutedValues.add(wireValue)
		}
		return {
			body: JSON.stringify(body),
			substitutedValues: [...substitutedValues],
			sealed,
		}
	}
}
