import {
	createSchema,
	fail,
	object,
	string,
	type InferOutput,
} from 'remix/data-schema'

const d1DatabaseSchema = createSchema<unknown, D1Database>((value, context) => {
	if (value) {
		return { value: value as D1Database }
	}
	return fail('Missing APP_DB binding for database access.', context.path)
})

function requiredDurableObjectNamespaceSchema(message: string) {
	return createSchema<unknown, DurableObjectNamespace>((value, context) => {
		if (value) {
			return { value: value as DurableObjectNamespace }
		}
		return fail(message, context.path)
	})
}

const optionalSendEmailSchema = createSchema<unknown, SendEmail | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as SendEmail }
	},
)

const optionalAnalyticsEngineDatasetSchema = createSchema<
	unknown,
	AnalyticsEngineDataset | undefined
>((value, _context) => {
	if (value === undefined) return { value: undefined }
	return { value: value as AnalyticsEngineDataset }
})

const optionalAiSchema = createSchema<unknown, Ai | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Ai }
	},
)

const optionalArtifactsSchema = createSchema<unknown, Artifacts | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Artifacts }
	},
)

// Service binding to the package runtime Worker (`kody-runtime`). Present in
// production/preview and multi-worker local dev; absent in tests and
// single-worker dev, where the main Worker serves the runtime lane itself.
const optionalFetcherSchema = createSchema<unknown, Fetcher | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Fetcher }
	},
)

const optionalNonEmptyStringSchema = createSchema<unknown, string | undefined>(
	(value, context) => {
		if (value === undefined) return { value: undefined }
		if (typeof value !== 'string') return fail('Expected string', context.path)

		const trimmed = value.trim()
		return { value: trimmed.length > 0 ? trimmed : undefined }
	},
)

const optionalUrlStringSchema = createSchema<unknown, string | undefined>(
	(value, context) => {
		if (value === undefined) return { value: undefined }
		if (typeof value !== 'string') return fail('Expected string', context.path)

		const trimmed = value.trim()
		if (!trimmed) return { value: undefined }

		try {
			new URL(trimmed)
			return { value: trimmed }
		} catch {
			return fail('Expected valid URL', context.path)
		}
	},
)

const optionalCommitShaSchema = createSchema<unknown, string | undefined>(
	(value, context) => {
		if (value === undefined) return { value: undefined }
		if (typeof value !== 'string') return fail('Expected string', context.path)

		const trimmed = value.trim()
		if (!trimmed) return { value: undefined }
		if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) {
			return fail(
				'Expected commit SHA (7-40 hexadecimal characters)',
				context.path,
			)
		}

		return { value: trimmed.toLowerCase() }
	},
)

const optionalSentryTracesSampleRateSchema = createSchema<
	unknown,
	number | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			return fail(
				'SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1',
				context.path,
			)
		}
		return { value }
	}
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (!trimmed) return { value: undefined }
		const n = Number.parseFloat(trimmed)
		if (!Number.isFinite(n) || n < 0 || n > 1) {
			return fail(
				'SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1',
				context.path,
			)
		}
		return { value: n }
	}
	return fail('Expected number or numeric string', context.path)
})

const optionalPackageAppTicketKeysSchema = createSchema<
	unknown,
	string | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (typeof value !== 'string') return fail('Expected string', context.path)
	const keys = value
		.split(',')
		.map((key) => key.trim())
		.filter((key) => key.length > 0)
	if (keys.length === 0) return { value: undefined }
	if (keys.some((key) => key.length < 32)) {
		return fail(
			'Every PACKAGE_APP_TICKET_KEYS entry must be at least 32 characters.',
			context.path,
		)
	}
	return { value: keys.join(',') }
})

const optionalPositivePercentSchema = createSchema<
	unknown,
	number | string | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (typeof value === 'string' && !value.trim()) return { value: undefined }
	if (typeof value !== 'number' && typeof value !== 'string') {
		return fail('Expected number or numeric string', context.path)
	}
	const n = typeof value === 'number' ? value : Number(value.trim())
	if (!Number.isFinite(n) || n <= 0) {
		return fail('Expected a positive percent', context.path)
	}
	return { value }
})

