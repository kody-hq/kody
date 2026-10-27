import { z } from 'zod'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import {
	apiTokenScopeDescriptions,
	apiTokenScopes,
} from '#worker/api-tokens/scopes.ts'
import { apiTokenIdleTtlDescription } from '#worker/api-tokens/service.ts'
import {
	type SurfacePermission,
	surfacePermissionList,
} from '#worker/authorization/authorize.ts'
import { apiErrorCodes } from './errors.ts'
import {
	apiOperationUsesQueryInputs,
	apiOperations,
	capabilityNameForOperation,
	getApiOperationPathParams,
	isCapabilityProxyGatewayFetchOperation,
	listApiOperationPaths,
	type ApiOperation,
	type CapabilityApiOperation,
} from './operations.ts'
import { nativeApiOperationDefinitions } from './native-operations.ts'

export const openApiVersion = '3.1.0'
export const kodyApiVersion = '1.0.0'

type JsonSchema = Record<string, unknown>

type OpenApiMediaType = {
	schema: JsonSchema
	description?: string
}

type OpenApiParameter = {
	name: string
	in: 'path' | 'query' | 'header'
	required: boolean
	description?: string
	schema: JsonSchema
	style?: 'form'
	explode?: boolean
}

type OpenApiOperation = {
	operationId: string
	summary: string
	description: string
	deprecated?: boolean
	tags: Array<string>
	parameters?: Array<OpenApiParameter>
	requestBody?: {
		required: boolean
		description?: string
		content: Record<string, OpenApiMediaType>
	}
	responses: Record<string, unknown>
	security: Array<Record<string, Array<string>>>
	/**
	 * Org permission the caller must hold (`none`: touches no org data). A list
	 * means any one of them; the handler picks per call (create vs update).
	 */
	'x-kody-permission': SurfacePermission
	'x-kody-read-only': boolean
	'x-kody-feature-flag'?: string
}

export type OpenApiDocument = {
	openapi: typeof openApiVersion
	info: Record<string, unknown>
	externalDocs?: { description: string; url: string }
	servers: Array<{ url: string }>
	tags: Array<{ name: string; description: string }>
	security: Array<Record<string, Array<string>>>
	paths: Record<string, Record<string, OpenApiOperation>>
	components: {
		schemas: Record<string, JsonSchema>
		responses: Record<string, unknown>
		securitySchemes: Record<string, unknown>
	}
}

/** Public interactive docs host (separate Worker; JSON stays on api.kody.codes). */
export const kodyApiDocsUrl = 'https://api-docs.kody.codes'

const errorResponseRef = { $ref: '#/components/responses/Error' } as const
const rateLimitedResponseRef = {
	$ref: '#/components/responses/RateLimited',
} as const

/** Shared 4xx/5xx map so every operation documents the Error envelope. */
function documentedErrorResponses() {
	return {
		'400': errorResponseRef,
		'401': errorResponseRef,
		'403': errorResponseRef,
		'404': errorResponseRef,
		'409': errorResponseRef,
		'413': errorResponseRef,
		'429': rateLimitedResponseRef,
		'500': errorResponseRef,
		'503': errorResponseRef,
		default: errorResponseRef,
	} as const
}

export type ResolvedApiOperation = {
	operation: ApiOperation
	description: string
	inputSchema: JsonSchema
	outputSchema: JsonSchema | null
	permission: SurfacePermission
	readOnly: boolean
	featureFlag: string | null
}

const tagDescriptions: Record<ApiOperation['tag'], string> = {
	account: 'Account profile, usage, waiting items, export, and feedback.',
	search: 'Unified Kody search.',
	memories: 'Memories and the MCP server-instruction overlay.',
	secrets:
		'Secret metadata and writes. Secret values can be written but are never returned.',
	packages: 'Saved packages, sharing, and subscriptions.',
	follows: 'Follow a package or plain repo by @handle/name.',
	repos: 'Repos and repo sessions (edit, check, commit, publish).',
	jobs: 'Package jobs and workflow runs.',
	webhooks: 'Package webhook URLs and deliveries.',
	email: 'Inboxes, messages, sender rules, destinations, and sending.',
	integrations: 'OAuth integrations and OAuth apps.',
	'mcp-servers': 'User-added MCP servers.',
	runs: 'Execution run history and triage.',
	storage: 'Durable storage export and SQL query.',
	community: 'Public packages in the community catalog, and profile.',
	tokens: 'Scoped, short-lived API tokens.',
	'capability-proxy':
		'Platform I/O for a local execute venue: CapabilityProxy hops (`kody:runtime` calls) and `POST /v1/local-execute/package-graph` (stamped `kody:@…` module download). Requires `org:execute` and a scoped API token or CLI `kody login` MCP OAuth bearer.',
	execute:
		'Cloud sandbox execute. `POST /v1/execute` runs a module and returns the MCP execute envelope. Requires `org:execute` and a `kody_at_` token.',
}

