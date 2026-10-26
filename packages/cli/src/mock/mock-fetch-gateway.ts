/**
 * Node-side mock outbound fetch gateway: match MSW handlers from
 * `.kody/mocks.ts`, optionally passthrough allowlisted hosts to real network,
 * otherwise fail closed with `unmocked_request` + a paste-ready handler stub.
 *
 * On `--target mock`, *every* outbound hop (ambient `fetch`, `credential().fetch`,
 * `createAuthenticatedFetch` / `kody.authenticatedFetch`, `kody.gatewayFetch`,
 * and `kody.gatewayFetchStream`) goes through this gateway. Packages without
 * `.kody/mocks.ts` use public-network passthrough for ambient/gatewayFetch
 * (authenticatedFetch still fails closed). With `.kody/mocks.ts`, unmatched
 * hosts fail closed with `unmocked_request`.
 */

import { StructuredCliError } from '../structured-error.js'
import { type KodyTarget } from '../target.js'
import { type EnsureMswInput, importMsw } from './ensure-msw.js'
import { loadPackageMocks } from './load-package-mocks.js'

export type MockGatewayFetchRequest = {
	url?: string
	method?: string
	headers?: Record<string, string>
	bodyBase64?: string
}

export type MockGatewayFetchResult = {
	status: number
	statusText: string
	headers: Record<string, string>
	bodyBase64: string
}

export type MockFetchGateway = {
	/**
	 * True when `.kody/mocks.ts` loaded — install the ambient fetch shim and
	 * fail closed on unmatched hosts (unless `--passthrough`).
	 */
	enabled: boolean
	/** Fail-closed MSW mode vs public-network passthrough when no mocks file. */
	mode: 'msw' | 'passthrough-all'
	handlers: ReadonlyArray<unknown>
	passthroughHosts: ReadonlyArray<string>
	allowPrivateNetwork: boolean
	handle: (
		args: unknown,
		signal?: AbortSignal,
	) => Promise<MockGatewayFetchResult>
	/** OAuth / createAuthenticatedFetch hop — never returns placeholder stubs. */
	handleAuthenticatedFetch: (
		args: unknown,
		signal?: AbortSignal,
	) => Promise<MockGatewayFetchResult>
}

export function parsePassthroughHosts(raw: string | undefined): Array<string> {
	if (!raw?.trim()) return []
	return [
		...new Set(
			raw
				.split(',')
				.map((part) => part.trim().toLowerCase())
				.filter(Boolean),
		),
	]
}

export function createMockFetchGateway(input: {
	handlers: ReadonlyArray<unknown>
	passthroughHosts?: ReadonlyArray<string>
	allowPrivateNetwork?: boolean
	/** When true, unmatched hosts use real network (no mocks.ts). */
	passthroughAll?: boolean
	fetchFn?: typeof fetch
	msw?: EnsureMswInput
}): MockFetchGateway {
	const passthroughHosts = input.passthroughHosts ?? []
	const allowPrivateNetwork = input.allowPrivateNetwork === true
	const passthroughAll = input.passthroughAll === true
	const fetchFn = input.fetchFn ?? fetch
	const mode = passthroughAll ? 'passthrough-all' : 'msw'
	return {
		enabled: !passthroughAll,
		mode,
		handlers: input.handlers,
		passthroughHosts,
		allowPrivateNetwork,
		handle: async (args, signal) => {
			const request = readGatewayRequest(args)
			return await dispatchMockGatewayFetch({
				handlers: input.handlers,
				passthroughHosts,
				allowPrivateNetwork,
				passthroughAll,
				request,
				fetchFn,
				signal,
				msw: input.msw,
			})
		},
		handleAuthenticatedFetch: async (args, signal) => {
			const request = readAuthenticatedFetchRequest(args)
			// Authenticated / OAuth hops never get a fake stub. Without an MSW
			// match (or explicit --passthrough host), fail closed.
			return await dispatchMockGatewayFetch({
				handlers: input.handlers,
				passthroughHosts,
				allowPrivateNetwork,
				passthroughAll: false,
				request,
				fetchFn,
				signal,
				msw: input.msw,
			})
		},
	}
}

