import { Effect } from 'effect'
import { outbound, type OutboundCallError } from '#worker/effect/outbound.ts'

export type R2ListPage = {
	readonly keys: ReadonlyArray<string>
	readonly cursor: string | undefined
}

/**
 * An R2 bucket whose every call is an outbound call: a span, the outbound
 * deadline, and a typed `OutboundCallError`. A body is read inside the same
 * call so the deadline covers the read too.
 */
export type R2Client = {
	readonly head: (key: string) => Effect.Effect<boolean, OutboundCallError>
	readonly getText: (
		key: string,
	) => Effect.Effect<string | null, OutboundCallError>
	readonly getBytes: (
		key: string,
	) => Effect.Effect<Uint8Array | null, OutboundCallError>
	readonly put: (
		key: string,
		body: string | Uint8Array,
		options?: R2PutOptions,
	) => Effect.Effect<void, OutboundCallError>
	readonly listPage: (
		prefix: string,
		cursor: string | undefined,
	) => Effect.Effect<R2ListPage, OutboundCallError>
	readonly delete: (
		keys: ReadonlyArray<string>,
	) => Effect.Effect<void, OutboundCallError>
}

export function makeR2Client(bucket: () => R2Bucket): R2Client {
	return {
		head: (key) =>
			outbound('r2.head', async () => (await bucket().head(key)) !== null),
		getText: (key) =>
			outbound('r2.get', async () => {
				const object = await bucket().get(key)
				return object ? await object.text() : null
			}),
		getBytes: (key) =>
			outbound('r2.get', async () => {
				const object = await bucket().get(key)
				return object ? new Uint8Array(await object.arrayBuffer()) : null
			}),
		put: (key, body, options) =>
			outbound('r2.put', async () => {
				await bucket().put(key, body, options)
			}),
		listPage: (prefix, cursor) =>
			outbound('r2.list', async () => {
				const page = await bucket().list({
					prefix,
					...(cursor ? { cursor } : {}),
				})
				return {
					keys: page.objects.map((object) => object.key),
					cursor: page.truncated ? page.cursor : undefined,
				}
			}),
		delete: (keys) =>
			outbound('r2.delete', async () => {
				await bucket().delete([...keys])
			}),
	}
}

/** Every key under `prefix`, following R2's list cursor. */
export const listAllKeys = Effect.fnUntraced(function* (
	client: R2Client,
	prefix: string,
) {
	const keys: Array<string> = []
	let cursor: string | undefined
	do {
		const page = yield* client.listPage(prefix, cursor)
		keys.push(...page.keys)
		cursor = page.cursor
	} while (cursor)
	return keys
})