function stripSchemaMeta(schema: JsonSchema): JsonSchema {
	const { $schema: _schema, ...rest } = schema
	return rest
}

/**
 * Move `$defs` into `components.schemas` under an operation-scoped name and
 * rewrite `#/$defs/...` references so the schema is valid inside OpenAPI.
 */
function hoistDefs(
	schema: JsonSchema,
	prefix: string,
	componentSchemas: Record<string, JsonSchema>,
): JsonSchema {
	const defs = isRecord(schema['$defs']) ? schema['$defs'] : null
	const { $defs: _defs, ...rest } = stripSchemaMeta(schema)
	if (!defs) return rest
	const componentName = (name: string) =>
		`${prefix}_${name.replace(/[^A-Za-z0-9._-]/g, '_')}`
	const rewrite = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(rewrite)
		if (!isRecord(value)) return value
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => {
				if (
					key === '$ref' &&
					typeof entry === 'string' &&
					entry.startsWith('#/$defs/')
				) {
					return [
						key,
						`#/components/schemas/${componentName(entry.slice('#/$defs/'.length))}`,
					]
				}
				return [key, rewrite(entry)]
			}),
		)
	}
	for (const [name, definition] of Object.entries(defs)) {
		componentSchemas[componentName(name)] = rewrite(definition) as JsonSchema
	}
	return rewrite(rest) as JsonSchema
}

function summarize(description: string) {
	const firstLine = description.trim().split('\n')[0] ?? ''
	const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine
	return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence
}

function readProperties(schema: JsonSchema) {
	return isRecord(schema['properties'])
		? (schema['properties'] as Record<string, JsonSchema>)
		: {}
}

function readRequired(schema: JsonSchema) {
	return Array.isArray(schema['required'])
		? (schema['required'] as Array<string>)
		: []
}

function readUnionVariants(schema: JsonSchema): Array<JsonSchema> {
	const variants: Array<JsonSchema> = []
	for (const key of ['anyOf', 'oneOf'] as const) {
		const entries = schema[key]
		if (!Array.isArray(entries)) continue
		for (const entry of entries) {
			if (isRecord(entry)) variants.push(entry as JsonSchema)
		}
	}
	return variants
}

function narrowForwardSchema(
	schema: JsonSchema,
	fixedInputs: Readonly<Record<string, string>>,
	operationId: string,
): JsonSchema {
	const matches = readUnionVariants(schema).filter((variant) =>
		Object.entries(fixedInputs).every(([key, value]) => {
			const property = readProperties(variant)[key]
			if (!isRecord(property)) return false
			if (property['const'] === value) return true
			const enumValues = property['enum']
			return (
				Array.isArray(enumValues) &&
				enumValues.length === 1 &&
				enumValues[0] === value
			)
		}),
	)
	if (matches.length !== 1) {
		throw new Error(
			`Open API operation "${operationId}" expected one matching schema variant, found ${matches.length}.`,
		)
	}
	const variant = matches[0]!
	const { anyOf: _anyOf, oneOf: _oneOf, ...schemaMetadata } = schema
	return {
		...schemaMetadata,
		...variant,
		properties: Object.fromEntries(
			Object.entries(readProperties(variant)).filter(
				([key]) => !(key in fixedInputs),
			),
		),
		required: readRequired(variant).filter((key) => !(key in fixedInputs)),
	}
}

function describeDeprecatedForward(
	operation: CapabilityApiOperation,
	description: string,
): string {
	const forward = operation.deprecatedForward
	if (!forward) return description
	const replacement = apiOperations.find(
		(candidate) => candidate.operationId === forward.capability,
	)
	if (!replacement) {
		throw new Error(
			`Deprecated Open API operation "${operation.operationId}" has no replacement "${forward.capability}".`,
		)
	}
	const fixedInputDescription = Object.entries(forward.fixedInputs)
		.map(([key, value]) => `${key} "${value}"`)
		.join(', ')
	const fixedInputs = fixedInputDescription
		? ` with ${fixedInputDescription}`
		: ''
	return `Deprecated: use \`${forward.capability}\` (${replacement.method} ${replacement.path})${fixedInputs} instead; this route is removed after ${forward.sunset}.\n\n${description}`
}