export async function dispatchMockGatewayFetch(input: {
	handlers: ReadonlyArray<unknown>
	passthroughHosts: ReadonlyArray<string>
	allowPrivateNetwork: boolean
	passthroughAll?: boolean
	request: MockGatewayFetchRequest
	fetchFn?: typeof fetch
	signal?: AbortSignal
	msw?: EnsureMswInput
}): Promise<MockGatewayFetchResult> {
	const method = (input.request.method ?? 'GET').toUpperCase()
	const url = String(input.request.url ?? '')
	if (!url) {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: 'Mock gatewayFetch requires request.url.',
			target: 'mock',
			fix: 'Pass an absolute URL from ambient fetch.',
		})
	}
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: `Mock gatewayFetch URL is not absolute: ${JSON.stringify(url)}.`,
			target: 'mock',
			where: `${method} ${url}`,
			fix: 'Use an absolute https:// URL in package code under --target mock.',
		})
	}

	const passthrough =
		input.passthroughAll === true ||
		hostMatchesPassthrough(parsed.hostname, input.passthroughHosts)

	// MSW handlers may target private hosts without --allow-private-network.
	// Real network (passthrough) still requires the flag for private/local hosts.
	if (!passthrough && input.handlers.length > 0) {
		const headers = new Headers(input.request.headers ?? {})
		const body =
			input.request.bodyBase64 != null && input.request.bodyBase64 !== ''
				? Buffer.from(input.request.bodyBase64, 'base64')
				: undefined
		const requestInit: RequestInit = {
			method,
			headers,
			...(body !== undefined && method !== 'GET' && method !== 'HEAD'
				? { body }
				: {}),
			signal: input.signal,
		}
		const request = new Request(parsed.href, requestInit)
		const { getResponse, isPassthroughResponse } = await importMsw(input.msw)
		const response = await getResponse([...input.handlers], request)
		if (response && !isPassthroughResponse(response)) {
			return await serializeResponse(response)
		}
		throw unmockedRequestError(method, parsed.href)
	}

	if (passthrough) {
		assertOutboundAllowed(parsed, input.allowPrivateNetwork)
		return await realNetworkFetch({
			request: input.request,
			method,
			url: parsed.href,
			fetchFn: input.fetchFn ?? fetch,
			signal: input.signal,
		})
	}

	assertOutboundAllowed(parsed, input.allowPrivateNetwork)
	throw unmockedRequestError(method, parsed.href)
}

function readGatewayRequest(args: unknown): MockGatewayFetchRequest {
	const record =
		args && typeof args === 'object' && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: {}
	const nested =
		record.request &&
		typeof record.request === 'object' &&
		!Array.isArray(record.request)
			? (record.request as Record<string, unknown>)
			: record
	return {
		url: typeof nested.url === 'string' ? nested.url : undefined,
		method: typeof nested.method === 'string' ? nested.method : undefined,
		headers:
			nested.headers &&
			typeof nested.headers === 'object' &&
			!Array.isArray(nested.headers)
				? (nested.headers as Record<string, string>)
				: undefined,
		bodyBase64:
			typeof nested.bodyBase64 === 'string' ? nested.bodyBase64 : undefined,
	}
}

function readAuthenticatedFetchRequest(args: unknown): MockGatewayFetchRequest {
	const record =
		args && typeof args === 'object' && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: {}
	const nested =
		record.request &&
		typeof record.request === 'object' &&
		!Array.isArray(record.request)
			? (record.request as Record<string, unknown>)
			: record
	return {
		url: typeof nested.url === 'string' ? nested.url : undefined,
		method: typeof nested.method === 'string' ? nested.method : undefined,
		headers:
			nested.headers &&
			typeof nested.headers === 'object' &&
			!Array.isArray(nested.headers)
				? (nested.headers as Record<string, string>)
				: undefined,
		bodyBase64:
			typeof nested.bodyBase64 === 'string' ? nested.bodyBase64 : undefined,
	}
}

