import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { getJoinedIntegration } from '#worker/integrations/service.ts'
import type { JoinedIntegration } from '#worker/integrations/types.ts'
import {
	listPackageWebhooks,
	type PackageWebhookManifestEntry,
} from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	collectWebhookCredentialSecrets,
	redactWebhookCredentials,
} from './redact.ts'
import { resolveWebhookHmacSigningSecret } from './signing-secret.ts'
import type { WebhookEndpointRecord } from './types.ts'

export const webhookUrlApplyHttpMethods = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
] as const

/** Server-side substitution token for the minted credential URL. */
export const webhookUrlApplyPlaceholder = '{{webhookUrl}}'

/**
 * Server-side substitution token for package-owned HMAC signing material
 * (minted on the webhook URL record, or copied from verification.secretName
 * at mint or rotate). Injected only after the owner Approves the apply
 * destination. Not a user-secrets host-gated credential — unlike
 * destination.secretName Bearer auth.
 */
export const webhookUrlApplySecretPlaceholder = '{{webhookSecret}}'

export type WebhookUrlApplyHttpDestination = {
	type: 'http'
	/** HTTPS registration endpoint. May include {{webhookUrl}} / {{webhookSecret}}. */
	url: string
	method?: (typeof webhookUrlApplyHttpMethods)[number]
	/** Header values may include {{webhookUrl}} / {{webhookSecret}}. */
	headers?: Record<string, string>
	/** Request body template; may include {{webhookUrl}} / {{webhookSecret}}. */
	body?: string
	integration?: string
	secretName?: string
}

export type WebhookUrlApplyDestination = WebhookUrlApplyHttpDestination

export type WebhookUrlApplyResult = {
	ok: boolean
	urlHost: string
	httpStatus: number
	remoteId: string | null
	error: string | null
}

const applyResponseBodyMaxBytes = 16_384
const applyRequestBodyMaxBytes = 64_384
const applyErrorSnippetMaxChars = 300
const applyRequestTimeoutMs = 15_000
const applyHttpMaxHeaderCount = 32

function integrationAllowedHosts(joined: JoinedIntegration) {
	const hosts = new Set<string>()
	for (const host of joined.connection.requiredHosts) {
		const normalized = normalizeHost(host)
		if (normalized) hosts.add(normalized)
	}
	if (joined.lane === 'platform') {
		for (const host of joined.app.requiredHosts) {
			const normalized = normalizeHost(host)
			if (normalized) hosts.add(normalized)
		}
	}
	if (joined.app.apiBaseUrl) {
		try {
			const apiHost = normalizeHost(new URL(joined.app.apiBaseUrl).hostname)
			if (apiHost) hosts.add(apiHost)
		} catch {
			// Invalid apiBaseUrl is ignored; host checks still use requiredHosts.
		}
	}
	return hosts
}

function assertDestinationHostAllowed(input: {
	joined: JoinedIntegration
	integrationName: string
	url: string
}) {
	const host = normalizeHost(new URL(input.url).hostname)
	if (integrationAllowedHosts(input.joined).has(host)) return
	throw new McpCallerError(
		`Integration "${input.integrationName}" does not allow requests to host "${host}".`,
	)
}

async function loadDeclaredWebhookIfPresent(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	savedPackage: SavedPackageRecord
	webhookName: string
}): Promise<PackageWebhookManifestEntry | null> {
	let loaded
	try {
		loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: input.savedPackage.sourceId,
		})
	} catch {
		throw new McpCallerError(
			'Could not load the package manifest to read webhook verification. Retry after the package source is available.',
		)
	}
	return (
		listPackageWebhooks(loaded.manifest).find(
			(webhook) => webhook.name === input.webhookName,
		) ?? null
	)
}

