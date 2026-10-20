import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { communityPackageCategories } from '#universal/community-categories.ts'
import { type ForkListingRelation } from '#universal/community-listing-ahead.ts'
import { credentialFillPlacementViewSchema } from '#universal/credential-fill-placement.ts'

export const kodyPackageIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const packageJobScheduleSchema = z.union([
	z.object({
		type: z.literal('cron'),
		expression: z.string().min(1),
	}),
	z.object({
		type: z.literal('interval'),
		every: z.string().min(1),
	}),
	z.object({
		type: z.literal('once'),
		runAt: z.string().min(1),
	}),
])

export type PackageJobSchedule = z.infer<typeof packageJobScheduleSchema>

export const packageJobDefinitionSchema = z.object({
	entry: z.string().min(1),
	schedule: packageJobScheduleSchema,
	timezone: z.string().min(1).optional(),
	enabled: z.boolean().optional(),
})

export type PackageJobDefinition = z.infer<typeof packageJobDefinitionSchema>

/**
 * A bare package specifier the browser bundle leaves as an `import` for the
 * page's import map to resolve (for example `lit`). Relative
 * paths, URLs, and Worker-only schemes are not externals: the first two need
 * no declaration and the last never belong in a browser graph.
 */
export const packageAppClientExternalSchema = z
	.string()
	.trim()
	.min(1)
	.refine(
		(specifier) =>
			!specifier.startsWith('.') &&
			!specifier.startsWith('/') &&
			!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier),
		{
			message:
				'kody.app.client.externals entries must be bare package specifiers such as "lit" or "preact/hooks" (no relative paths, URLs, or kody:/cloudflare:/node: schemes).',
		},
	)

export const packageAppClientDefinitionSchema = z.object({
	/** Browser entry (`.ts`/`.tsx`/`.js`/`.jsx`). */
	entry: z.string().trim().min(1),
	/**
	 * Bare specifiers kept as external `import`s in the bundled module so an
	 * import map on the page resolves them. Matches the specifier and its
	 * subpaths (`preact` also covers `preact/hooks`).
	 */
	externals: z.array(packageAppClientExternalSchema).optional(),
})

export type PackageAppClientDefinition = z.infer<
	typeof packageAppClientDefinitionSchema
>

export const packageAppDefinitionSchema = z.object({
	/**
	 * Server entry bundled for the package-app isolate. The default export
	 * is a fetch handler (a function, `{ fetch }`, or a named `fetch`
	 * export). The host strips the app mount before forwarding, so every
	 * entry sees `/notes` for `/packages/<id>/notes`.
	 */
	entry: z.string().trim().min(1),
	/**
	 * Browser entry the platform bundles to a fingerprinted ESM module served
	 * under `<appBasePath>/_assets/`. A path string, or an object when the
	 * client needs `externals` for an import map.
	 */
	client: z
		.union([z.string().trim().min(1), packageAppClientDefinitionSchema])
		.optional(),
	/**
	 * Directory of static files served as-is under `<appBasePath>/_assets/`
	 * (no bundling; content types inferred from the extension).
	 */
	assets: z.string().trim().min(1).optional(),
})

export type PackageAppDefinition = z.infer<typeof packageAppDefinitionSchema>

export const packageSecretMountDefinitionSchema = z.object({
	name: z.string().min(1),
	scope: z.enum(['user', 'package', 'session']).optional(),
})

export const packageSecretProviderIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const packageSecretProviderSchema = z.object({
	id: z.string().regex(packageSecretProviderIdPattern),
})

export type PackageSecretMountDefinition = z.infer<
	typeof packageSecretMountDefinitionSchema
>

export const packageCredentialKindValues = [
	'secret',
	'oauth',
	'mcp',
	'url',
	'login',
	'signing',
] as const
export type PackageCredentialKind = (typeof packageCredentialKindValues)[number]

/**
 * Slot names land inside `{{secret:NAME}}`-style placeholders, so they use the
 * placeholder name characters. `@` and `/` stay out: `@me/NAME` and
 * `{{secret/provider:ref}}` are reference grammar, not names.
 */
export const packageCredentialSlotNamePattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

export const ownerCredentialForVisitorsValueMessage =
	'kody.credentials ownerCredentialForVisitors takes only true. Omit it to keep app visitors from using the owner’s credential.'

/**
 * Kinds that satisfy a need with no declared `kind`: any fetch-capable
 * credential for the provider (ADR 0068 amendment 2026-10-12).
 */
