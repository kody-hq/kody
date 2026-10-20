import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { listJsonSchemaSubsetProblems } from '@kody-internal/shared/json-schema-subset.ts'
import { z } from 'zod'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	authoredPackageJsonSchema,
	packageCredentialsSchema,
	webhookDefaultRateLimitPerMinute,
	type AuthoredPackageJson,
	type PackageExportTarget,
	type PackageRetrieverScope,
	type PackageWebhookChallenge,
} from './types.ts'

const packageManifestPath = 'package.json'
const customPackageEventTopicPattern =
	/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/

function isScopedPackageName(name: string) {
	const trimmed = name.trim()
	if (!trimmed.startsWith('@')) {
		return false
	}

	const separator = trimmed.indexOf('/')
	return separator > 1 && separator < trimmed.length - 1
}

function getExpectedKodyName(name: string) {
	const trimmed = name.trim()
	const separator = trimmed.indexOf('/')
	return separator === -1 ? trimmed : trimmed.slice(separator + 1)
}

function getPackageNameScope(name: string) {
	const trimmed = name.trim()
	const separator = trimmed.indexOf('/')
	if (separator <= 1) return null
	return trimmed.slice(1, separator)
}

function assertPackageEmittedEventTopics(input: {
	manifest: AuthoredPackageJson
	manifestPath?: string
}) {
	const packageScope = getPackageNameScope(input.manifest.name)
	for (const [topic, emittedEvent] of Object.entries(
		input.manifest.kody.emits ?? {},
	)) {
		if (!customPackageEventTopicPattern.test(topic)) {
			throw new Error(
				`Invalid ${input.manifestPath ?? packageManifestPath}:\nkody.emits topic "${topic}" must use the scoped form "@scope/topic.name" with a lower-dot-case topic body.`,
			)
		}
		const topicScope = getPackageNameScope(topic)
		if (topicScope !== packageScope) {
			throw new Error(
				`Invalid ${input.manifestPath ?? packageManifestPath}:\nkody.emits topic "${topic}" must use the package scope "@${packageScope}".`,
			)
		}
		if (emittedEvent.payloadSchema !== undefined) {
			const rootType = emittedEvent.payloadSchema['type']
			if (rootType !== 'object') {
				throw new Error(
					`Invalid ${input.manifestPath ?? packageManifestPath}:\nkody.emits topic "${topic}" payloadSchema must declare "type": "object" (event payloads are JSON objects).`,
				)
			}
			const problems = listJsonSchemaSubsetProblems(emittedEvent.payloadSchema)
			if (problems.length > 0) {
				throw new Error(
					`Invalid ${input.manifestPath ?? packageManifestPath}:\nkody.emits topic "${topic}" payloadSchema is not a supported JSON Schema subset:\n${problems.join('\n')}`,
				)
			}
		}
	}
}

export function assertAuthoredPackageJsonNameScope(input: {
	manifest: AuthoredPackageJson
	expectedPackageScope: string
	manifestPath?: string
}) {
	const expectedScope = input.expectedPackageScope.trim().replace(/^@/, '')
	const actualScope = getPackageNameScope(input.manifest.name)
	if (actualScope !== expectedScope) {
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\npackage.json name "${input.manifest.name}" must use the authenticated user's package scope "@${expectedScope}/*".`,
		)
	}
}

export type PackageManifestParseMode = 'authoring' | 'published'