function assertExpectedAuthCredentialId(input: {
	expectedAuthCredentialId?: string | null
	resolvedCredentialId: string | null | undefined
	label: string
}) {
	const expected = input.expectedAuthCredentialId?.trim() || null
	if (!expected) return
	const resolved = input.resolvedCredentialId?.trim() || null
	if (resolved === expected) return
	throw new McpCallerError(
		`${input.label} no longer matches the credential the owner approved for this destination. Retry webhookUrlApply for a fresh approval link.`,
	)
}

async function authorizeApplyRequest(input: {
	env: Env
	request: RequestContext
	userId: OwnerId
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	url: string
	integration?: string
	secretName?: string
	waitUntil?: (promise: Promise<unknown>) => void
	expectedAuthCredentialId?: string | null
}): Promise<{
	authorization: string | null
	/** Resolves `null` when no fresher credential exists, so apply keeps the original 401. */
	retryAuthorization: (() => Promise<string | null>) | null
}> {
	const secretName = input.secretName?.trim() ?? ''
	const integrationName = input.integration?.trim() ?? ''
	const credentialInput = {
		env: input.env,
		orgId: input.userId,
		actor: input.request,
		packageStamp: attestedPackageStamp(input.packageId),
		baseUrl: input.baseUrl,
	}
	if (secretName && integrationName) {
		throw new McpCallerError(
			'Provide either integration or secretName, not both.',
		)
	}
	if (secretName) {
		const host = normalizeHost(new URL(input.url).hostname)
		const resolved = await resolveCredential({
			...credentialInput,
			credential: { use: 'webhook-secret', name: secretName },
		})
		if (!resolved.found || !resolved.value) {
			throw new McpCallerError(
				`Secret "${secretName}" was not found for this user.`,
			)
		}
		assertExpectedAuthCredentialId({
			expectedAuthCredentialId: input.expectedAuthCredentialId,
			resolvedCredentialId: resolved.credentialId,
			label: `Secret "${secretName}"`,
		})
		if (!resolved.allowedHosts.includes(host)) {
			const approvalUrl = buildSecretHostApprovalUrl({
				baseUrl: input.baseUrl,
				name: secretName,
				scope: resolved.scope ?? 'user',
				requestedHost: host,
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: input.packageId,
				},
			})
			throw new McpCallerError(
				`Secret "${secretName}" is not approved for host "${host}". Approve it at ${approvalUrl}.`,
			)
		}
		const authorization = `Bearer ${resolved.value}`
		return {
			authorization,
			retryAuthorization: async () => authorization,
		}
	}

	if (!integrationName) {
		return { authorization: null, retryAuthorization: null }
	}
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name: integrationName,
	})
	if (!joined) {
		throw new McpCallerError(
			`Integration "${integrationName}" was not found. Connect it at /connect/oauth?provider=${encodeURIComponent(integrationName)} or pass secretName for a host-approved token.`,
		)
	}
	assertExpectedAuthCredentialId({
		expectedAuthCredentialId: input.expectedAuthCredentialId,
		resolvedCredentialId: joined.connection.credentialId,
		label: `Integration "${integrationName}"`,
	})
	const readToken = async () => {
		const token = await resolveCredential({
			...credentialInput,
			credential: {
				use: 'integration-token',
				name: integrationName,
				packageKodyId: input.packageKodyId,
			},
		})
		if (!token) {
			throw new McpCallerError(
				`Integration "${integrationName}" does not have a stored access token. Reconnect at /connect/oauth?provider=${encodeURIComponent(integrationName)}.`,
			)
		}
		return `Bearer ${token}`
	}
	const authorization = await readToken()
	assertDestinationHostAllowed({
		joined,
		integrationName,
		url: input.url,
	})
	return {
		authorization,
		retryAuthorization: async () => {
			const refresh = await resolveCredential({
				...credentialInput,
				credential: {
					use: 'integration-refresh',
					name: integrationName,
					userEmail: input.userEmail ?? undefined,
					packageKodyId: input.packageKodyId,
					waitUntil: input.waitUntil,
				},
			})
			return refresh.refreshed ? readToken() : null
		},
	}
}