export const fetchCapableCredentialKindValues = [
	'secret',
	'oauth',
	'login',
] as const satisfies ReadonlyArray<PackageCredentialKind>
export type FetchCapableCredentialKind =
	(typeof fetchCapableCredentialKindValues)[number]

export function isFetchCapableCredentialKind(
	kind: string,
): kind is FetchCapableCredentialKind {
	return (fetchCapableCredentialKindValues as ReadonlyArray<string>).includes(
		kind,
	)
}

export const packageCredentialSlotSchema = z.strictObject({
	/**
	 * Optional. Omit for any fetch-capable credential for the provider
	 * (secret/Key, oauth, login). Declare only when a specific shape is needed
	 * (`signing`, `mcp`, `url`, or a provider that truly requires one kind).
	 */
	kind: z.enum(packageCredentialKindValues).optional(),
	/**
	 * Provider slug a credential must carry to auto-resolve for this need
	 * (for example `github`). Defaults to the key.
	 */
	provider: z.string().trim().min(1).max(64).optional(),
	/** `credentials(key)` returns the caller's picks as an array. */
	multiple: z.boolean().optional(),
	/** Shown to callers choosing a credential for this need. */
	description: z.string().trim().min(1).max(500),
	/**
	 * Opt-in, per credential: on an internet-visible app, this need resolves
	 * with the credentials of the owner who approved the app for visitors,
	 * so signed-out visitors and people signed in as someone else can use it.
	 * The owner approves it on the capability approval page.
	 */
	ownerCredentialForVisitors: z
		.literal(true, { error: ownerCredentialForVisitorsValueMessage })
		.optional(),
	/**
	 * Optional fill placement for package-scope secrets this need names.
	 * Applied on Connect / secretSet insert (and re-insert after Disconnect)
	 * instead of the headers-only default. Reviewable at publish; package
	 * runtimes cannot set placement themselves. Distinct from inject.
	 */
	placement: credentialFillPlacementViewSchema.optional(),
})

export type PackageCredentialSlot = z.infer<typeof packageCredentialSlotSchema>

export const packageCredentialsSchema = z
	.record(z.string(), packageCredentialSlotSchema)
	.superRefine((slots, ctx) => {
		for (const name of Object.keys(slots)) {
			if (packageCredentialSlotNamePattern.test(name)) continue
			ctx.addIssue({
				code: 'custom',
				path: [name],
				message:
					'Credential slot names start with a letter and use letters, numbers, dots, underscores, or hyphens (max 64).',
			})
		}
	})

export const packageSubscriptionDefinitionSchema = z.object({
	handler: z.string().min(1),
	description: z.string().min(1).optional(),
	filters: z.record(z.string().min(1), z.unknown()).optional(),
})

export type PackageSubscriptionDefinition = z.infer<
	typeof packageSubscriptionDefinitionSchema
>

/** RFC 9110 token characters for HTTP field names. */
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export const webhookSignedPayloadValues = ['body', 'timestamp.body'] as const
export type WebhookSignedPayload = (typeof webhookSignedPayloadValues)[number]

export const webhookTimestampFormatValues = [
	'unix-seconds',
	'unix-millis',
	'iso-8601',
	'stripe-signature',
] as const
export type WebhookTimestampFormat =
	(typeof webhookTimestampFormatValues)[number]

export const packageWebhookHmacVerificationSchema = z.object({
	type: z.enum(['hmac-sha256', 'hmac-sha1']),
	header: z.string().regex(httpFieldNamePattern),
	/**
	 * Optional. Omit for package-owned HMAC (minted onto the webhook URL
	 * record). Set only for provider-issued signing secrets that live in the
	 * secret store (for example Sentry). GitHub-style hooks that register via
	 * webhookUrlApply with {{webhookSecret}} should omit this.
	 */
	secretName: z.string().min(1).optional(),
	encoding: z.enum(['hex', 'base64']),
	prefix: z.string().optional(),
	signedPayload: z.enum(webhookSignedPayloadValues).optional(),
})

/**
 * For senders that cannot sign: the minted URL's secret path segment is the
 * only credential. A webhook that declares an HMAC type never falls back to
 * this; requests without a valid signature are refused.
 */
export const packageWebhookUrlSecretVerificationSchema = z.object({
	type: z.literal('url-secret'),
})