export function hostMatchesPassthrough(
	hostname: string,
	hosts: ReadonlyArray<string>,
): boolean {
	const target = hostname.toLowerCase()
	return hosts.some((entry) => {
		const normalized = entry.trim().toLowerCase()
		if (!normalized) return false
		if (normalized.startsWith('*.')) {
			const suffix = normalized.slice(1)
			return target.endsWith(suffix) && target.length > suffix.length
		}
		return target === normalized
	})
}

/** Refuse private/local hosts unless `--allow-private-network` (clear error). */
export function assertOutboundAllowed(
	url: URL,
	allowPrivateNetwork: boolean,
): void {
	if (allowPrivateNetwork) return
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: `Mock outbound fetch refused for non-http(s) URL ${url.href}.`,
			target: 'mock',
			where: url.href,
			fix: 'Use http(s) URLs, or mock this request in .kody/mocks.ts.',
		})
	}
	if (isPrivateOrLocalHost(url.hostname)) {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: `Blocked private/local fetch to ${JSON.stringify(url.hostname)} under --target mock.`,
			target: 'mock',
			where: url.href,
			fix: 'Pass --allow-private-network, or mock this host in .kody/mocks.ts instead of hitting the private network.',
		})
	}
}

export function isPrivateOrLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase()
	return (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host === '[::1]' ||
		host.endsWith('.local') ||
		host.startsWith('10.') ||
		host.startsWith('192.168.') ||
		/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
	)
}

async function realNetworkFetch(input: {
	request: MockGatewayFetchRequest
	method: string
	url: string
	fetchFn: typeof fetch
	signal?: AbortSignal
}): Promise<MockGatewayFetchResult> {
	const headers = new Headers(input.request.headers ?? {})
	// Credentials stay fake on mock — never forward opaque credential handles
	// or Authorization that would look like a real secret placement.
	headers.delete('x-kody-credential-client')
	const body =
		input.request.bodyBase64 != null && input.request.bodyBase64 !== ''
			? Buffer.from(input.request.bodyBase64, 'base64')
			: undefined
	const response = await input.fetchFn(input.url, {
		method: input.method,
		headers,
		...(body !== undefined && input.method !== 'GET' && input.method !== 'HEAD'
			? { body }
			: {}),
		signal: input.signal,
		redirect: 'manual',
	})
	return await serializeResponse(response)
}

async function serializeResponse(
	response: Response,
): Promise<MockGatewayFetchResult> {
	const bytes = new Uint8Array(await response.arrayBuffer())
	return {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers.entries()),
		bodyBase64: Buffer.from(bytes).toString('base64'),
	}
}

export function unmockedRequestError(
	method: string,
	url: string,
): StructuredCliError {
	const stub = buildHandlerStub(method, url)
	const handlerLine = buildHandlerLine(method, url)
	return new StructuredCliError({
		code: 'unmocked_request',
		message: `Unmocked ${method} ${url} under --target mock.`,
		target: 'mock',
		where: `${method} ${url}`,
		fix:
			`Create or edit .kody/mocks.ts in the package root (next to package.json), ` +
			`or pass --passthrough ${safeHost(url)} for real network without secrets.\n\n` +
			`Ready-to-paste .kody/mocks.ts:\n\n${stub}\n\n` +
			`Or append this handler to an existing handlers array:\n\n${handlerLine}`,
		details: {
			method,
			url,
			handlerStub: stub,
			handlerLine,
			mocksPath: '.kody/mocks.ts',
		},
	})
}