function extractRemoteId(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return null
	}
	const id = (payload as { id?: unknown }).id
	if (typeof id === 'number' && Number.isFinite(id)) return String(id)
	if (typeof id === 'string' && id.trim()) return id.trim()
	return null
}

function parseJsonPayload(text: string): unknown {
	if (!text.trim()) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		return null
	}
}

function isRedirectStatus(status: number) {
	return status >= 300 && status < 400
}

function applyFetchInit(input: {
	method: string
	headers: Headers
	body?: string
}): RequestInit {
	return {
		method: input.method,
		headers: input.headers,
		body: input.body,
		redirect: 'manual',
		signal: AbortSignal.timeout(applyRequestTimeoutMs),
	}
}

async function fetchApplyDestination(input: {
	url: string
	method: string
	headers: Headers
	body?: string
}): Promise<Response> {
	try {
		return await fetch(input.url, applyFetchInit(input))
	} catch (error) {
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			throw new McpCallerError('Destination request timed out.')
		}
		throw error
	}
}

async function readApplyResponseBody(response: Response): Promise<string> {
	if (response.body == null) {
		const text = await response.text()
		return text.length > applyResponseBodyMaxBytes
			? text.slice(0, applyResponseBodyMaxBytes)
			: text
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let body = ''
	let totalBytes = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value || value.byteLength === 0) continue
			if (totalBytes + value.byteLength > applyResponseBodyMaxBytes) {
				const remaining = applyResponseBodyMaxBytes - totalBytes
				if (remaining > 0) {
					body += decoder.decode(value.slice(0, remaining), { stream: true })
				}
				void reader.cancel().catch(() => {})
				break
			}
			totalBytes += value.byteLength
			body += decoder.decode(value, { stream: true })
		}
		body += decoder.decode()
		return body
	} catch (error) {
		void reader.cancel().catch(() => {})
		throw error
	}
}

async function sendAuthorizedApplyRequest(input: {
	url: string
	method: string
	headers: Record<string, string>
	body?: string
	authorization: string | null
	retryAuthorization: (() => Promise<string | null>) | null
	secrets: ReadonlyArray<string>
}): Promise<WebhookUrlApplyResult> {
	const headers = new Headers(input.headers)
	if (input.authorization) {
		headers.set('Authorization', input.authorization)
	}
	let response = await fetchApplyDestination({
		url: input.url,
		method: input.method,
		headers,
		body: input.body,
	})
	if (isRedirectStatus(response.status)) {
		await response.body?.cancel()
		return {
			ok: false,
			urlHost: '',
			httpStatus: response.status,
			remoteId: null,
			error: 'Destination redirected. Apply does not follow redirects.',
		}
	}
	let secrets = [...input.secrets]
	let retryAuthorization: string | null = null
	if (response.status === 401 && input.retryAuthorization) {
		try {
			retryAuthorization = await input.retryAuthorization()
		} catch (error) {
			await response.body?.cancel()
			throw error
		}
	}
	if (retryAuthorization) {
		await response.body?.cancel()
		secrets = [
			...secrets,
			...collectAuthorizationSecretsForRedaction({
				authorization: retryAuthorization,
			}),
		]
		const retryHeaders = new Headers(input.headers)
		retryHeaders.set('Authorization', retryAuthorization)
		response = await fetchApplyDestination({
			url: input.url,
			method: input.method,
			headers: retryHeaders,
			body: input.body,
		})
		if (isRedirectStatus(response.status)) {
			await response.body?.cancel()
			return {
				ok: false,
				urlHost: '',
				httpStatus: response.status,
				remoteId: null,
				error: 'Destination redirected. Apply does not follow redirects.',
			}
		}
	}
	const rawBody = await readApplyResponseBody(response)
	const redactedBody = String(redactWebhookCredentials(rawBody, secrets) ?? '')
	const payload = parseJsonPayload(redactedBody)
	const remoteId = extractRemoteId(payload)
	if (response.ok) {
		return {
			ok: true,
			urlHost: '',
			httpStatus: response.status,
			remoteId,
			error: null,
		}
	}
	const snippet =
		redactedBody.trim().length > 0
			? redactedBody.trim().slice(0, applyErrorSnippetMaxChars)
			: response.statusText
	return {
		ok: false,
		urlHost: '',
		httpStatus: response.status,
		remoteId,
		error: String(redactWebhookCredentials(snippet, secrets) ?? snippet),
	}
}