export const packageWebhookVerificationSchema = z.discriminatedUnion('type', [
	packageWebhookHmacVerificationSchema,
	packageWebhookUrlSecretVerificationSchema,
])

export type PackageWebhookHmacVerification = z.infer<
	typeof packageWebhookHmacVerificationSchema
>

export type PackageWebhookVerification = z.infer<
	typeof packageWebhookVerificationSchema
>

/**
 * Platform-handled ownership quizzes on the minted webhook URL. Challenge
 * requests never invoke package code: the worker answers from query/body +
 * optional named secret only.
 *
 * Only `subscription-challenge` (generic knobs) is supported. Do not add
 * vendor-named type ids (see decision 0054); configure providers with
 * documented presets under this type.
 */
export const webhookChallengeTypeValues = ['subscription-challenge'] as const
export type WebhookChallengeType = (typeof webhookChallengeTypeValues)[number]

const webhookChallengeParamKeySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(
		/^(?!__proto__$|prototype$|constructor$)[A-Za-z0-9][A-Za-z0-9._-]*$/,
		'Challenge keys must be alphanumeric (with . _ -) and must not be prototype property names.',
	)

const webhookChallengeWhenValueSchema = z.union([
	z.string().min(1),
	z.array(z.string().min(1)).min(1),
])

export const packageWebhookSubscriptionChallengeSchema = z.object({
	type: z.literal('subscription-challenge'),
	method: z.enum(['GET', 'POST']),
	/** Where the challenge token arrives. */
	challenge: z.object({
		in: z.enum(['query', 'json']),
		key: webhookChallengeParamKeySchema,
	}),
	/**
	 * Recognition filters. On GET, a mismatch is 400. On POST, a mismatch
	 * means the request is not a quiz (fall through to delivery).
	 */
	when: z
		.object({
			query: z
				.record(z.string().min(1), webhookChallengeWhenValueSchema)
				.optional(),
			json: z.record(z.string().min(1), z.string().min(1)).optional(),
		})
		.optional(),
	/**
	 * How the subscriber proves ownership. Omit or `{ kind: "none" }` for
	 * an unauthenticated echo (for example WebSub without verify_token).
	 */
	prove: z
		.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('none'),
			}),
			z.object({
				kind: z.literal('verify-token'),
				in: z.literal('query'),
				key: webhookChallengeParamKeySchema,
				secretName: z.string().min(1),
				/** Default true. When false, missing/empty tokens are allowed. */
				required: z.boolean().optional(),
			}),
			z.object({
				kind: z.literal('hmac'),
				secretName: z.string().min(1),
				algorithm: z.enum(['hmac-sha256']),
				encoding: z.enum(['hex', 'base64']),
				prefix: z.string().optional(),
			}),
			z.object({
				kind: z.literal('request-hmac'),
				secretName: z.string().min(1),
				algorithm: z.enum(['hmac-sha256']),
				encoding: z.enum(['hex', 'base64']),
				prefix: z.string().optional(),
				timestampHeader: z.string().regex(httpFieldNamePattern),
				signatureHeader: z.string().regex(httpFieldNamePattern),
				signedPayload: z.literal('v0.timestamp.body'),
			}),
		])
		.optional(),
	/** How a successful quiz is echoed back to the provider. */
	respond: z.discriminatedUnion('as', [
		z.object({ as: z.literal('text') }),
		z.object({
			as: z.literal('json'),
			key: webhookChallengeParamKeySchema,
		}),
		z.object({
			as: z.literal('json-hmac'),
			key: webhookChallengeParamKeySchema,
		}),
	]),
})

export type PackageWebhookSubscriptionChallenge = z.infer<
	typeof packageWebhookSubscriptionChallengeSchema
>