export function resolveApiOperation(
	operation: ApiOperation,
	registry: BuiltCapabilityRegistry,
): ResolvedApiOperation {
	switch (operation.kind) {
		case 'native': {
			const definition = nativeApiOperationDefinitions[operation.operationId]
			return {
				operation,
				description: definition.description,
				inputSchema: z.toJSONSchema(definition.inputSchema) as JsonSchema,
				outputSchema: z.toJSONSchema(definition.outputSchema) as JsonSchema,
				permission: operation.permission,
				readOnly: definition.readOnly,
				featureFlag: null,
			}
		}
		case 'capability': {
			const capabilityName = capabilityNameForOperation(operation)
			const capability = registry.capabilityMap[capabilityName]
			if (!capability) {
				throw new Error(
					`Open API operation "${operation.operationId}" has no capability "${capabilityName}".`,
				)
			}
			const forward = operation.deprecatedForward
			const inputSchema = forward
				? narrowForwardSchema(
						capability.inputSchema as JsonSchema,
						forward.fixedInputs,
						operation.operationId,
					)
				: (capability.inputSchema as JsonSchema)
			const outputSchema =
				(capability.outputSchema as JsonSchema | undefined) ?? null
			if (forward && !outputSchema) {
				throw new Error(
					`Deprecated Open API operation "${operation.operationId}" has no output schema.`,
				)
			}
			return {
				operation,
				description: describeDeprecatedForward(
					operation,
					capability.description,
				),
				inputSchema,
				outputSchema: forward
					? narrowForwardSchema(
							outputSchema!,
							forward.fixedInputs,
							operation.operationId,
						)
					: outputSchema,
				permission: forward?.permission ?? capability.orgPermission,
				readOnly: capability.readOnly,
				featureFlag: capability.featureFlag ?? null,
			}
		}
		default: {
			const exhaustive: never = operation
			throw new Error(`Unhandled API operation: ${String(exhaustive)}`)
		}
	}
}

function describeWithPermission(resolved: ResolvedApiOperation) {
	const permission =
		resolved.permission === 'none'
			? 'none (touches no org data)'
			: surfacePermissionList(resolved.permission)
					.map((one) => `\`${one}\``)
					.join(' or ')
	return `${resolved.description}\n\nOrg permission: ${permission}.`
}

function buildGatewayFetchStreamOperation(
	resolved: ResolvedApiOperation,
): OpenApiOperation {
	const { operation } = resolved
	const header = (
		name: string,
		required: boolean,
		description: string,
	): OpenApiParameter => ({
		name,
		in: 'header',
		required,
		description,
		schema: { type: 'string' },
	})
	return {
		operationId: operation.operationId,
		summary: summarize(resolved.description),
		description: describeWithPermission(resolved),
		tags: [operation.tag],
		parameters: [
			header(
				'X-Kody-Gateway-Url',
				true,
				'Absolute outbound URL. May contain literal `{{secret:…}}` / `{{integration-token:…}}` placeholders.',
			),
			header(
				'X-Kody-Gateway-Method',
				false,
				'Outbound HTTP method. Defaults to GET.',
			),
			header(
				'X-Kody-Gateway-Package-Id',
				false,
				'Claimed package stamp. Origin verifies `package:execute` for that id.',
			),
			header(
				'X-Kody-Gateway-Headers',
				false,
				'JSON object of outbound header name → string value. Invalid JSON or non-string values are `400 invalid_request`.',
			),
			header(
				'x-kody-secret-resolution',
				false,
				'`on` (default), `headers-only`, or `off`. Origin strips this header before the request leaves.',
			),
		],
		requestBody: {
			required: false,
			description:
				'Raw outbound fetch body, streamed. No JSON wrapper and no base64. Set `Content-Type` to the outbound value.',
			content: {
				'*/*': {
					schema: { type: 'string', format: 'binary' },
					description: 'Raw outbound bytes (may be multipart).',
				},
			},
		},
		responses: {
			'200': {
				description:
					'Upstream HTTP response: status, headers, and body, streamed. Not a JSON envelope. Upstream 4xx/5xx (including 429) are forwarded as the stream, not the JSON Error envelope.',
				content: {
					'*/*': {
						schema: { type: 'string', format: 'binary' },
						description: 'Upstream response body, streamed.',
					},
				},
			},
			// Origin-side failures before the stream starts (auth, validation).
			// Do not list per-status Error refs: upstream statuses ride the 200 stream.
			default: {
				description:
					'Origin-side failure before the upstream stream starts (auth, validation, etc.). Upstream 4xx/5xx are not this response — they are forwarded on the 200 stream with the upstream status, headers, and body.',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
					},
				},
			},
		},
		security: [{ apiToken: [] }],
		'x-kody-permission': resolved.permission,
		'x-kody-read-only': resolved.readOnly,
	}
}