function countPlaceholders(value: string, placeholder: string) {
	let count = 0
	let index = 0
	while (true) {
		const next = value.indexOf(placeholder, index)
		if (next === -1) break
		count += 1
		index = next + placeholder.length
	}
	return count
}

function countPlaceholdersInUrl(value: string, placeholder: string) {
	const fragmentIndex = value.indexOf('#')
	return countPlaceholders(
		fragmentIndex === -1 ? value : value.slice(0, fragmentIndex),
		placeholder,
	)
}

function substitutePlaceholder(
	value: string,
	placeholder: string,
	replacement: string,
	encode: boolean,
) {
	const encoded = encode ? encodeURIComponent(replacement) : replacement
	return value.split(placeholder).join(encoded)
}

export function isFormUrlEncodedContentType(contentType: string | null) {
	if (!contentType) return false
	return (
		contentType.split(';', 1)[0]!.trim().toLowerCase() ===
		'application/x-www-form-urlencoded'
	)
}

export function isJsonContentType(contentType: string | null) {
	if (!contentType) return false
	return (
		contentType.split(';', 1)[0]!.trim().toLowerCase() === 'application/json'
	)
}

/** Escape a value for splicing into a JSON string literal (quotes/backslashes). */
export function escapeForJsonString(value: string) {
	return JSON.stringify(value).slice(1, -1)
}

/** Form-urlencoded serialization of a single value (spaces become `+`). */
export function formEncodeApplicationValue(value: string) {
	return new URLSearchParams({ v: value }).toString().slice('v='.length)
}

export function countWebhookUrlPlaceholdersInFormBody(body: string) {
	let count = 0
	const params = new URLSearchParams(body)
	for (const [key, value] of params) {
		count += countPlaceholders(key, webhookUrlApplyPlaceholder)
		count += countPlaceholders(value, webhookUrlApplyPlaceholder)
	}
	return count
}

export function countWebhookSecretPlaceholdersInFormBody(body: string) {
	let count = 0
	const params = new URLSearchParams(body)
	for (const [key, value] of params) {
		count += countPlaceholders(key, webhookUrlApplySecretPlaceholder)
		count += countPlaceholders(value, webhookUrlApplySecretPlaceholder)
	}
	return count
}

export function httpDestinationIncludesWebhookUrlPlaceholder(destination: {
	url: string
	headers?: Record<string, string>
	body?: string
}) {
	const urlTemplate = destination.url.trim()
	const headers = destination.headers ?? {}
	const headerEntries = Object.entries(headers)
	const body = destination.body ?? ''
	let placeholderCount =
		countPlaceholdersInUrl(urlTemplate, webhookUrlApplyPlaceholder) +
		headerEntries.reduce(
			(sum, [, value]) =>
				sum + countPlaceholders(value, webhookUrlApplyPlaceholder),
			0,
		) +
		countPlaceholders(body, webhookUrlApplyPlaceholder)
	if (placeholderCount >= 1) return true
	const contentType =
		headerEntries.find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? null
	if (!isFormUrlEncodedContentType(contentType)) return false
	return countWebhookUrlPlaceholdersInFormBody(body) >= 1
}