export const packageWebhookChallengeSchema =
	packageWebhookSubscriptionChallengeSchema.superRefine((challenge, ctx) => {
		if (challenge.method === 'GET' && challenge.challenge.in !== 'query') {
			ctx.addIssue({
				code: 'custom',
				path: ['challenge', 'in'],
				message: 'GET subscription challenges must read challenge.in=query.',
			})
		}
		if (challenge.method === 'POST' && challenge.challenge.in !== 'json') {
			ctx.addIssue({
				code: 'custom',
				path: ['challenge', 'in'],
				message: 'POST subscription challenges must read challenge.in=json.',
			})
		}
		if (challenge.method === 'POST') {
			const hasJsonWhen =
				challenge.when?.json != null &&
				Object.keys(challenge.when.json).length > 0
			if (!hasJsonWhen) {
				ctx.addIssue({
					code: 'custom',
					path: ['when', 'json'],
					message:
						'POST subscription challenges require when.json so ordinary event POSTs can fall through to delivery.',
				})
			}
		}
		if (
			challenge.respond.as === 'json-hmac' &&
			challenge.prove?.kind !== 'hmac'
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['respond', 'as'],
				message:
					'respond.as=json-hmac requires prove.kind=hmac (CRC-style answer).',
			})
		}
		if (
			challenge.prove?.kind === 'hmac' &&
			challenge.respond.as !== 'json-hmac'
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['respond', 'as'],
				message: 'prove.kind=hmac requires respond.as=json-hmac.',
			})
		}
	})

export type PackageWebhookChallenge = z.infer<
	typeof packageWebhookChallengeSchema
>

/** Secret name used by a challenge declaration's prove block, if any. */
export function webhookChallengeSecretName(
	challenge: PackageWebhookChallenge,
): string | undefined {
	const prove = challenge.prove
	if (!prove || prove.kind === 'none') return undefined
	return prove.secretName
}

const webhookTimestampFormatSchema = z.string().superRefine((value, ctx) => {
	if (
		!(webhookTimestampFormatValues as ReadonlyArray<string>).includes(value)
	) {
		ctx.addIssue({
			code: 'custom',
			message: `Unknown webhook replay timestampFormat "${value}". Expected one of: ${webhookTimestampFormatValues.join(', ')}.`,
		})
	}
}) as z.ZodType<WebhookTimestampFormat>

export const packageWebhookReplaySchema = z
	.object({
		timestampHeader: z.string().regex(httpFieldNamePattern).optional(),
		timestampFormat: webhookTimestampFormatSchema.optional(),
		toleranceSeconds: z.number().int().positive().max(86_400).optional(),
		deliveryIdHeader: z.string().regex(httpFieldNamePattern).optional(),
	})
	.superRefine((replay, ctx) => {
		if (replay.timestampHeader && replay.timestampFormat === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['timestampFormat'],
				message:
					'replay.timestampFormat is required when timestampHeader is set.',
			})
		}
		if (replay.timestampFormat !== undefined && !replay.timestampHeader) {
			ctx.addIssue({
				code: 'custom',
				path: ['timestampHeader'],
				message:
					'replay.timestampHeader is required when timestampFormat is set.',
			})
		}
	})

export type PackageWebhookReplay = z.infer<typeof packageWebhookReplaySchema>

export const webhookInputModeValues = ['request', 'params'] as const
export type WebhookInputMode = (typeof webhookInputModeValues)[number]

export const webhookDefaultRateLimitPerMinute = 60
export const webhookMaxRateLimitPerMinute = 600

export const packageWebhookDefinitionSchema = z
	.object({
		name: z.string().regex(kodyPackageIdPattern),
		export: z.string().min(1),
		description: z.string().min(1).optional(),
		responseMode: z.enum(['ack', 'sync']).optional(),
		inputMode: z.enum(webhookInputModeValues).optional(),
		rateLimitPerMinute: z
			.number()
			.int()
			.min(1)
			.max(webhookMaxRateLimitPerMinute)
			.optional(),
		verification: packageWebhookVerificationSchema.optional(),
		replay: packageWebhookReplaySchema.optional(),
		challenge: packageWebhookChallengeSchema.optional(),
	})
	.superRefine((webhook, ctx) => {
		if (
			webhook.verification?.type !== 'url-secret' &&
			webhook.verification?.signedPayload === 'timestamp.body' &&
			!webhook.replay?.timestampHeader
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['verification', 'signedPayload'],
				message:
					'verification.signedPayload "timestamp.body" requires replay.timestampHeader.',
			})
		}
	})

export type PackageWebhookDefinition = z.infer<
	typeof packageWebhookDefinitionSchema
>

const packageWebhooksSchema = z
	.array(packageWebhookDefinitionSchema)
	.superRefine((webhooks, ctx) => {
		const seen = new Set<string>()
		for (const [index, webhook] of webhooks.entries()) {
			if (seen.has(webhook.name)) {
				ctx.addIssue({
					code: 'custom',
					path: [index, 'name'],
					message: `Duplicate webhook name "${webhook.name}". Webhook names must be unique within a package.`,
				})
			}
			seen.add(webhook.name)
		}
	})