const secretStoreKeySchema = createSchema<unknown, string>((value, context) => {
	if (typeof value !== 'string') {
		return fail(
			'Missing SECRET_STORE_KEY binding for saved secret encryption.',
			context.path,
		)
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return fail(
			'Missing SECRET_STORE_KEY binding for saved secret encryption.',
			context.path,
		)
	}
	if (trimmed.length < 32) {
		return fail(
			'SECRET_STORE_KEY must be at least 32 characters for secure key derivation.',
			context.path,
		)
	}
	return { value: trimmed }
})

export const EnvSchema = object({
	COOKIE_SECRET: string().refine(
		(value) => value.length >= 32,
		'COOKIE_SECRET must be at least 32 characters for session signing.',
	),
	SECRET_STORE_KEY: secretStoreKeySchema,
	APP_DB: d1DatabaseSchema,
	BUNDLE_ARTIFACTS_KV: createSchema<unknown, KVNamespace>((value, context) => {
		if (value) {
			return { value: value as KVNamespace }
		}
		return fail(
			'Missing BUNDLE_ARTIFACTS_KV binding for published runtime artifacts.',
			context.path,
		)
	}),
	// Jobs worker service binding (ADR 0016). Optional: tests and local
	// single-worker dev fall back to jobs tables in APP_DB and skip
	// JobManager alarm scheduling.
	JOBS: createSchema<unknown, Fetcher | undefined>((value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Fetcher }
	}),
	// Highlight worker service binding. Optional: tests and single-worker
	// local fallback to plaintext tokens when the binding is absent.
	HIGHLIGHT: optionalFetcherSchema,
	// Repo push queue worker (`kody-push-queue`). Optional: tests and local
	// single-worker dev keep the isolate-local receive-pack wait path.
	REPO_PUSH_QUEUE: optionalFetcherSchema,
	STORAGE_RUNNER: requiredDurableObjectNamespaceSchema(
		'Missing STORAGE_RUNNER binding for durable execute and job storage.',
	),
	PACKAGE_REALTIME_SESSION: requiredDurableObjectNamespaceSchema(
		'Missing PACKAGE_REALTIME_SESSION binding for package realtime websocket sessions.',
	),
	MCP_CLIENT_HUB: requiredDurableObjectNamespaceSchema(
		'Missing MCP_CLIENT_HUB binding for user-added MCP server connections.',
	),
	RUNTIME_WORKER: optionalFetcherSchema,
	APP_BASE_URL: optionalUrlStringSchema,
	// Comma-separated legacy app hostnames the Worker keeps serving alongside
	// the canonical `APP_BASE_URL` host during a domain migration. The deploy
	// attaches these as custom domains so flipping APP_BASE_URL never detaches
	// the old origin or deletes its DNS.
	APP_LEGACY_HOSTS: optionalNonEmptyStringSchema,
	// Exact string 'true' enables 308 redirects from legacy hosts to the
	// canonical origin for safe browser GET/HEAD requests. Protocol surfaces
	// (/mcp, OAuth, well-known, webhooks, email) are never redirected. Leave
	// unset to dual-serve legacy hosts without redirecting browser navigation.
	APP_LEGACY_REDIRECT: optionalNonEmptyStringSchema,
	// Optional in env schema so local/preview/test can omit them. Production
	// boot (getEnv) and request-time public-form-protection refuse when either
	// key is missing — signup is always open and must not fail open.
	TURNSTILE_SITE_KEY: optionalNonEmptyStringSchema,
	TURNSTILE_SECRET_KEY: optionalNonEmptyStringSchema,
	// Origin that hosted package apps are served from. Required in production
	// and must use a separate registrable domain so author-supplied package code
	// is cross-site from the app origin. It may be unset locally/preview/test,
	// where the same-origin path-based behavior remains available.
	// See docs/contributing/security.md.
	PACKAGE_APP_BASE_URL: optionalUrlStringSchema,
	// Comma-separated dual-served package-app apex hostnames the runtime
	// Worker serves alongside the canonical `PACKAGE_APP_BASE_URL` host.
	// Generated zone routes replace the whole set, so omitting a listed host
	// would detach it and delete its DNS.
	PACKAGE_APP_LEGACY_HOSTS: optionalNonEmptyStringSchema,
	// Exact string 'true' enables 308 redirects from dual-served package-app
	// *user subdomains* to the matching canonical subdomain for safe
	// browser GET/HEAD. Leave unset to dual-serve (`__Host-kody_pkg_session`
	// cookies and published package URLs are host-only on each zone). Apex
	// `/` on a dual-served package-app host goes to the app origin; it is
	// never redirected onto the canonical package-app apex.
	PACKAGE_APP_LEGACY_REDIRECT: optionalNonEmptyStringSchema,
	// Comma-separated HMAC keys for package-app access tickets. The first key
	// signs; every key verifies (rotation: docs/contributing/secret-rotation.md).
	// Unset derives one key from COOKIE_SECRET.
	PACKAGE_APP_TICKET_KEYS: optionalPackageAppTicketKeysSchema,
	// Percent of the existing usage limit at which the package-app usage
	// circuit breaker opens. Unset means 100 (trip exactly at the limit).
	PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT: optionalPositivePercentSchema,
	USER_EMAIL_DOMAIN: optionalNonEmptyStringSchema,
	// Overrides the system email domain derived from APP_BASE_URL. Committed
	// in production so email and the web origin can move independently.
	SYSTEM_EMAIL_DOMAIN: optionalNonEmptyStringSchema,
	// Comma-separated dual-served user email domains; inbound mail on those
	// addresses resolves to the same user inboxes. Outbound always sends from
	// the canonical USER_EMAIL_DOMAIN.
	LEGACY_USER_EMAIL_DOMAINS: optionalNonEmptyStringSchema,
	// Comma-separated dual-served system email domains; operator inboxes
	// (kody@, support@, ...) accept mail on those hosts alongside the
	// canonical SYSTEM_EMAIL_DOMAIN.
	LEGACY_SYSTEM_EMAIL_DOMAINS: optionalNonEmptyStringSchema,
	APP_COMMIT_SHA: optionalCommitShaSchema,
	// Opaque deploy metadata (JSON or base64url JSON) for GET /health. Set
	// automatically by deploy workflows; invalid values must not fail env
	// validation because that would take the worker down.
	APP_DEPLOY_INFO: optionalNonEmptyStringSchema,
	EMAIL: optionalSendEmailSchema,
	EMAIL_EVENTS: optionalAnalyticsEngineDatasetSchema,
	USAGE_EVENTS: optionalAnalyticsEngineDatasetSchema,
	FLAG_EXPOSURES: optionalAnalyticsEngineDatasetSchema,
	MCP_PROTOCOL_EVENTS: optionalAnalyticsEngineDatasetSchema,
	EXECUTE_INTERPRETABLE_EVENTS: optionalAnalyticsEngineDatasetSchema,
	MCP_SEARCH_EVENTS: optionalAnalyticsEngineDatasetSchema,
	ONBOARDING_FUNNEL_EVENTS: optionalAnalyticsEngineDatasetSchema,
	PACKAGE_APP_LEGACY_EVENTS: optionalAnalyticsEngineDatasetSchema,
	SENTRY_DSN: optionalUrlStringSchema,
	SENTRY_ENVIRONMENT: optionalNonEmptyStringSchema,
	SENTRY_TRACES_SAMPLE_RATE: optionalSentryTracesSampleRateSchema,
	// Fathom Analytics site id (public, non-secret). When set, SSR pages embed
	// the Fathom tracker script; when unset (local dev, preview, tests) no
	// analytics script is rendered.
	FATHOM_SITE_ID: optionalNonEmptyStringSchema,
	// Comma-separated YouTube playlist ids whose latest Atom-feed videos
	// (typically ~15 each) may open in the site-wide `/?youtubeId=` overlay.
	// `none` disables playlists. Unset means no playlist fetch (tests).
	YOUTUBE_ALLOWED_PLAYLIST_IDS: optionalNonEmptyStringSchema,
	// Comma-separated extra YouTube video ids allowed by the overlay and
	// first-party thumbnail proxy, in addition to playlist items.
	YOUTUBE_ALLOWED_VIDEO_IDS: optionalNonEmptyStringSchema,
	// Optional YouTube Data API key for the homepage hero playlist (playlist
	// order). When unset, the Worker reads the same unlisted playlist through
	// YouTube's public browse endpoint so local/preview still work.
	YOUTUBE_DATA_API_KEY: optionalNonEmptyStringSchema,
	WRANGLER_IS_LOCAL_DEV: optionalNonEmptyStringSchema,
	GITHUB_CLIENT_ID: optionalNonEmptyStringSchema,
	GITHUB_CLIENT_SECRET: optionalNonEmptyStringSchema,
	GOOGLE_CLIENT_ID: optionalNonEmptyStringSchema,
	GOOGLE_CLIENT_SECRET: optionalNonEmptyStringSchema,
	X_CLIENT_ID: optionalNonEmptyStringSchema,
	X_CLIENT_SECRET: optionalNonEmptyStringSchema,
	DISCORD_CLIENT_ID: optionalNonEmptyStringSchema,
	DISCORD_CLIENT_SECRET: optionalNonEmptyStringSchema,
	// Operator Discord bot used to assign/remove Kody Discord guild roles
	// after a Discord social-login connection is stored. Bot token + guild
	// id plus at least one role id must be set; login still works when they
	// are unset. Standard/Pro roles follow orgs.stripe_plan.
	DISCORD_BOT_TOKEN: optionalNonEmptyStringSchema,
	DISCORD_GUILD_ID: optionalNonEmptyStringSchema,
	DISCORD_MEMBER_ROLE_ID: optionalNonEmptyStringSchema,
	DISCORD_STANDARD_ROLE_ID: optionalNonEmptyStringSchema,
	DISCORD_PRO_ROLE_ID: optionalNonEmptyStringSchema,
	CLOUDFLARE_ACCOUNT_ID: optionalNonEmptyStringSchema,
	CLOUDFLARE_API_TOKEN: optionalNonEmptyStringSchema,
	// Zone SSL and Certificates Edit, limited to the package-app SaaS zone.
	// Does not exist yet (#3612). Not CLOUDFLARE_API_TOKEN. Optional so deploys
	// succeed before the token is minted.
	CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: optionalNonEmptyStringSchema,
	// Cloudflare for SaaS zone that owns package-app custom hostnames. Use a
	// staging copy for proof. Never assume the production kody.run zone.
	PACKAGE_APP_ZONE_ID: optionalNonEmptyStringSchema,
	CLOUDFLARE_API_BASE_URL: optionalUrlStringSchema,
	// `true` when CLOUDFLARE_API_BASE_URL points at a local Cloudflare API
	// stand-in that serves whole repo trees by commit. The dev CLI sets it; the
	// real API has no such endpoint, so production leaves it unset.
	CLOUDFLARE_API_SOURCE_SNAPSHOTS: optionalNonEmptyStringSchema,
	// Optional Artifacts REST token when CLOUDFLARE_API_TOKEN is a mock
	// credential for CLOUDFLARE_API_BASE_URL (PR previews). Mint/fork against
	// the real Artifacts API with this token while email still uses the mock.
	CLOUDFLARE_ARTIFACTS_API_TOKEN: optionalNonEmptyStringSchema,
	ARTIFACTS_NAMESPACE: optionalNonEmptyStringSchema,
	// Worker-to-Worker Artifacts binding. Present in production/preview when
	// wrangler `artifacts` is configured; local/tests fall back to REST.
	ARTIFACTS: optionalArtifactsSchema,
	AI: optionalAiSchema,
	AI_GATEWAY_ID: optionalNonEmptyStringSchema,
	CAPABILITY_REINDEX_SECRET: optionalNonEmptyStringSchema,
	JOB_REINDEX_SECRET: optionalNonEmptyStringSchema,
	// Kit (kit.com) — optional. Account signup uses KIT_API_KEY to best-effort
	// tag existing Kit subscribers with signed_up::kody (never creates
	// subscribers; never fails signup when Kit is unset or errors).
	KIT_API_KEY: optionalNonEmptyStringSchema,
	KIT_SIGNED_UP_TAG_ID: optionalNonEmptyStringSchema,
	// Stripe billing — optional; when STRIPE_SECRET_KEY is unset, billing
	// surfaces render a "not configured" notice and sync/cron/portal skip.
	STRIPE_SECRET_KEY: optionalNonEmptyStringSchema,
	// Stripe platform webhook signing secret (`whsec_...`). When unset,
	// POST /webhooks/stripe returns 503.
	STRIPE_WEBHOOK_SECRET: optionalNonEmptyStringSchema,
	// Override for tests/mocks; defaults to https://api.stripe.com.
	STRIPE_API_BASE_URL: optionalUrlStringSchema,
	// Purchasable Pro ($12 / $120) with the prepaid credit wallet.
	STRIPE_PRO_PRICE_ID: optionalNonEmptyStringSchema,
	STRIPE_PRO_YEARLY_PRICE_ID: optionalNonEmptyStringSchema,
	// Stripe Billing Portal configuration (`bpc_...`) used for Manage
	// subscription and the prorated plan-change flow. Unset → Stripe account
	// default configuration.
	STRIPE_BILLING_PORTAL_CONFIGURATION_ID: optionalNonEmptyStringSchema,
	// OIDC ID token signing (RS256). Production must use a dedicated RSA key pair;
	// local dev and tests use the committed example/test key in `.env.example`.
	OIDC_SIGNING_PRIVATE_KEY_PEM: string().refine(
		(value) => value.includes('BEGIN PRIVATE KEY'),
		'OIDC_SIGNING_PRIVATE_KEY_PEM must be a PKCS#8 PEM private key.',
	),
	OIDC_SIGNING_KEY_ID: string().refine(
		(value) => value.trim().length > 0,
		'OIDC_SIGNING_KEY_ID must be a non-empty key identifier (JWT kid).',
	),
	// Disaster-recovery exporter → DR-account R2 bucket (S3 API). Disabled
	// unless DR_EXPORT_ENABLED is the literal string "true" and credentials
	// are present. Secrets are set out-of-band via the Cloudflare API.
	DR_EXPORT_ENABLED: optionalNonEmptyStringSchema,
	// Soft-delete purge lane (Teams P7). Default false: first production
	// enable is dry-run via adminSoftDeletePurgeRun, then flip to "true".
	SOFT_DELETE_PURGE_ENABLED: optionalNonEmptyStringSchema,
	DR_BACKUP_ACCOUNT_ID: optionalNonEmptyStringSchema,
	DR_BACKUP_BUCKET_NAME: optionalNonEmptyStringSchema,
	DR_BACKUP_ACCESS_KEY_ID: optionalNonEmptyStringSchema,
	DR_BACKUP_SECRET_ACCESS_KEY: optionalNonEmptyStringSchema,
	// Bearer secret for production DR restore and DO PITR maintenance routes.
	// Both fail closed when unset.
	DR_RESTORE_SECRET: optionalNonEmptyStringSchema,
	// Shared bearer with the status worker. When unset, POST
	// /__maintenance/status-incidents returns not-configured and the status
	// worker skips emit (sweep polling remains the backstop).
	STATUS_INCIDENT_EVENT_SECRET: optionalNonEmptyStringSchema,
	// Dedicated canary OAuth access token for the hourly authenticated MCP
	// execute fallback. Timestamp-only fleet heartbeat never stores this.
	MCP_EXECUTE_HEALTH_CANARY_ACCESS_TOKEN: optionalNonEmptyStringSchema,
})

export type AppEnv = InferOutput<typeof EnvSchema>
