import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { z } from 'zod'
import {
	bodyPlacementSchema,
	isCanonicalEndpoint,
	prepareBodyPlacements,
	readJsonPlacementBody,
} from './body-placement.ts'
import {
	CredentialRequestRefusedError,
	isCredentialPlacementHeader,
} from './credential-request.ts'
import type { CredentialFillSite } from './fill-placement.ts'
import type { ResolvedClientPlacement } from './credential-resolver.ts'

const credentialId = z.string().min(1).max(100)
const headerName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
const literal = z
	.string()
	.max(200)
	.regex(/^[\x20-\x7e]*$/)
const headerPart = z.union([literal, z.strictObject({ credentialId })])

const compositionSite = z.union([
	z.strictObject({
		kind: z.literal('header'),
		name: headerName,
		parts: z
			.array(headerPart)
			.min(1)
			.max(24)
			.refine((parts) => parts.some((part) => typeof part !== 'string')),
	}),
	z.strictObject({
		kind: z.literal('basic'),
		usernameId: credentialId,
		passwordId: credentialId,
	}),
	z.strictObject({
		kind: z.literal('query'),
		param: z.string().min(1).max(100),
		credentialId,
	}),
	z.strictObject({
		kind: z.literal('body'),
		credentialId,
		placement: bodyPlacementSchema,
	}),
	z.strictObject({
		kind: z.literal('connection'),
		connection: z.enum(['login', 'oauth']),
		credentialId,
		inject: z.union([
			z.strictObject({
				kind: z.literal('header'),
				name: headerName,
				format: literal,
			}),
			z.strictObject({
				kind: z.literal('query'),
				param: z.string().min(1).max(100),
			}),
		]),
	}),
])

export const credentialCompositionSchema = z
	.strictObject({
		kind: z.literal('composition'),
		packageId: z.string().min(1).max(100),
		endpoint: z.string().max(2000).refine(isCanonicalEndpoint),
		method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
		entryCredentialId: credentialId,
		publicBody: z.literal('application/json').optional(),
		sites: z.array(compositionSite).min(1).max(16),
	})
	.superRefine((profile, ctx) => {
		if (
			profile.publicBody &&
			(profile.method === 'GET' ||
				profile.method === 'HEAD' ||
				profile.sites.some((site) => site.kind === 'body'))
		) {
			ctx.addIssue({
				code: 'custom',
				message:
					'Approve a public JSON body only on a body-capable method without credential body fields.',
			})
		}
		const ids = compositionCredentialIds(profile)
		if (ids.size < 2 || ids.size > 8 || !ids.has(profile.entryCredentialId)) {
			ctx.addIssue({
				code: 'custom',
				message:
					'Approve two to eight credentials, including the entry credential.',
			})
		}
		for (const site of profile.sites) {
			if (
				site.kind === 'connection' &&
				(profile.entryCredentialId === site.credentialId ||
					profile.sites.filter((entry) =>
						siteCredentialIds(entry).includes(site.credentialId),
					).length !== 1 ||
					(site.connection === 'oauth' &&
						(site.inject.kind !== 'header' ||
							site.inject.name !== 'Authorization' ||
							site.inject.format !== 'Bearer {value}')))
			) {
				ctx.addIssue({
					code: 'custom',
					message:
						'A connection must occupy its own approved location. OAuth uses Authorization: Bearer.',
				})
			}
			if (
				site.kind === 'body' &&
				(site.placement.endpoint !== profile.endpoint ||
					site.placement.method !== profile.method ||
					site.placement.packageId !== profile.packageId)
			) {
				ctx.addIssue({
					code: 'custom',
					message:
						'Every body placement must use the composition package, method, and endpoint.',
				})
			}
		}
	})

export type CredentialComposition = z.infer<typeof credentialCompositionSchema>
type CompositionSite = z.infer<typeof compositionSite>

function siteCredentialIds(site: CompositionSite) {
	switch (site.kind) {
		case 'header':
			return site.parts.flatMap((part) =>
				typeof part === 'string' ? [] : [part.credentialId],
			)
		case 'basic':
			return [site.usernameId, site.passwordId]
		case 'query':
		case 'body':
		case 'connection':
			return [site.credentialId]
	}
}

function compositionCredentialIds(profile: CredentialComposition) {
	return new Set(profile.sites.flatMap(siteCredentialIds))
}