export function parseAuthoredPackageJson(input: {
	content: string
	manifestPath?: string
	expectedPackageScope?: string
	/**
	 * `authoring` (default) is write/publish: leftover `kody.app.runtime` is
	 * rejected so kits cannot hide a removed mode. `published` is snapshot
	 * load: the field is inert (every entry is a fetch handler) and must not
	 * brick host-setup / packageAppFetch.
	 */
	mode?: PackageManifestParseMode
}): AuthoredPackageJson {
	let parsed: unknown
	try {
		parsed = JSON.parse(input.content)
	} catch (cause) {
		throw new Error(
			`Failed to parse ${input.manifestPath ?? packageManifestPath}: ${getErrorMessage(
				cause,
			)}`,
		)
	}
	assertNoRetiredKodyFields({
		parsed,
		manifestPath: input.manifestPath ?? packageManifestPath,
		mode: input.mode ?? 'authoring',
	})
	const invalidCredentialSlots =
		input.mode === 'published' ? splitPublishedCredentials(parsed) : null
	const result = authoredPackageJsonSchema.safeParse(parsed)
	if (!result.success) {
		const formatted = z.prettifyError(result.error)
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\n${formatted}`,
		)
	}

	const manifest = result.data
	if (!isScopedPackageName(manifest.name)) {
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\npackage.json name "${manifest.name}" must be a scoped package name like "@scope/${getExpectedKodyName(manifest.name) || 'name'}".`,
		)
	}
	const expectedKodyId = getExpectedKodyName(manifest.name)
	if (manifest.kody.id !== undefined && expectedKodyId !== manifest.kody.id) {
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\npackage.json name "${manifest.name}" must use a leaf package name that matches kody.id "${manifest.kody.id}".`,
		)
	}
	manifest.kody.id = expectedKodyId
	const authored = manifest as AuthoredPackageJson
	if (invalidCredentialSlots) {
		authored.kody.invalidCredentialSlots = invalidCredentialSlots
	}
	if (input.expectedPackageScope !== undefined) {
		assertAuthoredPackageJsonNameScope({
			manifest: authored,
			expectedPackageScope: input.expectedPackageScope,
			manifestPath: input.manifestPath,
		})
	}
	assertPackageEmittedEventTopics({
		manifest: authored,
		manifestPath: input.manifestPath,
	})
	assertPackageWebhooks({
		manifest: authored,
		manifestPath: input.manifestPath,
	})

	return authored
}

const retiredKodyFieldMessages = {
	workflows:
		'kody.workflows is not a supported field; use workflows.create({ packageId, exportName }) from any runtime context.',
	services:
		'kody.services is not a supported field; long-running daemons run on an external process. Use jobs or workflows for exclusive or cancellable background work.',
} as const

const retiredPackageAppRuntimeMessage =
	'kody.app.runtime was removed; every package app is a fetch handler and receives the mount-stripped path. There is no configured runtime mode.'

function assertNoRetiredKodyFields(input: {
	parsed: unknown
	manifestPath: string
	mode: PackageManifestParseMode
}) {
	if (
		!input.parsed ||
		typeof input.parsed !== 'object' ||
		Array.isArray(input.parsed)
	) {
		return
	}
	const kody = (input.parsed as { kody?: unknown }).kody
	if (!kody || typeof kody !== 'object' || Array.isArray(kody)) {
		return
	}
	const record = kody as Record<string, unknown>
	for (const [field, message] of Object.entries(retiredKodyFieldMessages)) {
		if (field in record) {
			throw new Error(`Invalid ${input.manifestPath}:\n${message}`)
		}
	}
	const app = record.app
	if (
		app &&
		typeof app === 'object' &&
		!Array.isArray(app) &&
		'runtime' in app
	) {
		if (input.mode === 'published') {
			return
		}
		throw new Error(
			`Invalid ${input.manifestPath}:\n${retiredPackageAppRuntimeMessage}`,
		)
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Snapshot load must not brick a package, and must not let one slot that a
 * later rule rejects take its valid siblings with it. Each slot is validated
 * on its own: valid slots stay in `kody.credentials`, and invalid ones come
 * back by name with their message so every use fails loudly. Publish
 * (`authoring`) still rejects the whole manifest.
 *
 * Publishes before `kody.credentials` existed stripped the key unvalidated,
 * so an old snapshot can carry any shape there (a string, an array, a map of
 * strings). That was never honored, so a non-empty key with no object-shaped
 * slot is dropped whole and the package stays undeclared. An empty map is a
 * valid declaration and stays. Fill placement on a slot is kept when it matches
 * the schema; an invalid placement makes that slot invalid (siblings stay).
 */
function splitPublishedCredentials(
	parsed: unknown,
): Record<string, string> | null {
	if (!isPlainRecord(parsed) || !isPlainRecord(parsed.kody)) return null
	const kody = parsed.kody
	if (!('credentials' in kody)) return null
	const credentials = kody.credentials
	if (
		!isPlainRecord(credentials) ||
		(Object.keys(credentials).length > 0 &&
			!Object.values(credentials).some(isPlainRecord))
	) {
		delete kody.credentials
		return null
	}
	const valid: Array<[string, unknown]> = []
	const invalid: Array<[string, string]> = []
	for (const [name, slot] of Object.entries(credentials)) {
		const result = packageCredentialsSchema.safeParse(
			Object.fromEntries([[name, slot]]),
		)
		if (result.success) {
			valid.push([name, slot])
			continue
		}
		invalid.push([
			name,
			result.error.issues
				.map(
					(issue) =>
						`${['kody.credentials', ...issue.path.map(String)].join('.')}: ${issue.message}`,
				)
				.join('\n'),
		])
	}
	kody.credentials = Object.fromEntries(valid)
	return invalid.length > 0 ? Object.fromEntries(invalid) : null
}

function assertPackageWebhooks(input: {
	manifest: AuthoredPackageJson
	manifestPath?: string
}) {
	for (const webhook of input.manifest.kody.webhooks ?? []) {
		try {
			resolvePackageExportPath({
				manifest: input.manifest,
				exportName: webhook.export,
			})
		} catch (error) {
			throw new Error(
				`Invalid ${input.manifestPath ?? packageManifestPath}:\nkody.webhooks "${webhook.name}" export "${webhook.export}" is invalid: ${getErrorMessage(error)}`,
			)
		}
	}
}

export function normalizePackageWorkspacePath(path: string) {
	return path.trim().replace(/^\.?\//, '')
}

export function normalizePackageExportKey(exportName: string) {
	const trimmed = exportName.trim()
	if (!trimmed) {
		throw new Error('Package export name must not be empty.')
	}
	if (trimmed === '.' || trimmed === './') {
		return '.'
	}
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

function readTargetPath(
	target: PackageExportTarget,
	purpose: 'runtime' | 'types',
): string | null {
	if (typeof target === 'string') {
		return purpose === 'runtime' ? target : null
	}
	if (purpose === 'types') {
		return target.types ?? null
	}
	return target.import ?? target.default ?? null
}

export function resolvePackageExportPath(input: {
	manifest: AuthoredPackageJson
	exportName: string
	purpose?: 'runtime' | 'types'
}) {
	const purpose = input.purpose ?? 'runtime'
	const normalizedExportKey = normalizePackageExportKey(input.exportName)
	const target = input.manifest.exports[normalizedExportKey]
	if (!target) {
		throw new Error(
			`Package "${input.manifest.kody.id}" does not define export "${normalizedExportKey}".`,
		)
	}
	const resolved = readTargetPath(target, purpose)
	if (!resolved) {
		throw new Error(
			`Package "${input.manifest.kody.id}" export "${normalizedExportKey}" does not define a ${purpose} target.`,
		)
	}
	return normalizePackageWorkspacePath(resolved)
}

export function getPackageAppEntryPath(manifest: AuthoredPackageJson) {
	const appEntry = manifest.kody.app?.entry?.trim()
	if (!appEntry) return null
	return normalizePackageWorkspacePath(appEntry)
}

export function getPackageAppClientEntryPath(manifest: AuthoredPackageJson) {
	const client = manifest.kody.app?.client
	const clientEntry = (
		typeof client === 'string' ? client : client?.entry
	)?.trim()
	if (!clientEntry) return null
	return normalizePackageWorkspacePath(clientEntry)
}

/**
 * Bare specifiers the browser bundle must leave as external `import`s for
 * the page's import map. Sorted and de-duplicated; empty for the string form
 * of `kody.app.client` or when no client is declared.
 */
export function getPackageAppClientExternals(manifest: AuthoredPackageJson) {
	const client = manifest.kody.app?.client
	if (!client || typeof client === 'string') return []
	return [
		...new Set(
			(client.externals ?? [])
				.map((specifier) => specifier.trim())
				.filter((specifier) => specifier.length > 0),
		),
	].sort((left, right) => left.localeCompare(right))
}

/**
 * Workspace-relative static asset directory declared by `kody.app.assets`,
 * without leading `./` or trailing slashes. `null` when the app declares no
 * assets directory.
 */
export function getPackageAppAssetsDirectory(manifest: AuthoredPackageJson) {
	const assetsDirectory = manifest.kody.app?.assets?.trim()
	if (!assetsDirectory) return null
	const normalized = normalizePackageWorkspacePath(assetsDirectory).replace(
		/\/+$/,
		'',
	)
	return normalized.length > 0 ? normalized : null
}

export function listPackageSubscriptions(manifest: AuthoredPackageJson) {
	return Object.entries(manifest.kody.subscriptions ?? {})
		.map(([topic, subscription]) => ({
			topic,
			handler: normalizePackageWorkspacePath(subscription.handler),
			description: subscription.description?.trim() || null,
			filters: subscription.filters ?? null,
		}))
		.sort((left, right) => left.topic.localeCompare(right.topic))
}

export type PackageWebhookHmacVerificationEntry = {
	type: 'hmac-sha256' | 'hmac-sha1'
	header: string
	secretName?: string
	encoding: 'hex' | 'base64'
	prefix?: string
	signedPayload?: 'body' | 'timestamp.body'
}

export type PackageWebhookUrlSecretVerificationEntry = { type: 'url-secret' }

/** The declared HMAC scheme, or null for url-secret and undeclared webhooks. */
export function webhookHmacVerification(
	verification: PackageWebhookManifestEntry['verification'] | undefined,
): PackageWebhookHmacVerificationEntry | null {
	if (!verification || verification.type === 'url-secret') return null
	return verification
}

export type PackageWebhookManifestEntry = {
	name: string
	exportName: string
	description: string | null
	responseMode: 'ack' | 'sync'
	inputMode: 'request' | 'params'
	rateLimitPerMinute: number
	verification:
		| PackageWebhookHmacVerificationEntry
		| PackageWebhookUrlSecretVerificationEntry
		| null
	replay: {
		timestampHeader?: string
		timestampFormat?:
			| 'unix-seconds'
			| 'unix-millis'
			| 'iso-8601'
			| 'stripe-signature'
		toleranceSeconds?: number
		deliveryIdHeader?: string
	} | null
	challenge: PackageWebhookChallenge | null
}

export function listPackageWebhooks(
	manifest: AuthoredPackageJson,
): Array<PackageWebhookManifestEntry> {
	return (manifest.kody.webhooks ?? [])
		.map((webhook) => ({
			name: webhook.name,
			exportName: normalizePackageExportKey(webhook.export),
			description: webhook.description?.trim() || null,
			responseMode: webhook.responseMode ?? 'ack',
			inputMode: webhook.inputMode ?? 'request',
			rateLimitPerMinute:
				webhook.rateLimitPerMinute ?? webhookDefaultRateLimitPerMinute,
			verification: !webhook.verification
				? null
				: webhook.verification.type === 'url-secret'
					? { type: 'url-secret' as const }
					: {
							type: webhook.verification.type,
							header: webhook.verification.header,
							...(webhook.verification.secretName !== undefined
								? { secretName: webhook.verification.secretName }
								: {}),
							encoding: webhook.verification.encoding,
							...(webhook.verification.prefix !== undefined
								? { prefix: webhook.verification.prefix }
								: {}),
							...(webhook.verification.signedPayload !== undefined
								? { signedPayload: webhook.verification.signedPayload }
								: {}),
						},
			replay: webhook.replay
				? {
						...(webhook.replay.timestampHeader !== undefined
							? { timestampHeader: webhook.replay.timestampHeader }
							: {}),
						...(webhook.replay.timestampFormat !== undefined
							? { timestampFormat: webhook.replay.timestampFormat }
							: {}),
						...(webhook.replay.toleranceSeconds !== undefined
							? { toleranceSeconds: webhook.replay.toleranceSeconds }
							: {}),
						...(webhook.replay.deliveryIdHeader !== undefined
							? { deliveryIdHeader: webhook.replay.deliveryIdHeader }
							: {}),
					}
				: null,
			challenge: webhook.challenge ?? null,
		}))
		.sort((left, right) => left.name.localeCompare(right.name))
}

export function listPackageEmittedEvents(manifest: AuthoredPackageJson) {
	return Object.entries(manifest.kody.emits ?? {})
		.map(([topic, emittedEvent]) => ({
			topic,
			description: emittedEvent.description.trim(),
			payloadSchema: emittedEvent.payloadSchema ?? null,
			...(emittedEvent.mcp === true ? { mcp: true as const } : {}),
		}))
		.sort((left, right) => left.topic.localeCompare(right.topic))
}

export type PackageRetrieverManifestEntry = {
	key: string
	exportName: string
	name: string
	description: string
	scopes: Array<PackageRetrieverScope>
	timeoutMs: number | null
	maxResults: number | null
}

export function listPackageRetrievers(
	manifest: AuthoredPackageJson,
): Array<PackageRetrieverManifestEntry> {
	return Object.entries(manifest.kody.retrievers ?? {})
		.map(([key, retriever]) => ({
			key,
			exportName: normalizePackageExportKey(retriever.export),
			name: retriever.name,
			description: retriever.description,
			scopes: Array.from(new Set(retriever.scopes)).sort(),
			timeoutMs: retriever.timeoutMs ?? null,
			maxResults: retriever.maxResults ?? null,
		}))
		.sort((left, right) => left.key.localeCompare(right.key))
}

export function getPackageTags(manifest: AuthoredPackageJson) {
	return [...(manifest.kody.tags ?? [])]
}

export type PackageExportFunctionProjection = {
	name: string
	description: string | null
	typeDefinition: string | null
	referencedTypes: Array<PackageReferencedTypeProjection>
}

export type PackageReferencedTypeProjection = {
	name: string
	kind: 'type' | 'interface' | 'enum'
	definition: string
}

export type PackageExportProjection = {
	subpath: string
	runtimeTarget: string | null
	typesPath: string | null
	description: string | null
	typeDefinition: string | null
	functions: Array<PackageExportFunctionProjection>
	referencedTypes: Array<PackageReferencedTypeProjection>
}

export type PackageSearchProjection = {
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	searchText: string | null
	hasApp: boolean
	isPrivate: boolean
	appEntry: string | null
	exports: Array<PackageExportProjection>
	jobs: Array<{
		name: string
		entry: string
		schedule: string
		enabled: boolean
	}>
	subscriptions: Array<{
		topic: string
		handler: string
		description: string | null
		filters: Record<string, unknown> | null
	}>
	emits?: Array<{
		topic: string
		description: string
		payloadSchema?: Record<string, unknown> | null
		mcp?: true
	}>
	retrievers: Array<PackageRetrieverManifestEntry>
	webhooks: Array<PackageWebhookManifestEntry>
}

type LocalTypeDeclaration = PackageReferencedTypeProjection & {
	node: ModuleAstNode
}

const maxReferencedTypesPerExport = 8
const maxReferencedTypeCharsPerExport = 12_000
const maxReferencedTypeDepth = 2
const builtinTypeNames = new Set([
	'AbortController',
	'AbortSignal',
	'Array',
	'ArrayBuffer',
	'Awaited',
	'Blob',
	'Boolean',
	'CallableFunction',
	'Capitalize',
	'ConstructorParameters',
	'Date',
	'Error',
	'Event',
	'EventTarget',
	'Exclude',
	'Extract',
	'File',
	'FormData',
	'Function',
	'Headers',
	'InstanceType',
	'Intl',
	'JSON',
	'Lowercase',
	'Map',
	'Math',
	'NonNullable',
	'Number',
	'Object',
	'Omit',
	'OmitThisParameter',
	'Parameters',
	'Partial',
	'Pick',
	'Promise',
	'Readonly',
	'ReadonlyArray',
	'Record',
	'RegExp',
	'Request',
	'Required',
	'Response',
	'ReturnType',
	'Set',
	'String',
	'ThisParameterType',
	'ThisType',
	'TransformStream',
	'URL',
	'URLSearchParams',
	'Uncapitalize',
	'Uppercase',
	'WeakMap',
	'WeakSet',
	'WritableStream',
	'any',
	'bigint',
	'boolean',
	'false',
	'never',
	'null',
	'number',
	'object',
	'string',
	'symbol',
	'true',
	'undefined',
	'unknown',
	'void',
])

function getNodeStart(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const start = (node as { start?: unknown }).start
	return typeof start === 'number' ? start : null
}

function getNodeEnd(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const end = (node as { end?: unknown }).end
	return typeof end === 'number' ? end : null
}

function getNodeType(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const type = (node as { type?: unknown }).type
	return typeof type === 'string' ? type : null
}

function getProgramBody(program: unknown): Array<ModuleAstNode> {
	const root = program as {
		program?: { body?: unknown }
		body?: unknown
	}
	const body = root.program?.body ?? root.body
	return Array.isArray(body) ? (body as Array<ModuleAstNode>) : []
}

function normalizeJsDocComment(comment: string) {
	const trimmed = comment.trim()
	if (!trimmed.startsWith('/**')) return null
	return trimmed
		.replace(/^\/\*\*/, '')
		.replace(/\*\/$/, '')
		.split('\n')
		.map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
		.join('\n')
		.trim()
}

function readLeadingJsDoc(source: string, start: number) {
	const prefix = source.slice(0, start)
	const match = prefix.match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/)
	if (!match) return null
	return normalizeJsDocComment(match[0] ?? '')
}

function readIdentifierName(node: unknown) {
	const name = (node as { name?: unknown }).name
	return typeof name === 'string' && name.trim() ? name : null
}

function getTypeDeclarationKind(
	node: ModuleAstNode | undefined,
): PackageReferencedTypeProjection['kind'] | null {
	if (!node) return null
	if (node.type === 'TSTypeAliasDeclaration') return 'type'
	if (node.type === 'TSInterfaceDeclaration') return 'interface'
	if (node.type === 'TSEnumDeclaration') return 'enum'
	return null
}

function collectLocalTypeDeclarations(
	source: string,
	body: Array<ModuleAstNode>,
) {
	const declarations = new Map<string, LocalTypeDeclaration>()
	for (const statement of body) {
		const declaration =
			statement.type === 'ExportNamedDeclaration'
				? ((statement as { declaration?: unknown }).declaration as
						| ModuleAstNode
						| undefined)
				: statement
		const kind = getTypeDeclarationKind(declaration)
		if (!kind || !declaration) continue
		const name = readIdentifierName((declaration as { id?: unknown }).id)
		if (!name || builtinTypeNames.has(name) || declarations.has(name)) continue
		const definitionNode =
			statement.type === 'ExportNamedDeclaration' ? statement : declaration
		const start = getNodeStart(definitionNode)
		const end = getNodeEnd(definitionNode)
		if (start == null || end == null) continue
		const definition = source
			.slice(start, end)
			.trim()
			.replace(/\s*;\s*$/, '')
		if (!definition) continue
		declarations.set(name, {
			name,
			kind,
			definition,
			node: declaration,
		})
	}
	return declarations
}

function readTypeReferenceName(node: unknown): string | null {
	if (!node || typeof node !== 'object') return null
	const type = getNodeType(node)
	if (type === 'TSQualifiedName') {
		return readTypeReferenceName((node as { left?: unknown }).left)
	}
	if (type !== 'Identifier') return null
	return readIdentifierName(node)
}

function pushUniqueTypeName(names: Array<string>, name: string | null) {
	if (!name || builtinTypeNames.has(name) || names.includes(name)) return
	names.push(name)
}

function collectTypeReferenceNamesFromNodes(nodes: Array<unknown>) {
	const names: Array<string> = []
	const seen = new Set<object>()
	function visit(node: unknown) {
		if (!node || typeof node !== 'object') return
		if (seen.has(node)) return
		seen.add(node)
		const type = getNodeType(node)
		if (type === 'TSTypeReference') {
			pushUniqueTypeName(
				names,
				readTypeReferenceName((node as { typeName?: unknown }).typeName),
			)
		}
		if (type === 'TSExpressionWithTypeArguments') {
			pushUniqueTypeName(
				names,
				readTypeReferenceName((node as { expression?: unknown }).expression),
			)
		}
		for (const [key, value] of Object.entries(node)) {
			if (
				key === 'loc' ||
				key === 'start' ||
				key === 'end' ||
				key === 'leadingComments' ||
				key === 'trailingComments' ||
				key === 'innerComments' ||
				key === 'extra'
			) {
				continue
			}
			if (Array.isArray(value)) {
				for (const item of value) visit(item)
				continue
			}
			visit(value)
		}
	}
	for (const node of nodes) visit(node)
	return names
}

function getParamTypeAnnotationNodes(param: unknown): Array<unknown> {
	if (!param || typeof param !== 'object') return []
	const nodes: Array<unknown> = []
	const typeAnnotation = (param as { typeAnnotation?: unknown }).typeAnnotation
	if (typeAnnotation) nodes.push(typeAnnotation)
	const type = getNodeType(param)
	if (type === 'AssignmentPattern') {
		nodes.push(
			...getParamTypeAnnotationNodes((param as { left?: unknown }).left),
		)
	}
	if (type === 'RestElement') {
		nodes.push(
			...getParamTypeAnnotationNodes(
				(param as { argument?: unknown }).argument,
			),
		)
	}
	return nodes
}

function getFunctionReferenceNodes(
	node: unknown,
	options: { includeTypeParameters?: boolean } = {},
) {
	const functionNode = node as {
		params?: unknown
		returnType?: unknown
		typeParameters?: unknown
	}
	const params = Array.isArray(functionNode.params) ? functionNode.params : []
	return [
		...((options.includeTypeParameters ?? true)
			? [functionNode.typeParameters]
			: []),
		...params.flatMap(getParamTypeAnnotationNodes),
		functionNode.returnType,
	]
}

function getVariableFunctionReferenceNodes(declarator: ModuleAstNode) {
	const id = (declarator as { id?: unknown }).id
	const typeAnnotation = (id as { typeAnnotation?: unknown } | undefined)
		?.typeAnnotation
	if (typeAnnotation) return [typeAnnotation]
	const init = (declarator as { init?: unknown }).init
	if (
		getNodeType(init) !== 'ArrowFunctionExpression' &&
		getNodeType(init) !== 'FunctionExpression'
	) {
		return []
	}
	return getFunctionReferenceNodes(init, { includeTypeParameters: false })
}

function collectReferencedTypes(input: {
	typeNames: Array<string>
	localTypes: Map<string, LocalTypeDeclaration>
}) {
	const referencedTypes: Array<PackageReferencedTypeProjection> = []
	const seen = new Set<string>()
	const queued = new Set<string>()
	const queue: Array<{ name: string; depth: number }> = []
	let totalChars = 0
	function enqueue(name: string, depth: number) {
		if (
			builtinTypeNames.has(name) ||
			queued.has(name) ||
			seen.has(name) ||
			!input.localTypes.has(name)
		) {
			return
		}
		queued.add(name)
		queue.push({ name, depth })
	}
	for (const name of input.typeNames) enqueue(name, 0)
	while (
		queue.length > 0 &&
		referencedTypes.length < maxReferencedTypesPerExport
	) {
		const next = queue.shift()
		if (!next) break
		const declaration = input.localTypes.get(next.name)
		if (!declaration || seen.has(next.name)) continue
		const nextChars = totalChars + declaration.definition.length
		if (nextChars > maxReferencedTypeCharsPerExport) {
			if (maxReferencedTypeCharsPerExport - totalChars <= 0) break
			continue
		}
		seen.add(next.name)
		totalChars = nextChars
		referencedTypes.push({
			name: declaration.name,
			kind: declaration.kind,
			definition: declaration.definition,
		})
		if (next.depth >= maxReferencedTypeDepth) continue
		for (const nestedName of collectTypeReferenceNamesFromNodes([
			declaration.node,
		])) {
			enqueue(nestedName, next.depth + 1)
		}
	}
	return referencedTypes
}

function mergeReferencedTypes(
	typeGroups: Array<Array<PackageReferencedTypeProjection>>,
) {
	const referencedTypes: Array<PackageReferencedTypeProjection> = []
	const seen = new Set<string>()
	let totalChars = 0
	for (const type of typeGroups.flat()) {
		if (seen.has(type.name)) continue
		const nextChars = totalChars + type.definition.length
		if (nextChars > maxReferencedTypeCharsPerExport) {
			if (maxReferencedTypeCharsPerExport - totalChars <= 0) break
			continue
		}
		seen.add(type.name)
		totalChars = nextChars
		referencedTypes.push(type)
		if (referencedTypes.length >= maxReferencedTypesPerExport) break
	}
	return referencedTypes
}

function getFunctionSignature(input: {
	source: string
	node: ModuleAstNode
	exportKeyword: string
}) {
	const start = getNodeStart(input.node)
	if (start == null) return null
	const bodyStart = getNodeStart((input.node as { body?: unknown }).body)
	const end = bodyStart ?? getNodeEnd(input.node)
	if (end == null) return null
	const signature = input.source
		.slice(start, end)
		.trim()
		.replace(/\s*\{$/, '')
		.replace(/\s*;\s*$/, '')
	return `${input.exportKeyword} ${signature}`.replace(/\s+/g, ' ').trim()
}

function formatParameterList(source: string, params: unknown) {
	if (!Array.isArray(params)) return ''
	return params
		.map((param) => {
			const start = getNodeStart(param)
			const end = getNodeEnd(param)
			return start == null || end == null
				? null
				: source.slice(start, end).trim()
		})
		.filter((param): param is string => param != null && param.length > 0)
		.join(', ')
}

function getReturnType(source: string, node: unknown) {
	const returnType = (node as { returnType?: unknown }).returnType
	const start = getNodeStart(returnType)
	const end = getNodeEnd(returnType)
	if (start == null || end == null) return 'unknown'
	return source.slice(start, end).replace(/^:\s*/, '').trim()
}

function getVariableFunctionSignature(input: {
	source: string
	declarator: ModuleAstNode
	exportKind: 'export' | 'export declare' | 'export default'
}) {
	const id = (input.declarator as { id?: unknown }).id
	const name = readIdentifierName(id)
	if (!name) return null
	const typeAnnotation = (id as { typeAnnotation?: unknown }).typeAnnotation
	const typeStart = getNodeStart(typeAnnotation)
	const typeEnd = getNodeEnd(typeAnnotation)
	if (typeStart != null && typeEnd != null) {
		return input.exportKind === 'export default'
			? `${input.exportKind} ${name}${input.source.slice(typeStart, typeEnd)}`
			: `${input.exportKind} const ${name}${input.source.slice(typeStart, typeEnd)}`
	}
	const init = (input.declarator as { init?: unknown }).init as
		| ModuleAstNode
		| undefined
	if (
		getNodeType(init) !== 'ArrowFunctionExpression' &&
		getNodeType(init) !== 'FunctionExpression'
	) {
		return null
	}
	const asyncPrefix =
		(init as { async?: unknown }).async === true ? 'async ' : ''
	const params = formatParameterList(
		input.source,
		(init as { params?: unknown }).params,
	)
	const returnType = getReturnType(input.source, init)
	return `${input.exportKind} ${asyncPrefix}function ${name}(${params}): ${returnType}`
}

function isFunctionDeclarator(declarator: ModuleAstNode) {
	const id = (declarator as { id?: unknown }).id
	if (!readIdentifierName(id)) return false
	const typeAnnotation = (id as { typeAnnotation?: unknown }).typeAnnotation
	const declaredType = (
		typeAnnotation as { typeAnnotation?: unknown } | undefined
	)?.typeAnnotation
	if (getNodeType(declaredType) === 'TSFunctionType') return true
	const init = (declarator as { init?: unknown }).init
	return (
		getNodeType(init) === 'ArrowFunctionExpression' ||
		getNodeType(init) === 'FunctionExpression'
	)
}

function isFunctionDeclaration(node: unknown): node is ModuleAstNode {
	const type = getNodeType(node)
	return type === 'FunctionDeclaration' || type === 'TSDeclareFunction'
}

function getVariableDeclarationExportKind(
	declaration: ModuleAstNode,
): 'export' | 'export declare' {
	return (declaration as { declare?: unknown }).declare === true
		? 'export declare'
		: 'export'
}

type LocalFunctionBinding = {
	kind: 'function' | 'variable'
	node: ModuleAstNode
	jsDocStart: number | null
}

type ImportedTypeSpecifier = {
	localName: string
	importedName: string
	moduleSpecifier: string
}

function dirnamePackagePath(filePath: string) {
	const normalized = normalizePackageWorkspacePath(filePath)
	const separator = normalized.lastIndexOf('/')
	return separator === -1 ? '' : normalized.slice(0, separator)
}

function normalizeRelativePackagePath(path: string) {
	const parts: Array<string> = []
	for (const segment of path.replace(/\\/g, '/').split('/')) {
		if (!segment || segment === '.') continue
		if (segment === '..') {
			parts.pop()
			continue
		}
		parts.push(segment)
	}
	return parts.join('/')
}

function resolveSamePackageTypeImportPath(input: {
	files: Record<string, string>
	fromPath: string
	specifier: string
}) {
	if (!input.specifier.startsWith('./') && !input.specifier.startsWith('../')) {
		return null
	}
	const fromDir = dirnamePackagePath(input.fromPath)
	const resolved = normalizeRelativePackagePath(
		fromDir ? `${fromDir}/${input.specifier}` : input.specifier,
	)
	const candidates = [resolved]
	if (!resolved.endsWith('.ts')) {
		candidates.push(`${resolved}.ts`)
	}
	return candidates.find((candidate) => input.files[candidate] != null) ?? null
}

function hasNamedExportedFunction(body: Array<ModuleAstNode>, name: string) {
	for (const statement of body) {
		if (getNodeType(statement) !== 'ExportNamedDeclaration') continue
		const declaration = (statement as { declaration?: unknown }).declaration as
			| ModuleAstNode
			| undefined
		if (isFunctionDeclaration(declaration)) {
			if (readIdentifierName((declaration as { id?: unknown }).id) === name) {
				return true
			}
			continue
		}
		if (!declaration || getNodeType(declaration) !== 'VariableDeclaration') {
			continue
		}
		const declarations = (declaration as { declarations?: unknown })
			.declarations
		if (!Array.isArray(declarations)) continue
		for (const declarator of (declarations as Array<ModuleAstNode>).filter(
			isFunctionDeclarator,
		)) {
			if (readIdentifierName((declarator as { id?: unknown }).id) === name) {
				return true
			}
		}
	}
	return false
}

function collectImportedBindingNames(body: Array<ModuleAstNode>) {
	const names = new Set<string>()
	for (const statement of body) {
		if (statement.type !== 'ImportDeclaration') continue
		const specifiers = (statement as { specifiers?: unknown }).specifiers
		if (!Array.isArray(specifiers)) continue
		for (const specifier of specifiers) {
			const localName = readIdentifierName(
				(specifier as { local?: unknown }).local,
			)
			if (localName) names.add(localName)
		}
	}
	return names
}

function collectLocalFunctionBindings(body: Array<ModuleAstNode>) {
	const bindings = new Map<string, LocalFunctionBinding>()
	function addFunctionDeclaration(
		declaration: ModuleAstNode,
		jsDocStart: number | null,
	) {
		const name = readIdentifierName((declaration as { id?: unknown }).id)
		if (!name || bindings.has(name)) return
		bindings.set(name, {
			kind: 'function',
			node: declaration,
			jsDocStart,
		})
	}
	function addVariableDeclaration(
		declaration: ModuleAstNode,
		jsDocStart: number | null,
	) {
		const declarations = (declaration as { declarations?: unknown })
			.declarations
		if (!Array.isArray(declarations)) return
		for (const declarator of (declarations as Array<ModuleAstNode>).filter(
			isFunctionDeclarator,
		)) {
			const name = readIdentifierName((declarator as { id?: unknown }).id)
			if (!name || bindings.has(name)) continue
			bindings.set(name, {
				kind: 'variable',
				node: declarator,
				jsDocStart,
			})
		}
	}
	for (const statement of body) {
		if (
			getNodeType(statement) === 'FunctionDeclaration' ||
			getNodeType(statement) === 'TSDeclareFunction'
		) {
			addFunctionDeclaration(statement, getNodeStart(statement))
			continue
		}
		if (getNodeType(statement) === 'VariableDeclaration') {
			addVariableDeclaration(statement, getNodeStart(statement))
			continue
		}
		if (getNodeType(statement) !== 'ExportNamedDeclaration') continue
		const declaration = (statement as { declaration?: unknown }).declaration as
			| ModuleAstNode
			| undefined
		if (isFunctionDeclaration(declaration)) {
			addFunctionDeclaration(
				declaration,
				getNodeStart(declaration) ?? getNodeStart(statement),
			)
			continue
		}
		if (declaration && getNodeType(declaration) === 'VariableDeclaration') {
			addVariableDeclaration(
				declaration,
				getNodeStart(declaration) ?? getNodeStart(statement),
			)
		}
	}
	return bindings
}

function readImportSourceSpecifier(node: ModuleAstNode) {
	const value = (node as { source?: { value?: unknown } }).source?.value
	return typeof value === 'string' && value.trim() ? value : null
}

function collectImportedTypeSpecifiers(body: Array<ModuleAstNode>) {
	const specifiers: Array<ImportedTypeSpecifier> = []
	for (const statement of body) {
		if (statement.type !== 'ImportDeclaration') continue
		const moduleSpecifier = readImportSourceSpecifier(statement)
		if (
			!moduleSpecifier ||
			(!moduleSpecifier.startsWith('./') && !moduleSpecifier.startsWith('../'))
		) {
			continue
		}
		const rawSpecifiers = (statement as { specifiers?: unknown }).specifiers
		if (!Array.isArray(rawSpecifiers)) continue
		for (const specifier of rawSpecifiers) {
			if (getNodeType(specifier) !== 'ImportSpecifier') continue
			const localName = readIdentifierName(
				(specifier as { local?: unknown }).local,
			)
			if (!localName) continue
			const importedName =
				readIdentifierName((specifier as { imported?: unknown }).imported) ??
				localName
			specifiers.push({
				localName,
				importedName,
				moduleSpecifier,
			})
		}
	}
	return specifiers
}

function remapAliasedImportedType(input: {
	localTypes: Map<string, LocalTypeDeclaration>
	specifier: ImportedTypeSpecifier
}) {
	if (input.specifier.importedName === input.specifier.localName) return
	if (input.localTypes.has(input.specifier.localName)) return
	const declaration = input.localTypes.get(input.specifier.importedName)
	if (!declaration) return
	input.localTypes.set(input.specifier.localName, {
		...declaration,
		name: input.specifier.localName,
	})
}

function createImportedTypeMerger(input: {
	sourcePath: string | null
	files?: Record<string, string>
	body: Array<ModuleAstNode>
	localTypes: Map<string, LocalTypeDeclaration>
}) {
	const importedSpecifiers = collectImportedTypeSpecifiers(input.body)
	const resolvedModules = new Set<string>()
	return (typeNames: Array<string>) => {
		if (!input.sourcePath || !input.files || typeNames.length === 0) return
		for (const specifier of importedSpecifiers) {
			if (!typeNames.includes(specifier.localName)) continue
			if (!resolvedModules.has(specifier.moduleSpecifier)) {
				const resolvedPath = resolveSamePackageTypeImportPath({
					files: input.files,
					fromPath: input.sourcePath,
					specifier: specifier.moduleSpecifier,
				})
				if (!resolvedPath) continue
				const importedSource = input.files[resolvedPath]
				if (importedSource == null) continue
				let importedBody: Array<ModuleAstNode>
				try {
					importedBody = getProgramBody(parseModuleSource(importedSource))
				} catch {
					continue
				}
				resolvedModules.add(specifier.moduleSpecifier)
				for (const [name, declaration] of collectLocalTypeDeclarations(
					importedSource,
					importedBody,
				)) {
					if (!input.localTypes.has(name)) {
						input.localTypes.set(name, declaration)
					}
				}
			}
			remapAliasedImportedType({
				localTypes: input.localTypes,
				specifier,
			})
		}
	}
}

function projectDefaultExportIdentifier(input: {
	source: string
	statement: ModuleAstNode
	declaration: ModuleAstNode
	localFunctions: Map<string, LocalFunctionBinding>
	importedBindings: Set<string>
	referencedTypesFor: (
		typeNames: Array<string>,
	) => Array<PackageReferencedTypeProjection>
}): PackageExportFunctionProjection | null {
	const name = readIdentifierName(input.declaration)
	if (!name || input.importedBindings.has(name)) return null
	const binding = input.localFunctions.get(name)
	if (!binding) return null
	const typeDefinition =
		binding.kind === 'function'
			? getFunctionSignature({
					source: input.source,
					node: binding.node,
					exportKeyword: 'export default',
				})
			: getVariableFunctionSignature({
					source: input.source,
					declarator: binding.node,
					exportKind: 'export default',
				})
	const typeNames = typeDefinition
		? collectTypeReferenceNamesFromNodes(
				binding.kind === 'function'
					? getFunctionReferenceNodes(binding.node)
					: getVariableFunctionReferenceNodes(binding.node),
			)
		: []
	const bindingJsDoc =
		binding.jsDocStart == null
			? null
			: readLeadingJsDoc(input.source, binding.jsDocStart)
	const exportStart = getNodeStart(input.statement)
	const exportJsDoc =
		exportStart == null ? null : readLeadingJsDoc(input.source, exportStart)
	return {
		name: 'default',
		description: bindingJsDoc ?? exportJsDoc,
		typeDefinition,
		referencedTypes: typeDefinition ? input.referencedTypesFor(typeNames) : [],
	}
}

function collectExportedFunctionsFromSource(input: {
	source: string
	files?: Record<string, string>
	sourcePath?: string | null
}) {
	const { source } = input
	let body: Array<ModuleAstNode>
	try {
		body = getProgramBody(parseModuleSource(source))
	} catch {
		return []
	}
	const localTypes = collectLocalTypeDeclarations(source, body)
	const localFunctions = collectLocalFunctionBindings(body)
	const importedBindings = collectImportedBindingNames(body)
	const mergeImportedTypes = createImportedTypeMerger({
		sourcePath: input.sourcePath ?? null,
		files: input.files,
		body,
		localTypes,
	})
	function referencedTypesFor(typeNames: Array<string>) {
		mergeImportedTypes(typeNames)
		return collectReferencedTypes({
			typeNames,
			localTypes,
		})
	}
	const functions: Array<PackageExportFunctionProjection> = []
	for (const statement of body) {
		if (statement.type === 'ExportDefaultDeclaration') {
			const declaration = (statement as { declaration?: unknown })
				.declaration as ModuleAstNode | undefined
			if (isFunctionDeclaration(declaration)) {
				const declarationStart = getNodeStart(declaration)
				const typeDefinition = getFunctionSignature({
					source,
					node: declaration,
					exportKeyword: 'export default',
				})
				functions.push({
					name: 'default',
					description:
						(declarationStart == null
							? null
							: readLeadingJsDoc(source, declarationStart)) ??
						(getNodeStart(statement) == null
							? null
							: readLeadingJsDoc(source, getNodeStart(statement) ?? 0)),
					typeDefinition,
					referencedTypes: typeDefinition
						? referencedTypesFor(
								collectTypeReferenceNamesFromNodes(
									getFunctionReferenceNodes(declaration),
								),
							)
						: [],
				})
			} else if (declaration && getNodeType(declaration) === 'Identifier') {
				const bindingName = readIdentifierName(declaration)
				if (bindingName && hasNamedExportedFunction(body, bindingName)) {
					continue
				}
				const projected = projectDefaultExportIdentifier({
					source,
					statement,
					declaration,
					localFunctions,
					importedBindings,
					referencedTypesFor,
				})
				if (projected) functions.push(projected)
			}
			continue
		}
		if (statement.type !== 'ExportNamedDeclaration') continue
		const declaration = (statement as { declaration?: unknown }).declaration as
			| ModuleAstNode
			| undefined
		const statementStart = getNodeStart(statement)
		const description =
			statementStart == null ? null : readLeadingJsDoc(source, statementStart)
		if (isFunctionDeclaration(declaration)) {
			const name = readIdentifierName((declaration as { id?: unknown }).id)
			if (!name) continue
			const typeDefinition = getFunctionSignature({
				source,
				node: declaration,
				exportKeyword: 'export',
			})
			functions.push({
				name,
				description,
				typeDefinition,
				referencedTypes: typeDefinition
					? referencedTypesFor(
							collectTypeReferenceNamesFromNodes(
								getFunctionReferenceNodes(declaration),
							),
						)
					: [],
			})
			continue
		}
		if (!declaration || getNodeType(declaration) !== 'VariableDeclaration') {
			continue
		}
		const declarations = (declaration as { declarations?: unknown })
			.declarations
		if (!Array.isArray(declarations)) continue
		const exportKind = getVariableDeclarationExportKind(declaration)
		for (const declarator of (declarations as Array<ModuleAstNode>).filter(
			isFunctionDeclarator,
		)) {
			const name = readIdentifierName((declarator as { id?: unknown }).id)
			if (!name) continue
			const typeDefinition = getVariableFunctionSignature({
				source,
				declarator,
				exportKind,
			})
			functions.push({
				name,
				description,
				typeDefinition,
				referencedTypes: typeDefinition
					? referencedTypesFor(
							collectTypeReferenceNamesFromNodes(
								getVariableFunctionReferenceNodes(declarator),
							),
						)
					: [],
			})
		}
	}
	return functions
}

function summarizePackageExport(input: {
	exportName: string
	target: PackageExportTarget
	files?: Record<string, string>
}): PackageExportProjection {
	const runtimeTarget = readTargetPath(input.target, 'runtime')
	const typesPath = readTargetPath(input.target, 'types')
	const runtimeSource = runtimeTarget
		? (input.files?.[normalizePackageWorkspacePath(runtimeTarget)] ?? null)
		: null
	const typesSource = typesPath
		? (input.files?.[normalizePackageWorkspacePath(typesPath)] ?? null)
		: null
	const source = typesSource ?? runtimeSource ?? ''
	const sourcePath = typesSource
		? typesPath
			? normalizePackageWorkspacePath(typesPath)
			: null
		: runtimeTarget
			? normalizePackageWorkspacePath(runtimeTarget)
			: null
	const functions = collectExportedFunctionsFromSource({
		source,
		files: input.files,
		sourcePath,
	})
	const [firstFunction] = functions
	return {
		subpath: normalizePackageExportKey(input.exportName),
		runtimeTarget: runtimeTarget
			? normalizePackageWorkspacePath(runtimeTarget)
			: null,
		typesPath: typesPath ? normalizePackageWorkspacePath(typesPath) : null,
		description: firstFunction?.description ?? null,
		typeDefinition:
			functions.length === 1 ? (firstFunction?.typeDefinition ?? null) : null,
		functions,
		referencedTypes: mergeReferencedTypes(
			functions.map((fn) => fn.referencedTypes),
		),
	}
}

export function buildPackageSearchProjection(
	manifest: AuthoredPackageJson,
	files?: Record<string, string>,
): PackageSearchProjection {
	const appEntry = getPackageAppEntryPath(manifest)
	return {
		name: manifest.name,
		kodyId: manifest.kody.id,
		description: manifest.kody.description,
		tags: getPackageTags(manifest),
		searchText: manifest.kody.searchText?.trim() || null,
		hasApp: appEntry !== null,
		isPrivate: manifest.private === true,
		appEntry,
		exports: Object.entries(manifest.exports)
			.map(([exportName, target]) =>
				summarizePackageExport({ exportName, target, files }),
			)
			.sort((left, right) => left.subpath.localeCompare(right.subpath)),
		jobs: Object.entries(manifest.kody.jobs ?? {})
			.map(([name, job]) => ({
				name,
				entry: normalizePackageWorkspacePath(job.entry),
				schedule:
					job.schedule.type === 'cron'
						? `cron:${job.schedule.expression}`
						: job.schedule.type === 'interval'
							? `interval:${job.schedule.every}`
							: `once:${job.schedule.runAt}`,
				enabled: job.enabled ?? true,
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
		subscriptions: listPackageSubscriptions(manifest),
		emits: listPackageEmittedEvents(manifest),
		retrievers: listPackageRetrievers(manifest),
		webhooks: listPackageWebhooks(manifest),
	}
}

export function buildPackageSearchDocument(
	projection: PackageSearchProjection,
) {
	const jobLines = projection.jobs.map((job) =>
		[job.name, job.entry, job.schedule, job.enabled ? 'enabled' : 'disabled']
			.filter(
				(value): value is string =>
					typeof value === 'string' && value.length > 0,
			)
			.join(' '),
	)
	const subscriptionLines = (projection.subscriptions ?? []).map(
		(subscription) =>
			[
				`subscription:${subscription.topic}`,
				subscription.handler,
				subscription.description ?? '',
			]
				.filter((value) => value.length > 0)
				.join(' '),
	)
	const emitsLines = (projection.emits ?? []).map((event) =>
		[`emits:${event.topic}`, event.description]
			.filter((value) => value.length > 0)
			.join(' '),
	)
	const retrieverLines = projection.retrievers.map((retriever) =>
		[
			`retriever:${retriever.key}`,
			retriever.name,
			retriever.description,
			retriever.exportName,
			...retriever.scopes.map((scope) => `scope:${scope}`),
		]
			.filter((value) => value.length > 0)
			.join(' '),
	)
	const webhookLines = (projection.webhooks ?? []).map((webhook) =>
		[
			`webhook:${webhook.name}`,
			webhook.exportName,
			webhook.description ?? '',
			webhook.responseMode,
			webhook.inputMode === 'params' ? 'input:params' : '',
			webhook.rateLimitPerMinute !== webhookDefaultRateLimitPerMinute
				? `rate:${webhook.rateLimitPerMinute}`
				: '',
			webhook.verification?.type === 'url-secret'
				? 'verify:url-secret'
				: webhook.verification
					? `verify:${webhook.verification.header}`
					: '',
			webhook.verification?.type !== 'url-secret' &&
			webhook.verification?.signedPayload
				? `signed:${webhook.verification.signedPayload}`
				: '',
			webhook.replay?.timestampHeader
				? `replay-timestamp:${webhook.replay.timestampHeader}:${webhook.replay.timestampFormat ?? ''}`
				: '',
			webhook.replay?.deliveryIdHeader
				? `replay-delivery:${webhook.replay.deliveryIdHeader}`
				: '',
		]
			.filter((value) => value.length > 0)
			.join(' '),
	)
	const exportLines = projection.exports.map((exportDetail) => {
		const functions = Array.isArray(exportDetail.functions)
			? exportDetail.functions
			: []
		const referencedTypes = Array.isArray(exportDetail.referencedTypes)
			? exportDetail.referencedTypes
			: []
		const values = [
			typeof exportDetail.subpath === 'string' ? exportDetail.subpath : '',
			typeof exportDetail.runtimeTarget === 'string'
				? exportDetail.runtimeTarget
				: '',
			typeof exportDetail.typesPath === 'string' ? exportDetail.typesPath : '',
			typeof exportDetail.description === 'string'
				? exportDetail.description
				: '',
			typeof exportDetail.typeDefinition === 'string'
				? exportDetail.typeDefinition
				: '',
			...functions.flatMap((fn) => [
				typeof fn.name === 'string' ? fn.name : '',
				typeof fn.description === 'string' ? fn.description : '',
				typeof fn.typeDefinition === 'string' ? fn.typeDefinition : '',
			]),
			...referencedTypes.flatMap((type) => [type.name, type.definition]),
		]
		return values.filter((value) => value.length > 0).join(' ')
	})
	return [
		`package ${projection.kodyId}`,
		projection.name,
		projection.description,
		projection.tags.join(' '),
		projection.searchText ?? '',
		exportLines.join('\n'),
		jobLines.join('\n'),
		subscriptionLines.join('\n'),
		emitsLines.join('\n'),
		retrieverLines.join('\n'),
		webhookLines.join('\n'),
		projection.appEntry
			? `app ${projection.appEntry}`
			: projection.hasApp
				? 'app'
				: '',
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}