export const packageEmittedEventDefinitionSchema = z.object({
	description: z.string().min(1),
	// JSON Schema subset for dispatch-time payload validation; the supported
	// keyword set is enforced in parseAuthoredPackageJson (manifest.ts) so
	// schema problems surface as publish-time manifest errors.
	payloadSchema: z.record(z.string(), z.unknown()).optional(),
	// Opt-in exposure through the MCP Events extension (events/list,
	// events/subscribe). Absent or false keeps the topic package-internal.
	mcp: z.boolean().optional(),
})

export type PackageEmittedEventDefinition = z.infer<
	typeof packageEmittedEventDefinitionSchema
>

export const packageRetrieverScopeValues = ['search', 'context'] as const
export type PackageRetrieverScope = (typeof packageRetrieverScopeValues)[number]

export const packageRetrieverDefinitionSchema = z.object({
	export: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	scopes: z
		.array(z.enum(packageRetrieverScopeValues))
		.min(1)
		.max(packageRetrieverScopeValues.length),
	timeoutMs: z.number().int().positive().max(5_000).optional(),
	maxResults: z.number().int().positive().max(20).optional(),
})

export type PackageRetrieverDefinition = z.infer<
	typeof packageRetrieverDefinitionSchema
>

const packageExportConditionSchema = z
	.object({
		import: z.string().min(1).optional(),
		default: z.string().min(1).optional(),
		types: z.string().min(1).optional(),
	})
	.refine(
		(value) =>
			value.import !== undefined ||
			value.default !== undefined ||
			value.types !== undefined,
		{
			message:
				'Package export condition objects must define at least one of `import`, `default`, or `types`.',
		},
	)

export const packageExportTargetSchema = z.union([
	z.string().min(1),
	packageExportConditionSchema,
])

export type PackageExportTarget = z.infer<typeof packageExportTargetSchema>

const scopedPackageNamePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/

export const kodyPackageDependencySchema = z
	.string()
	.min(1)
	.regex(scopedPackageNamePattern, {
		message:
			'Static Kody package dependencies must be scoped package names like "@scope/package".',
	})

export const kodyPackageDependencyWildcard = '*' as const

export type KodyPackageDependencyWildcard = typeof kodyPackageDependencyWildcard

export type KodyPackageDependencies = Record<
	string,
	KodyPackageDependencyWildcard
>

export type KodyPackageDependency = z.infer<typeof kodyPackageDependencySchema>

