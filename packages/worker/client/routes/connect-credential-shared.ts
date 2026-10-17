import { type SaveSecretInput } from '#universal/secret-mutations.ts'
import { buildAccountSecretId } from '@kody-internal/shared/account-secret-route.ts'
import { normalizeSecretExpiresAt } from '@kody-internal/shared/secret-expires-at.ts'
import {
	type CredentialKind,
	type CredentialListItem,
	type ParsedCredentialCreateQuery,
	buildCredentialApprovalHref,
} from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'

/**
 * How the one-pager creates each kind: a form on the page for every kind the
 * person types a value for, or a hand-off to the existing OAuth or MCP flow.
 */
export type CredentialCreateMode = 'value-form' | 'handoff'

export type ValueFormKind = 'secret' | 'url' | 'login' | 'signing'

export function credentialCreateMode(
	kind: CredentialKind,
): CredentialCreateMode {
	switch (kind) {
		case 'secret':
		case 'url':
		case 'login':
		case 'signing':
			return 'value-form'
		case 'oauth':
		case 'mcp':
			return 'handoff'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

export function isValueFormKind(kind: CredentialKind): kind is ValueFormKind {
	return credentialCreateMode(kind) === 'value-form'
}

export function credentialCreateKindSummary(kind: CredentialKind) {
	switch (kind) {
		case 'secret':
			return 'An API key, token, or password Kody places on requests to the hosts you allow.'
		case 'oauth':
			return 'Sign in with a provider. Kody keeps the token fresh.'
		case 'mcp':
			return 'A remote MCP server Kody connects to for you.'
		case 'url':
			return 'A URL that carries its own secret, such as a webhook or bot URL.'
		case 'login':
			return 'A username and password Kody exchanges for a session token.'
		case 'signing':
			return 'A secret Kody signs requests or verifies webhooks with.'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

export function credentialCreateTitle(kind: CredentialKind) {
	switch (kind) {
		case 'secret':
			return 'Add a key'
		case 'oauth':
			return 'Connect an OAuth service'
		case 'mcp':
			return 'Add an MCP server'
		case 'url':
			return 'Add a URL credential'
		case 'login':
			return 'Add a login'
		case 'signing':
			return 'Add a signing secret'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

/**
 * Which form an href shows. A link with no kind already shows the Key form, so
 * picking Key from the chooser keeps what the person typed.
 */
export function credentialCreateFormKey(href: string) {
	const url = new URL(href, 'http://localhost')
	return url.searchParams.has('kind')
		? `${url.pathname}${url.search}`
		: writeCredentialCreateKind(href, 'secret')
}

/** `href` with `kind` chosen, keeping every other param (including prefill). */
export function writeCredentialCreateKind(href: string, kind: CredentialKind) {
	const url = new URL(href, 'http://localhost')
	url.searchParams.set('kind', kind)
	return `${url.pathname}${url.search}`
}

const mcpPrefillParams = ['name', 'url'] as const

/**
 * Where an OAuth or MCP link continues. OAuth keeps the whole query, which
 * `/connect/oauth` already reads (`provider` and its config params), and adds
 * `org` so the fixed redirect URI still binds the creation page's organization.
 * MCP keeps the `name` and `url` the add-server form prefills from.
 */
export function credentialCreateHandoffHref(input: {
	kind: 'oauth' | 'mcp'
	search: URLSearchParams
	orgSlug: string
}) {
	switch (input.kind) {
		case 'oauth': {
			const params = new URLSearchParams(input.search)
			params.set('org', input.orgSlug)
			const query = params.toString()
			const path = routes.connectOauth.href()
			return query ? `${path}?${query}` : path
		}
		case 'mcp': {
			const path = orgResourcePath(input.orgSlug, 'mcp-servers', 'new')
			const params = new URLSearchParams()
			for (const key of mcpPrefillParams) {
				const value = input.search.get(key)?.trim()
				if (value) params.set(key, value)
			}
			const query = params.toString()
			return query ? `${path}?${query}` : path
		}
		default: {
			const exhaustive: never = input.kind
			return exhaustive
		}
	}
}

/**
 * The org credential the form would replace: same name and, for a package
 * credential, the same package (`packageId` null means not package-scoped).
 * Url, login, and signing credentials share the Key namespace.
 */
export function findExistingOrgKey(
	credentials: ReadonlyArray<CredentialListItem>,
	name: string,
	packageId: string | null = null,
) {
	const wanted = name.trim()
	if (!wanted) return null
	return (
		credentials.find(
			(credential) =>
				isValueFormKind(credential.kind) &&
				credential.scope === 'org' &&
				credential.packageId === packageId &&
				credential.name === wanted,
		) ?? null
	)
}

/**
 * Why the form cannot save over `existing`: it is another kind in the same
 * name namespace, and replacing its value would not change its kind.
 */
export function existingKindConflict(
	existing: CredentialListItem | null,
	kind: CredentialKind,
) {
	if (!existing || existing.kind === kind) return null
	return `A ${credentialKindLabel(existing.kind)} credential named ${existing.name} already exists. Pick another name.`
}

/**
 * Credentials that may already satisfy the link: the same kind (when the link
 * names one) and, when the link names a provider, the same provider.
 */
export function findMatchingCredentials(
	credentials: ReadonlyArray<CredentialListItem>,
	query: Pick<ParsedCredentialCreateQuery, 'kind' | 'provider'>,
) {
	return credentials.filter(
		(credential) =>
			(query.kind === null || credential.kind === query.kind) &&
			query.provider !== null &&
			credential.provider === query.provider,
	)
}

/** Hosts typed one per line or separated by commas or spaces. */
export function parseHostsInput(text: string) {
	return [
		...new Set(
			text
				.split(/[\s,]+/)
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean),
		),
	]
}

/**
 * The creation link's `loginExchange` param: the JSON `login_exchange` a
 * package's login need expects, so the person only types their login fields.
 */
const loginExchangeParam = 'loginExchange'

export type LoginExchangeForm = {
	url: string
	bodyFormat: 'json' | 'form'
	/** The exchange body as JSON; `{field}` in a value is a login field. */
	body: string
	tokenPath: string
	/** Exchange fields the form does not edit (method, ttl, expiry path). */
	rest: Record<string, unknown>
}

const defaultLoginExchangeBody =
	'{"username":"{username}","password":"{password}"}'

function readLoginExchangeParam(
	passthrough: URLSearchParams,
): LoginExchangeForm {
	let parsed: unknown = null
	try {
		parsed = JSON.parse(passthrough.get(loginExchangeParam) ?? 'null')
	} catch {
		parsed = null
	}
	const record =
		parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {}
	const { url, bodyFormat, body, tokenPath, ...rest } = record
	return {
		url: typeof url === 'string' ? url : '',
		bodyFormat: bodyFormat === 'form' ? 'form' : 'json',
		body:
			body && typeof body === 'object'
				? JSON.stringify(body)
				: defaultLoginExchangeBody,
		tokenPath: typeof tokenPath === 'string' ? tokenPath : '',
		rest,
	}
}

/** Who can read a Key: any package the locks allow, or one package only. */
type KeyPackageScope = 'org' | 'package'

export type KeyFormState = {
	name: string
	value: string
	description: string
	provider: string
	hosts: string
	/** YYYY-MM-DD from the date field, or a link's full UTC timestamp. */
	expiresAt: string
	packageScope: KeyPackageScope
	/** The package a package Key belongs to. */
	packageId: string
	/** Saved package ids an org Key is locked to; empty means any package. */
	allowedPackages: Array<string>
	/** Replace the existing org credential with this name instead of failing. */
	replaceExisting: boolean
	/** Login field values by field name; only the `login` kind reads them. */
	loginFields: Record<string, string>
	loginExchange: LoginExchangeForm
	/** Whether the login exchange disclosure is open; only a toggle changes it. */
	loginExchangeOpen: boolean
}

/** A link's `expiresAt` as canonical UTC ISO, null when absent, or 'invalid'. */
function readLinkExpiresAt(raw: string | null): string | null {
	if (!raw) return null
	try {
		return normalizeSecretExpiresAt(raw) ?? null
	} catch {
		return 'invalid'
	}
}

/** The date field's value for a stored expiry (date part of the timestamp). */
export function expiresAtDateValue(expiresAt: string) {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(expiresAt.trim())
	return match?.[1] ?? ''
}

/** True when the expiry carries a time of day the date field cannot show. */
export function expiresAtHasTime(expiresAt: string) {
	const text = expiresAt.trim()
	return text.length > 10 && !text.endsWith('T00:00:00.000Z')
}

export function createKeyFormState(
	query: ParsedCredentialCreateQuery,
): KeyFormState {
	const expiresAt = readLinkExpiresAt(query.expiresAt)
	const packageKey =
		query.packageScopedTo !== null || query.packageScopeMissingId
	const loginExchange = readLoginExchangeParam(query.passthrough)
	return {
		name: query.name ?? '',
		value: '',
		description: query.description ?? '',
		provider: query.provider ?? '',
		hosts: query.allowedHosts.join('\n'),
		expiresAt: expiresAt === 'invalid' ? '' : (expiresAt ?? ''),
		packageScope: packageKey ? 'package' : 'org',
		packageId: query.packageScopedTo ?? '',
		allowedPackages: packageKey ? [] : [...query.allowedPackages],
		replaceExisting: false,
		loginFields: {},
		loginExchange,
		loginExchangeOpen: !loginExchange.url || !loginExchange.tokenPath,
	}
}

function parseExchangeBody(text: string): Record<string, string> | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return null
	}
	const entries = Object.entries(parsed)
	return entries.every((entry) => typeof entry[1] === 'string')
		? Object.fromEntries(entries as Array<[string, string]>)
		: null
}

/**
 * The login fields the exchange body asks for (`{username}` and so on), in
 * order. Falls back to username and password while the body is not valid.
 */
export function loginFieldNames(exchange: LoginExchangeForm) {
	const body = parseExchangeBody(exchange.body)
	if (!body) return ['username', 'password']
	const names = Object.values(body).flatMap((value) =>
		[...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]!),
	)
	return names.length > 0 ? [...new Set(names)] : ['username', 'password']
}

/** A login field holding a password or token is masked in the form. */
export function isMaskedLoginField(name: string) {
	return /pass|secret|token|key|pin|otp|code/i.test(name)
}

export type CredentialSaveBody =
	| { ok: true; body: SaveSecretInput & { action: 'save' } }
	| { ok: false; error: string }

/**
 * What is wrong with the link itself, so the form cannot save it as asked.
 * Matches the legacy intake page: a bad expiry or a package Key for a
 * package this org does not have.
 */
export function keyLinkProblem(input: {
	query: ParsedCredentialCreateQuery
	packages: ReadonlyArray<{ id: string }>
}): string | null {
	if (readLinkExpiresAt(input.query.expiresAt) === 'invalid') {
		return 'This link has an invalid expiresAt value. Use a UTC timestamp or YYYY-MM-DD.'
	}
	const packageScoped =
		input.query.packageScopedTo !== null || input.query.packageScopeMissingId
	if (
		packageScoped &&
		input.query.kind !== null &&
		input.query.kind !== 'secret'
	) {
		return 'Only a Key can belong to one package. Ask for a link without packageId; you can still lock this credential to packages.'
	}
	if (input.query.packageScopeMissingId) {
		return 'This link asks for a package key but names no package (packageId).'
	}
	const packageId = input.query.packageScopedTo
	if (packageId && !input.packages.some((entry) => entry.id === packageId)) {
		return 'This link names a package that is not in this org.'
	}
	return null
}

/** Why the form cannot save yet, before posting. */
export function keyFormProblem(
	state: KeyFormState,
	kind: CredentialKind | null,
): string | null {
	if (
		kind === 'secret' &&
		state.packageScope === 'package' &&
		!state.packageId
	) {
		return 'Choose the package this key belongs to.'
	}
	return null
}

/**
 * The package a package Key belongs to, or null for an org credential. Only a
 * Key can be package-scoped; the website save refuses it for other kinds.
 */
export function keyFormPackageId(
	state: KeyFormState,
	kind: CredentialKind | null,
) {
	return kind === 'secret' && state.packageScope === 'package'
		? state.packageId || null
		: null
}

/**
 * The `/account/secrets.json` save for the value form. Replacing a Key keeps
 * its hosts and adds the form's; package locks are exactly the form's checked
 * set (replacement hydrates those checkboxes from the existing Key). The
 * opt-in kinds take exactly the form's hosts, because whoever types the value
 * decides where it may go. An empty expiry keeps the existing one.
 */
export function buildKeySaveBody(input: {
	kind: ValueFormKind
	form: KeyFormState
	existing: CredentialListItem | null
}): CredentialSaveBody {
	const { form } = input
	const name = form.name.trim()
	const existing = input.existing
	const replacing = form.replaceExisting && existing !== null
	const hosts = parseHostsInput(form.hosts)
	const packageId = keyFormPackageId(form, input.kind)
	const scope: 'package' | 'user' = packageId ? 'package' : 'user'
	const allowedPackages = packageId
		? []
		: [...new Set(form.allowedPackages)].sort((left, right) =>
				left.localeCompare(right),
			)
	const common = {
		action: 'save' as const,
		// Replace targets the existing row by its stored name (exact), not the
		// form name, a case-only rename must keep currentId on the prior casing.
		currentId:
			replacing && existing
				? buildAccountSecretId({
						name: existing.name,
						scope,
						packageId,
					})
				: null,
		name,
		scope,
		packageId,
		description: form.description.trim(),
		// An empty string clears the provider of the credential being replaced.
		provider:
			form.provider.trim() ||
			(replacing && input.existing?.provider ? '' : null),
		expiresAt:
			form.expiresAt.trim() ||
			(replacing ? (input.existing?.expiresAt ?? null) : null),
		allowedPackages,
	}
	switch (input.kind) {
		case 'secret':
			return {
				ok: true,
				body: {
					...common,
					value: form.value,
					allowedHosts: replacing
						? [...new Set([...(input.existing?.hosts ?? []), ...hosts])]
						: hosts,
				},
			}
		case 'url':
		case 'signing':
			return {
				ok: true,
				body: {
					...common,
					kind: input.kind,
					value: form.value.trim(),
					hosts,
					allowedHosts: [],
				},
			}
		case 'login': {
			const body = parseExchangeBody(form.loginExchange.body)
			if (!body) {
				return {
					ok: false,
					error:
						'The exchange body must be a JSON object of text values, for example {"username":"{username}"}.',
				}
			}
			const fields = Object.fromEntries(
				loginFieldNames(form.loginExchange).map((field) => [
					field,
					form.loginFields[field] ?? '',
				]),
			)
			return {
				ok: true,
				body: {
					...common,
					kind: 'login',
					value: JSON.stringify(fields),
					hosts,
					allowedHosts: [],
					loginExchange: {
						...form.loginExchange.rest,
						url: form.loginExchange.url.trim(),
						bodyFormat: form.loginExchange.bodyFormat,
						body,
						tokenPath: form.loginExchange.tokenPath.trim(),
					},
				},
			}
		}
		default: {
			const exhaustive: never = input.kind
			return exhaustive
		}
	}
}

/** A prompt the person can hand their agent when a save fails. */
export function credentialCreateAgentPrompt(input: {
	kind: CredentialKind
	query: ParsedCredentialCreateQuery
	pageUrl: string
	error: string
}) {
	const label = credentialKindLabel(input.kind)
	const name = input.query.name ? ` named "${input.query.name}"` : ''
	const forPackage =
		input.query.packageKodyId && input.query.needKey
			? ` for the "${input.query.needKey}" need of package ${input.query.packageKodyId}`
			: ''
	// The exchange body can hold fixed values like a client secret.
	const pageUrl = new URL(input.pageUrl, 'http://localhost')
	const hadExchange = pageUrl.searchParams.has(loginExchangeParam)
	pageUrl.searchParams.delete(loginExchangeParam)
	const shownUrl = /^https?:\/\//.test(input.pageUrl)
		? pageUrl.toString()
		: `${pageUrl.pathname}${pageUrl.search}`
	return [
		`I tried to save a ${label} credential${name}${forPackage} on Kody: ${shownUrl}`,
		...(hadExchange
			? ['(I left out the link’s loginExchange; you have it.)']
			: []),
		`Kody said: ${input.error}`,
		`Help me fix the link or the form. Do not ask me to paste the value into chat.`,
	].join('\n')
}

/** The approval link that makes a just-saved credential the person's own default for a need. */
export function credentialNeedApprovalHref(input: {
	orgSlug: string
	packageKodyId: string
	needKey: string
	credentialId: string
}) {
	return buildCredentialApprovalHref({
		username: input.orgSlug,
		kodyId: input.packageKodyId,
		changes: [
			{
				target: { type: 'default', layer: 'mine' },
				needKey: input.needKey,
				credentials: [{ id: input.credentialId }],
			},
		],
	})
}
