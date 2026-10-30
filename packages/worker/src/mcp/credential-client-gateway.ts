/**
 * The fetch gateway's half of a `credential()` client fetch (ADR 0068). Code
 * sends the client's handle in an out-of-band header; the gateway strips it,
 * places the credential through the door (which checks Use, hosts, and HTTPS
 * on every request), and sends the request with redirects held back, so the
 * client re-authorizes every hop by sending it through here again.
 *
 * The placement is resolved before placeholders expand: the code's own value
 * for the placed header or param is dropped first so a placeholder there never
 * resolves, and a `url` credential's request expands against the host it is
 * really sent to.
 */
import {
	applyCredentialClient,
	CredentialClientError,
	type CredentialClientPlacement,
} from '#worker/credentials/credential-client.ts'
import { createPackageAppCredentialAuthority } from '#worker/package-runtime/package-app-authority.ts'
import { withLanding } from './secrets/echo-redaction.ts'
import { type FetchGatewayProps } from './fetch-gateway.ts'

/** Response header naming the inject shape (never a value) on a 401 / 403. */
export const credentialClientHintHeaderName = 'x-kody-credential-hint'

export async function resolveCredentialClientPlacement(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	props: FetchGatewayProps
	token: string
	request: Request
	rejectedLoginSessionId?: string | null
}) {
	return await applyCredentialClient({
		env: input.env as Env,
		request: input.props.request,
		baseUrl: input.props.baseUrl,
		packageId:
			input.props.claimedPackageId ??
			input.props.storageContext?.packageId ??
			null,
		binding: input.props.credentialClientBinding,
		ownerCredentialScope: input.props.ownerCredentialScope ?? null,
		packageAppAuthority: input.props.packageAppAuthority
			? createPackageAppCredentialAuthority({
					env: input.env,
					scope: input.props.packageAppAuthority.scope,
					grantScope: input.props.packageAppAuthority.grantScope,
					visitorRequest:
						input.props.executorVisitorRequest ?? input.props.request,
					issue: null,
				})
			: null,
		token: input.token,
		requestUrl: new URL(input.request.url),
		rejectedLoginSessionId: input.rejectedLoginSessionId ?? null,
	})
}

/** The code's request with whatever the placement replaces taken out. */
export function withoutCodePlacement(
	request: Request,
	placement: CredentialClientPlacement,
) {
	const url = new URL(request.url)
	const headers = new Headers(request.headers)
	switch (placement.kind) {
		case 'header':
			headers.delete(placement.name)
			break
		case 'query':
			url.searchParams.delete(placement.param)
			break
		case 'url': {
			const rebased = new URL(
				`${url.pathname}${url.search}`,
				placement.url.origin,
			)
			url.href = rebased.href
			break
		}
		default: {
			const exhaustive: never = placement
			throw new Error(`Unhandled placement: ${String(exhaustive)}`)
		}
	}
	return rebuild(request, url, headers)
}

/** The expanded request with the credential placed and redirects held back. */
export function applyCredentialClientPlacement(
	request: Request,
	placement: CredentialClientPlacement,
	stripped: Request,
) {
	const url = new URL(request.url)
	const headers = new Headers(request.headers)
	switch (placement.kind) {
		case 'header':
			headers.set(placement.name, placement.value)
			return rebuild(request, url, headers)
		case 'query':
			url.searchParams.set(placement.param, placement.value)
			return rebuild(request, url, headers)
		case 'url': {
			const before = new URL(stripped.url)
			if (
				`${url.pathname}${url.search}` !== `${before.pathname}${before.search}`
			) {
				throw new CredentialClientError({
					code: 'invalid_request',
					message:
						"A url credential's request path and query can't carry secret placeholders.",
					retryWith: [],
				})
			}
			return rebuild(request, placement.url, headers)
		}
		default: {
			const exhaustive: never = placement
			throw new Error(`Unhandled placement: ${String(exhaustive)}`)
		}
	}
}

function rebuild(request: Request, url: URL, headers: Headers) {
	const body = request.body
	return new Request(url, {
		method: request.method,
		headers,
		body,
		redirect: 'manual',
		signal: request.signal,
		...(body ? { duplex: 'half' as const } : {}),
	})
}

export function withCredentialClientHint(response: Response, shape: string) {
	if (response.status !== 401 && response.status !== 403) return response
	const headers = new Headers(response.headers)
	headers.set(credentialClientHintHeaderName, shape)
	return withLanding(
		new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		}),
		{ url: response.url, redirected: response.redirected },
	)
}
