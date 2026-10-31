/**
 * Node-side handlers for the workerd → bridge `POST /gateway-fetch` hop:
 * mock MSW path (buffered) or prod CapabilityProxy streaming hop.
 */

import { type IncomingMessage, type ServerResponse } from 'node:http'
import {
	callCapabilityProxyGatewayFetchStream,
	gatewayFetchHeadersHeaderName,
	gatewayFetchMethodHeaderName,
	gatewayFetchPackageIdHeaderName,
	gatewayFetchUrlHeaderName,
	secretResolutionHeaderName,
	type CapabilityProxyClientInput,
} from './capability-proxy.js'
import { readBodyBuffer, writeWebResponse } from './local-runtime-bridge.js'
import { type MockFetchGateway } from './mock/mock-fetch-gateway.js'

function headerValue(
	headers: IncomingMessage['headers'],
	name: string,
): string | undefined {
	const value = headers[name.toLowerCase()]
	if (Array.isArray(value)) return value[0]
	return value
}

export async function forwardLocalGatewayFetchStream(input: {
	request: IncomingMessage
	response: ServerResponse
	signal: AbortSignal
	client: CapabilityProxyClientInput
	mockFetchGateway?: MockFetchGateway
}): Promise<void> {
	const url = headerValue(
		input.request.headers,
		gatewayFetchUrlHeaderName,
	)?.trim()
	if (!url) {
		await writeWebResponse(
			input.response,
			Response.json(
				{
					error: {
						code: 'invalid_request',
						message:
							'X-Kody-Gateway-Url is required and must be a non-empty absolute URL.',
					},
				},
				{ status: 400, headers: { 'Cache-Control': 'no-store' } },
			),
		)
		return
	}

	if (input.mockFetchGateway) {
		const body = await readBodyBuffer(input.request)
		const method =
			headerValue(
				input.request.headers,
				gatewayFetchMethodHeaderName,
			)?.trim() || 'GET'
		const packageId = headerValue(
			input.request.headers,
			gatewayFetchPackageIdHeaderName,
		)?.trim()
		const rawHeaders = headerValue(
			input.request.headers,
			gatewayFetchHeadersHeaderName,
		)
		let headers: Record<string, string> = {}
		if (rawHeaders) {
			try {
				const parsed = JSON.parse(rawHeaders) as unknown
				if (
					parsed != null &&
					typeof parsed === 'object' &&
					!Array.isArray(parsed)
				) {
					headers = Object.fromEntries(
						Object.entries(parsed as Record<string, unknown>).flatMap(
							([key, value]) =>
								typeof value === 'string' ? [[key, value] as const] : [],
						),
					)
				}
			} catch {
				await writeWebResponse(
					input.response,
					Response.json(
						{
							error: {
								code: 'invalid_request',
								message:
									'X-Kody-Gateway-Headers must be valid JSON: an object of header names to string values.',
							},
						},
						{ status: 400, headers: { 'Cache-Control': 'no-store' } },
					),
				)
				return
			}
		}
		const contentType = headerValue(input.request.headers, 'content-type')
		if (contentType) headers['content-type'] = contentType
		const resolution = headerValue(
			input.request.headers,
			secretResolutionHeaderName,
		)
		if (resolution) headers[secretResolutionHeaderName] = resolution
		const result = await input.mockFetchGateway.handle(
			{
				...(packageId ? { packageId } : {}),
				request: {
					url,
					method,
					headers,
					...(body.byteLength > 0
						? { bodyBase64: body.toString('base64') }
						: {}),
				},
			},
			input.signal,
		)
		const nullBody =
			result.status === 101 ||
			result.status === 103 ||
			result.status === 204 ||
			result.status === 205 ||
			result.status === 304
		const bytes = Buffer.from(result.bodyBase64 ?? '', 'base64')
		await writeWebResponse(
			input.response,
			new Response(nullBody ? null : bytes, {
				status: result.status,
				statusText: result.statusText,
				headers: result.headers,
			}),
		)
		return
	}

	const method = headerValue(
		input.request.headers,
		gatewayFetchMethodHeaderName,
	)
	const packageId = headerValue(
		input.request.headers,
		gatewayFetchPackageIdHeaderName,
	)
	const rawHeaders = headerValue(
		input.request.headers,
		gatewayFetchHeadersHeaderName,
	)
	let outboundHeaders: Record<string, string> | undefined
	if (rawHeaders) {
		try {
			const parsed = JSON.parse(rawHeaders) as unknown
			if (
				parsed != null &&
				typeof parsed === 'object' &&
				!Array.isArray(parsed)
			) {
				outboundHeaders = Object.fromEntries(
					Object.entries(parsed as Record<string, unknown>).flatMap(
						([key, value]) =>
							typeof value === 'string' ? [[key, value] as const] : [],
					),
				)
			}
		} catch {
			await writeWebResponse(
				input.response,
				Response.json(
					{
						error: {
							code: 'invalid_request',
							message:
								'X-Kody-Gateway-Headers must be valid JSON: an object of header names to string values.',
						},
					},
					{ status: 400, headers: { 'Cache-Control': 'no-store' } },
				),
			)
			return
		}
	}
	const contentType = headerValue(input.request.headers, 'content-type')
	const secretResolution = headerValue(
		input.request.headers,
		secretResolutionHeaderName,
	)
	const contentLength = headerValue(input.request.headers, 'content-length')
	const upstream = await callCapabilityProxyGatewayFetchStream({
		...input.client,
		signal: input.signal,
		gateway: {
			url,
			...(method ? { method } : {}),
			...(packageId ? { packageId } : {}),
			...(outboundHeaders ? { headers: outboundHeaders } : {}),
			...(contentType ? { contentType } : {}),
			...(secretResolution ? { secretResolution } : {}),
		},
		body: input.request,
		...(contentLength ? { contentLength } : {}),
	})
	await writeWebResponse(input.response, upstream)
}