function buildOperation(
	resolved: ResolvedApiOperation,
	componentSchemas: Record<string, JsonSchema>,
	path: string,
): OpenApiOperation {
	if (isCapabilityProxyGatewayFetchOperation(resolved.operation)) {
		return buildGatewayFetchStreamOperation(resolved)
	}
	const { operation } = resolved
	const inputSchema = hoistDefs(
		resolved.inputSchema,
		`${operation.operationId}Input`,
		componentSchemas,
	)
	const properties = readProperties(inputSchema)
	const required = new Set(readRequired(inputSchema))
	const pathParams = getApiOperationPathParams(path)
	const omitted = new Set(
		operation.kind === 'capability' ? (operation.omitInputs ?? []) : [],
	)
	const parameters: Array<OpenApiParameter> = pathParams.map((name) => {
		const schema = properties[name] ?? { type: 'string' }
		return {
			name,
			in: 'path',
			required: true,
			...(typeof schema['description'] === 'string'
				? { description: schema['description'] }
				: {}),
			schema,
		}
	})
	const bodyEntries = Object.entries(properties).filter(
		([name]) => !pathParams.includes(name) && !omitted.has(name),
	)
	let requestBody: OpenApiOperation['requestBody']
	if (apiOperationUsesQueryInputs(operation.method)) {
		for (const [name, schema] of bodyEntries) {
			parameters.push({
				name,
				in: 'query',
				required: required.has(name),
				...(typeof schema['description'] === 'string'
					? { description: schema['description'] }
					: {}),
				schema,
				...(schema['type'] === 'array'
					? { style: 'form' as const, explode: true }
					: {}),
			})
		}
	} else {
		const unionVariants = readUnionVariants(inputSchema)
		if (unionVariants.length > 0) {
			// Preserve anyOf/oneOf as-is. Body is required when every variant
			// requires at least one non-path body field (e.g. package-graph
			// code|imports).
			const everyVariantRequiresBody = unionVariants.every((variant) =>
				readRequired(variant).some(
					(name) => !pathParams.includes(name) && !omitted.has(name),
				),
			)
			requestBody = {
				required: everyVariantRequiresBody,
				content: {
					'application/json': {
						schema: inputSchema,
					},
				},
			}
		} else {
			const bodyRequired = readRequired(inputSchema).filter(
				(name) => !pathParams.includes(name) && !omitted.has(name),
			)
			const {
				required: _required,
				properties: _properties,
				...rest
			} = inputSchema
			requestBody = {
				required: bodyRequired.length > 0,
				content: {
					'application/json': {
						schema: {
							...rest,
							type: 'object',
							properties: Object.fromEntries(bodyEntries),
							...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
						},
					},
				},
			}
		}
	}
	const outputSchema = resolved.outputSchema
		? hoistDefs(
				resolved.outputSchema,
				`${operation.operationId}Output`,
				componentSchemas,
			)
		: {}
	return {
		operationId: operation.operationId,
		summary: summarize(resolved.description),
		description: describeWithPermission(resolved),
		...(operation.kind === 'capability' && operation.deprecatedForward
			? { deprecated: true }
			: {}),
		tags: [operation.tag],
		...(parameters.length > 0 ? { parameters } : {}),
		...(requestBody ? { requestBody } : {}),
		responses: {
			'200': {
				description: 'Success.',
				content: { 'application/json': { schema: outputSchema } },
			},
			...documentedErrorResponses(),
		},
		security: [{ apiToken: [] }],
		'x-kody-permission': resolved.permission,
		'x-kody-read-only': resolved.readOnly,
		...(resolved.featureFlag
			? { 'x-kody-feature-flag': resolved.featureFlag }
			: {}),
	}
}