export function httpDestinationIncludesWebhookSecretPlaceholder(destination: {
	url: string
	headers?: Record<string, string>
	body?: string
}) {
	const urlTemplate = destination.url.trim()
	const headers = destination.headers ?? {}
	const headerEntries = Object.entries(headers)
	const body = destination.body ?? ''
	let placeholderCount =
		countPlaceholdersInUrl(urlTemplate, webhookUrlApplySecretPlaceholder) +
		headerEntries.reduce(
			(sum, [, value]) =>
				sum + countPlaceholders(value, webhookUrlApplySecretPlaceholder),
			0,
		) +
		countPlaceholders(body, webhookUrlApplySecretPlaceholder)
	if (placeholderCount >= 1) return true
	const contentType =
		headerEntries.find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? null
	if (!isFormUrlEncodedContentType(contentType)) return false
	return countWebhookSecretPlaceholdersInFormBody(body) >= 1
}

function collectAuthorizationSecretsForRedaction(input: {
	authorization: string | null
	headers?: Record<string, string>
}) {
	const secrets: Array<string> = []
	const candidates = [
		input.authorization,
		...Object.entries(input.headers ?? {})
			.filter(([name]) => name.toLowerCase() === 'authorization')
			.map(([, value]) => value),
	]
	for (const value of candidates) {
		if (!value) continue
		const variants = [value]
		const bearerMatch = /^Bearer\s+(.+)$/i.exec(value.trim())
		if (bearerMatch?.[1]) variants.push(bearerMatch[1])
		for (const variant of variants) {
			secrets.push(variant)
			const encoded = encodeURIComponent(variant)
			if (encoded !== variant) secrets.push(encoded)
		}
	}
	return secrets
}

function substituteApplyPlaceholdersInFormBody(
	body: string,
	webhookUrl: string,
	webhookSecret: string | null,
) {
	const params = new URLSearchParams(body)
	const next = new URLSearchParams()
	for (const [key, value] of params) {
		let nextKey = substitutePlaceholder(
			key,
			webhookUrlApplyPlaceholder,
			webhookUrl,
			false,
		)
		let nextValue = substitutePlaceholder(
			value,
			webhookUrlApplyPlaceholder,
			webhookUrl,
			false,
		)
		if (webhookSecret !== null) {
			nextKey = substitutePlaceholder(
				nextKey,
				webhookUrlApplySecretPlaceholder,
				webhookSecret,
				false,
			)
			nextValue = substitutePlaceholder(
				nextValue,
				webhookUrlApplySecretPlaceholder,
				webhookSecret,
				false,
			)
		}
		next.append(nextKey, nextValue)
	}
	return next.toString()
}

function substituteApplyPlaceholders(
	value: string,
	webhookUrl: string,
	webhookSecret: string | null,
	encode: boolean,
) {
	let next = substitutePlaceholder(
		value,
		webhookUrlApplyPlaceholder,
		webhookUrl,
		encode,
	)
	if (webhookSecret !== null) {
		next = substitutePlaceholder(
			next,
			webhookUrlApplySecretPlaceholder,
			webhookSecret,
			encode,
		)
	}
	return next
}

function assertHttpsDestinationUrl(url: string) {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new McpCallerError('Destination url must be a valid https URL.')
	}
	if (parsed.protocol !== 'https:') {
		throw new McpCallerError('Destination url must use https.')
	}
	if (parsed.username || parsed.password) {
		throw new McpCallerError(
			'Destination url must not include username or password.',
		)
	}
	return parsed
}

