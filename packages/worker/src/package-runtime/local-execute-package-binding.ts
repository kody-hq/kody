/**
 * Package identity for CLI `--local` runs (GHSA-5fv3-qv7j-rqf5 follow-up).
 *
 * Hosted runs keep each package's identity in host-built per-package
 * bindings, so sandbox code cannot name another package. Local runs talk to
 * origin through CapabilityProxy, which used to accept a plain package id from
 * the sandbox. Now the package graph mints one signed binding per package it
 * serves, the local runtime shim keeps those bindings module-private and sends
 * them in place of the id, and CapabilityProxy accepts only a binding it
 * signed for the same org and actor. A raw package id is refused. Origin still
 * checks `package:execute` on every use, so a binding is never more than the
 * actor's own access to that package.
 */
import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { z } from 'zod'

const bindingPrefix = 'kpb1.'
// One graph serves one local run. `kody dev` keeps a graph for its whole
// generation, so a dev session left running past this lifetime gets the
// error below on package-scoped calls until it is restarted (or a source
// change starts a new generation, which fetches a fresh graph).
const bindingLifetimeMs = 24 * 60 * 60 * 1000
const signingInfo = new TextEncoder().encode(
	'kody/local-execute-package-binding/v1',
)

const bindingPayloadSchema = z.object({
	pkg: z.string().min(1),
	org: z.string().min(1),
	actor: z.string().min(1).nullable(),
	exp: z.number(),
	// The run's entry packages, so a dependency's credential mappings come
	// from the entry (ADR 0068 amendment 2026-10-27). Absent on older tokens.
	entries: z.array(z.string().min(1)).optional(),
})

export type LocalExecutePackageBinding = z.infer<typeof bindingPayloadSchema>

export type LocalExecutePackageBindingSubject = {
	/** Org owner id (`ownerIdFromCaller`). */
	org: string
	/** Acting person (`request.actor.userId`), when the caller has one. */
	actor: string | null
}

const signingKeys = new Map<string, Promise<CryptoKey>>()

function signingKey(secretStoreKey: string) {
	let key = signingKeys.get(secretStoreKey)
	if (!key) {
		key = (async () => {
			const base = await crypto.subtle.importKey(
				'raw',
				new TextEncoder().encode(secretStoreKey),
				'HKDF',
				false,
				['deriveKey'],
			)
			return await crypto.subtle.deriveKey(
				{
					name: 'HKDF',
					hash: 'SHA-256',
					salt: new Uint8Array(),
					info: signingInfo,
				},
				base,
				{ name: 'HMAC', hash: 'SHA-256', length: 256 },
				false,
				['sign', 'verify'],
			)
		})()
		signingKeys.set(secretStoreKey, key)
	}
	return key
}

export function isLocalExecutePackageBindingToken(value: unknown) {
	return typeof value === 'string' && value.startsWith(bindingPrefix)
}

export async function signLocalExecutePackageBinding(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	packageId: string
	subject: LocalExecutePackageBindingSubject
	entryPackageIds?: ReadonlyArray<string>
	now?: number
}) {
	const payload: LocalExecutePackageBinding = {
		pkg: input.packageId,
		org: input.subject.org,
		actor: input.subject.actor,
		exp: (input.now ?? Date.now()) + bindingLifetimeMs,
		...(input.entryPackageIds?.length
			? { entries: [...input.entryPackageIds] }
			: {}),
	}
	const body = bytesToBase64Url(
		new TextEncoder().encode(JSON.stringify(payload)),
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		await signingKey(input.env.SECRET_STORE_KEY),
		new TextEncoder().encode(body),
	)
	return `${bindingPrefix}${body}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/** Sign one binding per package id, keyed by id. */
export async function signLocalExecutePackageBindings(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	packageIds: Iterable<string>
	subject: LocalExecutePackageBindingSubject
	/** The graph's entry packages, in precedence order, signed into each. */
	entryPackageIds?: ReadonlyArray<string>
	now?: number
}) {
	const bindings = new Map<string, string>()
	for (const packageId of new Set(input.packageIds)) {
		if (!packageId) continue
		bindings.set(
			packageId,
			await signLocalExecutePackageBinding({
				env: input.env,
				packageId,
				subject: input.subject,
				...(input.entryPackageIds
					? { entryPackageIds: input.entryPackageIds }
					: {}),
				...(input.now === undefined ? {} : { now: input.now }),
			}),
		)
	}
	return bindings
}

export class LocalExecutePackageBindingError extends Error {
	constructor() {
		super(
			'This package identity is not valid for this local run. Package identity comes from the package graph and lasts 24 hours; rerun the command (or restart `kody dev`) so the CLI fetches a fresh graph.',
		)
		this.name = 'LocalExecutePackageBindingError'
	}
}

/**
 * The package id a binding names, when its signature holds, it has not
 * expired, and it was minted for this org and actor. Anything else, raw
 * package ids included, throws without saying which check failed.
 */
export async function verifyLocalExecutePackageBinding(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	token: unknown
	subject: LocalExecutePackageBindingSubject
	now?: number
}): Promise<string> {
	return (await verifyLocalExecutePackageBindingClaims(input)).packageId
}

/** `verifyLocalExecutePackageBinding` plus the run entries it was signed with. */
export async function verifyLocalExecutePackageBindingClaims(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	token: unknown
	subject: LocalExecutePackageBindingSubject
	now?: number
}): Promise<{ packageId: string; entryPackageIds: Array<string> }> {
	const fail = () => new LocalExecutePackageBindingError()
	const token = typeof input.token === 'string' ? input.token.trim() : ''
	if (!token.startsWith(bindingPrefix)) throw fail()
	const [body, signature, extra] = token.slice(bindingPrefix.length).split('.')
	if (!body || !signature || extra !== undefined) throw fail()
	let valid = false
	try {
		valid = await crypto.subtle.verify(
			'HMAC',
			await signingKey(input.env.SECRET_STORE_KEY),
			base64UrlToBytes(signature),
			new TextEncoder().encode(body),
		)
	} catch {
		throw fail()
	}
	if (!valid) throw fail()
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)))
	} catch {
		throw fail()
	}
	const binding = bindingPayloadSchema.safeParse(parsed)
	if (
		!binding.success ||
		binding.data.exp <= (input.now ?? Date.now()) ||
		binding.data.org !== input.subject.org ||
		binding.data.actor !== input.subject.actor
	) {
		throw fail()
	}
	return {
		packageId: binding.data.pkg,
		entryPackageIds: binding.data.entries ?? [],
	}
}