function buildDocumentBody(registry: BuiltCapabilityRegistry) {
	const componentSchemas: Record<string, JsonSchema> = {
		Error: {
			type: 'object',
			required: ['error'],
			properties: {
				error: {
					type: 'object',
					required: ['code', 'message'],
					properties: {
						code: { type: 'string', enum: [...apiErrorCodes] },
						message: { type: 'string' },
						details: {},
					},
				},
			},
		},
	}
	const paths: OpenApiDocument['paths'] = {}
	for (const operation of apiOperations) {
		const resolved = resolveApiOperation(operation, registry)
		for (const path of listApiOperationPaths(operation)) {
			const pathItem = (paths[path] ??= {})
			const built = buildOperation(resolved, componentSchemas, path)
			// Aliases keep a distinct operationId (OpenAPI uniqueness) while
			// HTTP still dispatches to the same capability.
			if (path !== operation.path) {
				built.operationId = `${operation.operationId}ByPath`
			}
			pathItem[operation.method.toLowerCase()] = built
		}
	}
	const scopeList = apiTokenScopes
		.map((scope) => `- \`${scope}\`: ${apiTokenScopeDescriptions[scope]}`)
		.join('\n')
	return {
		openapi: openApiVersion,
		info: {
			title: 'Kody API',
			version: kodyApiVersion,
			description: [
				'HTTP API for a Kody account. Versioned under `/v1`; changes within v1 are additive. See https://kody.codes/docs/api-versioning.md for deprecation windows and migration policy (we do not break users; phased migration with codemods when needed).',
				'',
				'Authenticate with `Authorization: Bearer kody_at_…`. Tokens are minted by the MCP `api` tool (`tokenCreate`) or by another token, and each carries explicit org-permission scopes. There is no write-implies-read hierarchy.',
				apiTokenIdleTtlDescription(),
				'',
				'Errors use `{ "error": { "code", "message", "details"? } }` (see components.schemas.Error). Documented 4xx/5xx responses reference that schema. Requests are rate limited per IP (600/min) and per token (300/min); HTTP 429 includes `Retry-After`. Edge-generated 429 responses also include a `RateLimit-Policy` advertisement; entitlement 429s send `Retry-After` only.',
				'',
				'`operationId` values match Kody capability names, except deprecated forwarders, which keep their old ids and forward to the capability their description names. Every id, deprecated ones included, works with the MCP `api` tool (`{ operationId, params }`, where params hold path, query, and body fields flat).',
				'',
				`Interactive docs: ${kodyApiDocsUrl}`,
				'',
				'Scopes:',
				scopeList,
			].join('\n'),
		},
		externalDocs: {
			description: 'Interactive Kody API docs (Scalar)',
			url: kodyApiDocsUrl,
		},
		tags: Object.entries(tagDescriptions).map(([name, description]) => ({
			name,
			description,
		})),
		security: [{ apiToken: [] }],
		paths,
		components: {
			schemas: componentSchemas,
			responses: {
				Error: {
					description:
						'Error envelope `{ "error": { "code", "message", "details"? } }`.',
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/Error' },
						},
					},
				},
				RateLimited: {
					description:
						'Too many requests (edge IP/token limit) or an entitlement / plan-cap limit. Wait at least `Retry-After` seconds before retrying.',
					headers: {
						'Retry-After': {
							description: 'Seconds to wait before retrying.',
							schema: { type: 'integer', minimum: 1 },
						},
						'RateLimit-Policy': {
							description:
								'Edge-generated 429s only: advertised policies (`ip` 600/min, `token` 300/min). Remaining counts are not exposed. Entitlement 429s omit this header.',
							schema: { type: 'string' },
						},
					},
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/Error' },
						},
					},
				},
			},
			securitySchemes: {
				apiToken: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'kody_at_<id>_<secret>',
					description:
						'Scoped Kody API token. Each operation lists its required org permission in `x-kody-permission`. Credential scopes narrow that permission.',
				},
			},
		},
	} satisfies Omit<OpenApiDocument, 'servers'>
}

let documentBodyMemo: Promise<Omit<OpenApiDocument, 'servers'>> | null = null

/** The OpenAPI document, built once per isolate. */
export async function buildOpenApiDocument(input: {
	serverUrl: string
}): Promise<OpenApiDocument> {
	documentBodyMemo ??= getStaticRegistry()
		.then((registry) => buildDocumentBody(registry))
		.catch((error: unknown) => {
			documentBodyMemo = null
			throw error
		})
	const body = await documentBodyMemo
	return { ...body, servers: [{ url: input.serverUrl }] }
}