/** Single MSW handler line for pasting into an existing `handlers` array. */
export function buildHandlerLine(method: string, url: string): string {
	const httpMethod = httpMethodForStub(method)
	return (
		`  http.${httpMethod}(${JSON.stringify(url)}, () =>\n` +
		`    HttpResponse.json({ /* TODO */ }, { status: 200 }),\n` +
		`  ),`
	)
}

export function buildHandlerStub(method: string, url: string): string {
	const httpMethod = httpMethodForStub(method)
	return [
		`import { http, HttpResponse } from 'msw'`,
		``,
		`export const handlers = [`,
		`  http.${httpMethod}(${JSON.stringify(url)}, () =>`,
		`    HttpResponse.json({ /* TODO */ }, { status: 200 }),`,
		`  ),`,
		`]`,
	].join('\n')
}

function httpMethodForStub(method: string): string {
	const verb = method.toLowerCase()
	return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(
		verb,
	)
		? verb
		: 'all'
}

function safeHost(url: string): string {
	try {
		return new URL(url).hostname
	} catch {
		return 'example.com'
	}
}

/**
 * Bridge interceptor: handle `kody.gatewayFetch`, `kody.gatewayFetchStream`,
 * and `kody.authenticatedFetch` when a mock gateway is active (always on
 * `--target mock`). Stream hops buffer through the same MSW path.
 */
export function tryHandleMockGatewayFetchCall(input: {
	gateway: MockFetchGateway | undefined
	path: ReadonlyArray<string>
	args: ReadonlyArray<unknown>
	signal?: AbortSignal
}): Promise<MockGatewayFetchResult> | null {
	if (!input.gateway) return null
	const pathKey = input.path.join('.')
	if (
		pathKey === 'kody.gatewayFetch' ||
		pathKey === 'kody.gatewayFetchStream'
	) {
		return input.gateway.handle(input.args[0], input.signal)
	}
	if (pathKey === 'kody.authenticatedFetch') {
		return input.gateway.handleAuthenticatedFetch(input.args[0], input.signal)
	}
	return null
}

/**
 * Always build a mock fetch gateway for `--target mock`.
 * With `.kody/mocks.ts`: MSW fail-closed (+ `--passthrough`).
 * Without: public-network passthrough for ambient/gatewayFetch; authenticatedFetch
 * still fails closed (no placeholder stubs).
 */
export async function resolveMockFetchGateway(input: {
	target: KodyTarget
	packageRoot?: string
	passthroughHosts?: ReadonlyArray<string>
	allowPrivateNetwork?: boolean
	onStatus?: (message: string) => void
	msw?: EnsureMswInput
}): Promise<MockFetchGateway | undefined> {
	if (input.target !== 'mock') return undefined
	const msw: EnsureMswInput = {
		...input.msw,
		onInstall: (spec) => {
			input.onStatus?.(`Installing ${spec} for --target mock…`)
			input.msw?.onInstall?.(spec)
		},
	}
	const loaded = input.packageRoot
		? await loadPackageMocks(input.packageRoot, msw)
		: null
	if (loaded) {
		input.onStatus?.(
			`Loaded ${loaded.handlers.length} MSW handler${loaded.handlers.length === 1 ? '' : 's'} from .kody/mocks.ts (outbound fetch fail-closed on mock).`,
		)
		return createMockFetchGateway({
			handlers: loaded.handlers,
			passthroughHosts: input.passthroughHosts,
			allowPrivateNetwork: input.allowPrivateNetwork,
			passthroughAll: false,
			msw,
		})
	}
	if (input.passthroughHosts?.length) {
		input.onStatus?.(
			`No .kody/mocks.ts — --passthrough hosts are unused until you add MSW handlers (ambient fetch uses public-network passthrough on mock).`,
		)
	}
	return createMockFetchGateway({
		handlers: [],
		passthroughHosts: input.passthroughHosts,
		allowPrivateNetwork: input.allowPrivateNetwork,
		passthroughAll: true,
	})
}