function validateHttpDestinationTemplate(
	destination: WebhookUrlApplyHttpDestination,
) {
	const urlTemplate = destination.url.trim()
	if (!urlTemplate) {
		throw new McpCallerError('Destination url is required.')
	}
	const headers = destination.headers ?? {}
	const headerEntries = Object.entries(headers)
	if (headerEntries.length > applyHttpMaxHeaderCount) {
		throw new McpCallerError(
			`Destination headers are limited to ${applyHttpMaxHeaderCount} entries.`,
		)
	}
	for (const [name, value] of headerEntries) {
		if (!name.trim()) {
			throw new McpCallerError('Destination header names must be non-empty.')
		}
		if (typeof value !== 'string') {
			throw new McpCallerError('Destination header values must be strings.')
		}
	}
	const body = destination.body ?? ''
	if (body.length > applyRequestBodyMaxBytes) {
		throw new McpCallerError(
			`Destination body must be at most ${applyRequestBodyMaxBytes} bytes.`,
		)
	}
	const method = (destination.method ?? 'POST').toUpperCase()
	if (method === 'GET' && body.length > 0) {
		throw new McpCallerError('Destination body is not allowed with GET.')
	}
	if (
		!httpDestinationIncludesWebhookUrlPlaceholder({
			url: urlTemplate,
			headers,
			body,
		})
	) {
		throw new McpCallerError(
			`Destination must include ${webhookUrlApplyPlaceholder} in url, headers, or body so the minted URL is injected server-side.`,
		)
	}
	const urlForValidation = substituteApplyPlaceholders(
		urlTemplate,
		'https://webhook.invalid/apply',
		'webhook-secret-placeholder',
		true,
	)
	assertHttpsDestinationUrl(urlForValidation)
	const hasAuthorizationHeader = headerEntries.some(
		([name]) => name.toLowerCase() === 'authorization',
	)
	const hasAuthSource = Boolean(
		destination.secretName?.trim() || destination.integration?.trim(),
	)
	if (hasAuthorizationHeader && hasAuthSource) {
		throw new McpCallerError(
			'Provide Authorization in headers, or secretName/integration, not both.',
		)
	}
	return { urlTemplate, headers, body, method }
}

async function resolveWebhookVerificationSecretForDestination(input: {
	env: Env
	userId: OwnerId
	baseUrl: string
	savedPackage: SavedPackageRecord
	endpoint: WebhookEndpointRecord
	webhookName: string
}): Promise<string> {
	const declared = await loadDeclaredWebhookIfPresent({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		savedPackage: input.savedPackage,
		webhookName: input.webhookName,
	})
	if (!declared) {
		throw new McpCallerError(
			`Destination includes ${webhookUrlApplySecretPlaceholder} but webhook "${input.webhookName}" has no verification declaration.`,
		)
	}
	return resolveWebhookHmacSigningSecret({
		env: input.env,
		userId: input.userId,
		endpoint: input.endpoint,
	})
}