export function compositionFillSites(profile: CredentialComposition) {
	const byCredential = new Map<string, Array<CredentialFillSite>>()
	for (const site of profile.sites) {
		if (site.kind === 'connection') continue
		const fillSite: CredentialFillSite =
			site.kind === 'header' || site.kind === 'basic'
				? {
						part: 'header',
						name: site.kind === 'header' ? site.name : 'Authorization',
					}
				: { part: site.kind }
		for (const id of new Set(siteCredentialIds(site))) {
			const sites = byCredential.get(id) ?? []
			sites.push(fillSite)
			byCredential.set(id, sites)
		}
	}
	return byCredential
}

function refuse(message: string): never {
	throw new CredentialRequestRefusedError('invalid_request', message)
}

export async function prepareCredentialComposition(
	profile: CredentialComposition,
	request: Request,
) {
	if (request.url !== profile.endpoint || request.method !== profile.method) {
		refuse('This request does not match the approved credential composition.')
	}
	const bodies = profile.sites.filter((site) => site.kind === 'body')
	if (!profile.publicBody && bodies.length === 0 && request.body !== null) {
		refuse('A composed request must explicitly approve its body placement.')
	}
	const fieldNames = new Set<string>()
	for (const site of profile.sites) {
		if (site.kind === 'body') continue
		const location = site.kind === 'connection' ? site.inject : site
		const header =
			location.kind === 'basic'
				? 'authorization'
				: location.kind === 'header'
					? location.name.toLowerCase()
					: null
		const name =
			header === null
				? `query:${location.kind === 'query' ? location.param : ''}`
				: `header:${header}`
		if (
			fieldNames.has(name) ||
			(header !== null &&
				(!isCredentialPlacementHeader(header) || request.headers.has(header)))
		) {
			refuse(
				'Approved credential locations must be distinct and absent from the request.',
			)
		}
		fieldNames.add(name)
	}
	const applyBody = bodies.length
		? await prepareBodyPlacements(
				bodies.map(({ placement }) => placement),
				request,
			)
		: null
	const publicBody =
		profile.publicBody && request.body !== null
			? JSON.stringify(await readJsonPlacementBody(request))
			: undefined
	return (
		values: ReadonlyMap<string, string>,
		connectionRedactions: ReadonlyArray<string> = [],
	): ResolvedClientPlacement => {
		const value = (id: string) => {
			const material = values.get(id)
			if (material === undefined)
				refuse('An approved credential is unavailable.')
			return material
		}
		const url = new URL(profile.endpoint)
		const headers = new Headers({ 'user-agent': 'kody-agent/1.0' })
		const accept = request.headers.get('accept')
		if (accept) headers.set('accept', accept)
		const substitutedValues = new Set([
			...values.values(),
			...connectionRedactions,
		])
		for (const site of profile.sites) {
			switch (site.kind) {
				case 'header': {
					const header = site.parts
						.map((part) =>
							typeof part === 'string' ? part : value(part.credentialId),
						)
						.join('')
					if (!/^[\x20-\x7e]+$/.test(header))
						refuse('An approved header value is not valid.')
					headers.set(site.name, header)
					substitutedValues.add(header)
					break
				}
				case 'basic': {
					const username = value(site.usernameId)
					const password = value(site.passwordId)
					if (
						username.includes(':') ||
						/[\x00-\x1f\x7f]/.test(username + password)
					) {
						refuse('An approved Basic credential is not valid.')
					}
					const encoded = bytesToBase64(
						new TextEncoder().encode(`${username}:${password}`),
					)
					headers.set('authorization', `Basic ${encoded}`)
					substitutedValues.add(encoded)
					break
				}
				case 'query':
					url.searchParams.set(site.param, value(site.credentialId))
					break
				case 'connection':
					if (site.inject.kind === 'header') {
						const header = value(site.credentialId)
						if (!/^[\x20-\x7e]+$/.test(header))
							refuse('An approved header value is not valid.')
						headers.set(site.inject.name, header)
					} else {
						url.searchParams.set(site.inject.param, value(site.credentialId))
					}
					break
				case 'body':
					break
			}
		}
		const body = applyBody?.(bodies.map((site) => value(site.credentialId)))
		if (body || publicBody !== undefined) {
			headers.set('content-type', 'application/json')
		}
		if (body) {
			for (const text of body.substitutedValues) substitutedValues.add(text)
		}
		return {
			placement: {
				kind: 'composition',
				url,
				headers,
				body: body?.body ?? publicBody,
				sealed: body?.sealed ?? false,
			},
			substitutedValues: [...substitutedValues],
			shape: 'approved credential composition',
		}
	}
}