export function listKodyPackageDependencyNames(
	dependencies:
		| KodyPackageDependencies
		| ReadonlyArray<unknown>
		| Record<string, string>
		| null
		| undefined,
): Array<string> {
	if (dependencies == null) return []
	const names = Array.isArray(dependencies)
		? dependencies.filter((name): name is string => typeof name === 'string')
		: Object.keys(dependencies)
	return Array.from(
		new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
	).sort((left, right) => left.localeCompare(right))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

const kodyPackageDependenciesSchema = z
	.unknown()
	.superRefine((value, ctx) => {
		if (value === undefined) return
		if (Array.isArray(value) || !isPlainObject(value)) {
			ctx.addIssue({
				code: 'custom',
				message: 'kody.dependencies must be a map of "@scope/package": "*".',
				fatal: true,
			})
			return
		}
		for (const [name, version] of Object.entries(value)) {
			if (!kodyPackageDependencySchema.safeParse(name).success) {
				ctx.addIssue({
					code: 'custom',
					path: [name],
					message:
						'Static Kody package dependencies must be scoped package names like "@scope/package".',
				})
			}
			if (version !== kodyPackageDependencyWildcard) {
				ctx.addIssue({
					code: 'custom',
					path: [name],
					message:
						'must be "*" (latest published commit, captured when this package publishes).',
				})
			}
		}
	})
	.transform((value): KodyPackageDependencies | undefined => {
		if (value === undefined || !isPlainObject(value)) return undefined
		return Object.fromEntries(
			listKodyPackageDependencyNames(value as Record<string, string>).map(
				(name) => [name, kodyPackageDependencyWildcard],
			),
		)
	})

/** Soft cap for new/updated `kody.description` taglines on write/publish only. */
export const KODY_DESCRIPTION_MAX_LENGTH = 200

/**
 * Stable phrase used to recognize oversized taglines after the Error leaves
 * `package-registry` (no MCP types here). `isKodyDescriptionLengthMessage`
 * and MCP observability depend on it. KODY-7S.
 */
const kodyDescriptionTooLongPhrase = `must be at most ${KODY_DESCRIPTION_MAX_LENGTH} characters (short public tagline)`

export function kodyDescriptionTooLongMessage() {
	return `kody.description ${kodyDescriptionTooLongPhrase}.`
}

export function isKodyDescriptionLengthMessage(message: string) {
	return message.includes(kodyDescriptionTooLongPhrase)
}

export function assertKodyDescriptionLength(description: string) {
	if (description.length > KODY_DESCRIPTION_MAX_LENGTH) {
		throw new Error(kodyDescriptionTooLongMessage())
	}
}

export const authoredPackageKodySchema = z.object({
	id: z.string().regex(kodyPackageIdPattern).optional(),
	// No max here: this schema is shared by load/parse. Enforce
	// KODY_DESCRIPTION_MAX_LENGTH only at write/publish boundaries via
	// assertKodyDescriptionLength so existing longer descriptions still load.
	description: z.string().min(1),
	tags: z.array(z.string().min(1)).optional(),
	category: z.enum(communityPackageCategories).optional(),
	searchText: z.string().min(1).optional(),
	dependencies: kodyPackageDependenciesSchema.optional(),
	credentials: packageCredentialsSchema.optional(),
	secretMounts: z
		.record(z.string().min(1), packageSecretMountDefinitionSchema)
		.optional(),
	secretProvider: packageSecretProviderSchema.optional(),
	subscriptions: z
		.record(z.string().min(1), packageSubscriptionDefinitionSchema)
		.optional(),
	emits: z
		.record(z.string().min(1), packageEmittedEventDefinitionSchema)
		.optional(),
	app: packageAppDefinitionSchema.optional(),
	jobs: z.record(z.string().min(1), packageJobDefinitionSchema).optional(),
	retrievers: z
		.record(
			z.string().regex(kodyPackageIdPattern),
			packageRetrieverDefinitionSchema,
		)
		.optional(),
	webhooks: packageWebhooksSchema.optional(),
})

export type AuthoredPackageKody = Omit<
	z.infer<typeof authoredPackageKodySchema>,
	'id'
> & {
	id: string
	/**
	 * Published snapshot load only: `kody.credentials` slots that fail today's
	 * slot schema, by name, with the validation message. They are left out of
	 * `credentials` and every use of one fails with this message. Never read
	 * from package.json.
	 */
	invalidCredentialSlots?: Record<string, string>
}

export const authoredPackageJsonSchema = z.object({
	name: z.string().min(1),
	private: z.boolean().optional(),
	exports: z.record(z.string().min(1), packageExportTargetSchema),
	kody: authoredPackageKodySchema,
})

export type AuthoredPackageJson = Omit<
	z.infer<typeof authoredPackageJsonSchema>,
	'kody'
> & {
	kody: AuthoredPackageKody
}

export type SavedPackageRow = {
	id: string
	user_id: OwnerId
	name: string
	kody_id: string
	description: string
	tags_json: string
	search_text: string | null
	source_id: string
	has_app: 0 | 1
	has_skills: 0 | 1
	hidden: 0 | 1
	is_private: 0 | 1
	/** Anonymous public app serving. Independent of forkable (`is_private`). */
	is_internet_visible: 0 | 1
	locked_at: string | null
	created_at: string
	updated_at: string
}

export type SavedPackageRecord = {
	id: string
	userId: OwnerId
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	searchText: string | null
	sourceId: string
	hasApp: boolean
	hasSkills: boolean
	hidden: boolean
	isPrivate: boolean
	/**
	 * When true, the package app may be served on the public internet after
	 * capability approval. Independent of `isPrivate` (forkable/public source).
	 */
	isInternetVisible: boolean
	lockedAt: string | null
	createdAt: string
	updatedAt: string
}

export type SavedPackageCommunityProvenance = {
	sourceListingId: string | null
	listingCurrent: boolean | null
	listingKodyId: string | null
	listingName: string | null
	originCommit: string | null
	listingPinnedCommit: string | null
	listingPublishedAt: string | null
	listingAhead: boolean | null
	forkListingRelation: ForkListingRelation | null
}

export type SavedPackageWithCommunityProvenanceRecord = SavedPackageRecord &
	SavedPackageCommunityProvenance