async function dispatchHttpApply(input: {
	env: Env
	request: RequestContext
	userId: OwnerId
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	webhookName: string
	savedPackage: SavedPackageRecord
	endpoint: WebhookEndpointRecord
	webhookUrl: string
	urlSecret: string
	destination: WebhookUrlApplyHttpDestination
	waitUntil?: (promise: Promise<unknown>) => void
	expectedAuthCredentialId?: string | null
}): Promise<WebhookUrlApplyResult> {
	const { urlTemplate, headers, body, method } =
		validateHttpDestinationTemplate(input.destination)
	const contentType =
		Object.entries(headers).find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? null
	const needsWebhookSecret = httpDestinationIncludesWebhookSecretPlaceholder({
		url: urlTemplate,
		headers,
		body,
	})
	// Validate the destination URL (with placeholders substituted) before
	// resolving secrets / sending the outbound request.
	assertHttpsDestinationUrl(
		substituteApplyPlaceholders(
			urlTemplate,
			input.webhookUrl,
			needsWebhookSecret ? 'webhook-secret-placeholder' : null,
			true,
		),
	)
	const webhookSecret = needsWebhookSecret
		? await resolveWebhookVerificationSecretForDestination({
				env: input.env,
				userId: input.userId,
				baseUrl: input.baseUrl,
				savedPackage: input.savedPackage,
				endpoint: input.endpoint,
				webhookName: input.webhookName,
			})
		: null
	const resolvedUrl = assertHttpsDestinationUrl(
		substituteApplyPlaceholders(
			urlTemplate,
			input.webhookUrl,
			webhookSecret,
			true,
		),
	).toString()
	const resolvedHeaders: Record<string, string> = {}
	for (const [name, value] of Object.entries(headers)) {
		resolvedHeaders[name] = substituteApplyPlaceholders(
			value,
			input.webhookUrl,
			webhookSecret,
			false,
		)
	}
	let resolvedBody: string | undefined
	if (body.length > 0) {
		if (isFormUrlEncodedContentType(contentType)) {
			resolvedBody = substituteApplyPlaceholdersInFormBody(
				body,
				input.webhookUrl,
				webhookSecret,
			)
		} else if (isJsonContentType(contentType)) {
			resolvedBody = substituteApplyPlaceholders(
				body,
				escapeForJsonString(input.webhookUrl),
				webhookSecret !== null ? escapeForJsonString(webhookSecret) : null,
				false,
			)
		} else {
			resolvedBody = substituteApplyPlaceholders(
				body,
				input.webhookUrl,
				webhookSecret,
				false,
			)
		}
	}
	const auth = await authorizeApplyRequest({
		env: input.env,
		request: input.request,
		userId: input.userId,
		userEmail: input.userEmail,
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		url: resolvedUrl,
		integration: input.destination.integration,
		secretName: input.destination.secretName,
		waitUntil: input.waitUntil,
		expectedAuthCredentialId: input.expectedAuthCredentialId,
	})
	const secrets = [
		...collectWebhookCredentialSecrets({
			url: input.webhookUrl,
			urlSecret: input.urlSecret,
		}),
		...collectAuthorizationSecretsForRedaction({
			authorization: auth.authorization,
			headers: resolvedHeaders,
		}),
	]
	if (webhookSecret) {
		secrets.push(webhookSecret)
		const encoded = encodeURIComponent(webhookSecret)
		if (encoded !== webhookSecret) secrets.push(encoded)
		const jsonEscaped = escapeForJsonString(webhookSecret)
		if (jsonEscaped !== webhookSecret) secrets.push(jsonEscaped)
		const formEncoded = formEncodeApplicationValue(webhookSecret)
		if (formEncoded !== webhookSecret) secrets.push(formEncoded)
	}
	return sendAuthorizedApplyRequest({
		url: resolvedUrl,
		method,
		headers: resolvedHeaders,
		body: resolvedBody,
		authorization: auth.authorization,
		retryAuthorization: auth.retryAuthorization,
		secrets,
	})
}

export async function dispatchWebhookUrlApply(input: {
	env: Env
	request: RequestContext
	userId: OwnerId
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	webhookName: string
	savedPackage: SavedPackageRecord
	endpoint: WebhookEndpointRecord
	webhookUrl: string
	urlSecret: string
	urlHost: string
	destination: WebhookUrlApplyDestination
	waitUntil?: (promise: Promise<unknown>) => void
	expectedAuthCredentialId?: string | null
}): Promise<WebhookUrlApplyResult> {
	const result = await dispatchHttpApply({
		env: input.env,
		request: input.request,
		userId: input.userId,
		userEmail: input.userEmail,
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		webhookName: input.webhookName,
		savedPackage: input.savedPackage,
		endpoint: input.endpoint,
		webhookUrl: input.webhookUrl,
		urlSecret: input.urlSecret,
		destination: input.destination,
		waitUntil: input.waitUntil,
		expectedAuthCredentialId: input.expectedAuthCredentialId,
	})
	const secrets = collectWebhookCredentialSecrets({
		url: input.webhookUrl,
		urlSecret: input.urlSecret,
	})
	return {
		ok: result.ok,
		urlHost: input.urlHost,
		httpStatus: result.httpStatus,
		remoteId: result.remoteId,
		error:
			typeof result.error === 'string'
				? String(
						redactWebhookCredentials(result.error, secrets) ?? result.error,
					)
				: null,
	}
}
