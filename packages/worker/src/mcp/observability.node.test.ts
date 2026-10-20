import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const sentryMock = vi.hoisted(() => ({
	isInitialized: vi.fn(() => true),
	getClient: vi.fn(() => ({ getOptions: () => ({ dsn: 'https://example' }) })),
	withScope: vi.fn((callback: (scope: ScopeStub) => void) => {
		callback(sentryMock.scope)
	}),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	scope: {
		setLevel: vi.fn(),
		setTag: vi.fn(),
		setContext: vi.fn(),
		setUser: vi.fn(),
	},
}))

type ScopeStub = typeof sentryMock.scope

vi.mock('@sentry/cloudflare', () => ({
	isInitialized: () => sentryMock.isInitialized(),
	getClient: () => sentryMock.getClient(),
	withScope: (callback: (scope: ScopeStub) => void) =>
		sentryMock.withScope(callback),
	captureException: (...args: Array<unknown>) =>
		sentryMock.captureException(...args),
	captureMessage: (...args: Array<unknown>) =>
		sentryMock.captureMessage(...args),
	instrumentDurableObjectWithSentry: (
		_getOptions: unknown,
		durableObjectClass: unknown,
	) => durableObjectClass,
}))

const { logMcpEvent } = await import('./observability.ts')
const { assertKodyDescriptionLength, KODY_DESCRIPTION_MAX_LENGTH } =
	await import('#worker/package-registry/types.ts')
const { McpCallerError } = await import('./caller-error.ts')
const { requireMcpRequest, requireMcpUser } =
	await import('./capabilities/meta/require-user.ts')
const { executeInvokeMissingInputMessage } = await import('./execute-invoke.ts')
const { PackageSecretAccessDeniedError } =
	await import('./secrets/package-access.ts')
const { CommunityActionError } = await import('#worker/community/errors.ts')
const { EntitlementLimitError } = await import('#worker/entitlements/errors.ts')
const { PackageNameInputError, normalizePackageNameInput } =
	await import('#worker/package-registry/package-name.ts')
const { SavedPackageNotFoundError } =
	await import('#worker/package-runtime/package-import-resolution.ts')
const { UserCodeError } = await import('#worker/user-code-error.ts')
const { RepoChecksFailedError, repoChecksFailedErrorName } =
	await import('#worker/repo/repo-checks-failed-error.ts')

function captureMcpEvents(run: () => void) {
	sentryMock.captureException.mockClear()
	sentryMock.captureMessage.mockClear()
	sentryMock.withScope.mockClear()
	sentryMock.scope.setLevel.mockClear()
	sentryMock.scope.setUser.mockClear()

	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		run()
	} finally {
		console.info = originalInfo
	}
	return payloads
}

const callerFailureBase = {
	category: 'mcp',
	tool: 'capability',
	outcome: 'failure',
	durationMs: 3,
	baseUrl: 'https://example.com',
	hasUser: true,
	userId: ownerIdFromStored('user-1'),
} as const

type McpEvent = Parameters<typeof logMcpEvent>[0]

function handlerFailure(
	capabilityName: string,
	domain: string | null,
	errorName: string,
	cause: Error,
	extra: Partial<McpEvent> = {},
) {
	return {
		...callerFailureBase,
		capabilityName,
		...(domain
			? {
					domain,
					capabilitySource: domain.startsWith('mcp:')
						? 'mcp-server'
						: 'builtin',
				}
			: {}),
		failurePhase: 'handler',
		errorName,
		errorMessage: cause.message,
		cause,
		...extra,
	} as McpEvent
}

function expectNoSentry() {
	expect(sentryMock.captureException).not.toHaveBeenCalled()
	expect(sentryMock.captureMessage).not.toHaveBeenCalled()
}

function thrownBy(run: () => unknown) {
	try {
		run()
	} catch (error) {
		return error as Error
	}
	throw new Error('expected run to throw')
}

const repoSearchMessage =
	'repoSearch received an invalid regex: Invalid regular expression: /(?s).|^$/gi: Invalid group. mode=regex uses JavaScript RegExp syntax (no inline flags like (?s) or (?i); for dotall matching use [\\s\\S] instead of `.` with (?s)).'
const packageSaveOverwriteMessage =
	'packageSave would overwrite existing package source "aa2d1349-5ac2-4b32-8c53-df1ce0a60b37". Set confirm_destructive_overwrite: true only after the user explicitly approves destructive overwrite; Kody will also verify a restorable backup snapshot first.'

test('logMcpEvent keeps sandbox and caller failures off Sentry and still reports platform bugs', () => {
	const callerFailures: Array<McpEvent> = [
		{
			...callerFailureBase,
			tool: 'execute',
			toolName: 'execute',
			durationMs: 12,
			sandboxError: true,
			errorName: 'Unknown',
			errorMessage:
				'Notion API /data_sources/39977ef0-f2db-81c6-9147-000bd579e312/query failed: validation_error',
			cause: 'Notion API /data_sources/.../query failed: validation_error',
		},
		handlerFailure(
			'search',
			null,
			'McpCallerError',
			new McpCallerError('Provide "query" or "domain".'),
		),
		{
			...callerFailureBase,
			tool: 'search',
			toolName: 'search',
			errorName: 'McpCallerError',
			errorMessage:
				'Unknown domain "skills". Available domains: account, packages.',
			cause: new McpCallerError(
				'Unknown domain "skills". Available domains: account, packages.',
			),
		},
		handlerFailure(
			'repoOpenSession',
			null,
			'Error',
			new Error('Opening the session failed.', {
				cause: new McpCallerError('Discard the current session first.'),
			}),
		),
		handlerFailure('valueGet', null, 'ZodError', new Error('name: Required'), {
			failurePhase: 'parse_input',
		}),
		{
			...callerFailureBase,
			tool: 'search',
			toolName: 'search',
			callerError: true,
			errorName: 'EntityBatchError',
			errorMessage: 'All entity lookups failed.',
		},
		handlerFailure(
			'user_module_run',
			null,
			'UserCodeError',
			new UserCodeError('boom from user code'),
		),
		handlerFailure(
			'secretSet',
			'secrets',
			'PackageSecretAccessDeniedError',
			new PackageSecretAccessDeniedError(
				'Secret "x-kodykoalaAccessToken" is not allowed for package "x".',
			),
		),
		handlerFailure(
			'communityRate',
			'community',
			'CommunityActionError',
			new CommunityActionError('Fork this public package before rating it.'),
		),
		handlerFailure(
			'storageQuery',
			'storage',
			'EntitlementLimitError',
			new EntitlementLimitError({
				resource: 'storage_bytes',
				plan: 'free',
				limit: 67_108_864,
				current: 449_966_219,
				upgradeHint:
					'Delete package or job storage you no longer need, or discard active repo sessions with repoDiscardSession, or upgrade your plan at /@<slug>/-/billing.',
			}),
		),
		handlerFailure(
			'jobUpdate',
			'jobs',
			'Error',
			new Error('Job update failed.', {
				cause: new EntitlementLimitError({
					resource: 'scheduled_jobs',
					plan: 'free',
					limit: 10,
					current: 46,
					upgradeHint:
						'Remove or finish existing scheduled jobs you no longer need, or upgrade your plan at /@<slug>/-/billing.',
				}),
			}),
		),
		handlerFailure(
			'mcp:home:bond_shade_set_position',
			'mcp:home',
			'Error',
			new McpCallerError('MCP server "home" is not connected.'),
		),
		// User SQL against a storage bucket (KODY-CLOUDFLARE-44). Plain Error
		// form — Durable Object RPC loses subclass identity.
		handlerFailure(
			'storageQuery',
			'storage',
			'Error',
			new Error('no such table: notes: SQLITE_ERROR'),
			{
				conversationId: 'conv-storage-1',
				storageId: 'storage-notes-1',
				context: { sqlPreview: 'SELECT * FROM notes LIMIT 1' },
			},
		),
		// Published repo session (KODY-CLOUDFLARE-4A). Plain Error from DO RPC.
		handlerFailure(
			'repoStatus',
			'repo',
			'Error',
			new Error(
				'Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" is published; open a new session before continuing.',
			),
		),
		// Missing / placeholder repo session id (KODY-CLOUDFLARE-5V).
		handlerFailure(
			'repoReadFile',
			'repo',
			'Error',
			new Error('Repo session "none" was not found.'),
		),
		// Invalid repoSearch regex (KODY-CLOUDFLARE-49). Plain Error from DO RPC.
		handlerFailure('repoSearch', 'repo', 'Error', new Error(repoSearchMessage)),
		// Non-fast-forward publish push (KODY-CLOUDFLARE-5M). Plain Error from DO.
		handlerFailure(
			'repoPublishSession',
			'repo',
			'PushRejectedError',
			new Error(
				'Push rejected because it was not a simple fast-forward. Use "force: true" to override.',
			),
		),
		// packageSave destructive overwrite confirmation (issue 7661329778).
		// Plain Error from shared source-safety-policy helpers.
		handlerFailure(
			'packageSave',
			'packages',
			'Error',
			new Error(packageSaveOverwriteMessage),
		),
		// Downstream user-connected MCP server tool failure (KODY-CLOUDFLARE-4B).
		handlerFailure(
			'mcp:supermemory:listMemories',
			'mcp:supermemory',
			'McpCallerError',
			new McpCallerError(
				'MCP server capability "supermemory:listMemories" failed: ProtocolError: Structured content does not match the tool\'s output schema',
			),
		),
		// OAuth token refresh caller state (KODY-CLOUDFLARE-4J): marker match.
		handlerFailure(
			'integrationTokenRefresh',
			'integrations',
			'Error',
			new Error(
				'Token refresh was rejected. (integrationTokenRefresh caller state)',
			),
		),
		// Disallowed repo path (KODY-6P). Plain Error from DO RPC, including
		// the pre-normalization wording still in flight.
		handlerFailure(
			'repoEditFiles',
			'repo',
			'Error',
			new Error(
				'Repo path "src/../exports/self-test.ts" is not allowed: paths cannot contain ".." or ".git" segments.',
			),
		),
		// Repo session unified-diff line limit (KODY-8E). Stable phrase and
		// raw `@cloudflare/shell` EFBIG wording both stay off Sentry.
		handlerFailure(
			'repoEditFiles',
			'repo',
			'Error',
			new Error(
				'"assets/extracted.txt" has 10,001 lines, which is over the 10,000-line line limit for repo session unified diffs. Repo session edits cannot emit unified diffs for files over that limit. Split the file into separate source files that each stay within the limit, or store large blobs outside the repo (for example Cloudflare R2, Amazon S3, Dropbox, or Google Drive).',
			),
		),
		handlerFailure(
			'repoEditFiles',
			'repo',
			'Error',
			new Error('EFBIG: content too large for diff (max 10000 lines)'),
		),
		// Extended Cloudflare storage FK constraint (KODY-8P). StorageRunner
		// surfaces "SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)"
		// — user SQL mistake, stays off Sentry.
		handlerFailure(
			'storageQuery',
			'storage',
			'Error',
			new Error(
				'FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)',
			),
			{
				conversationId: 'conv-storage-2',
				storageId: 'storage-fk-1',
				context: {
					sqlPreview: 'INSERT INTO probe_t (parent_id) VALUES (99)',
				},
			},
		),
		// Failed publish/repo checks (KODY-96). Live class and DO/JSRPC-flattened
		// name/prefix forms stay off Sentry even before packageSave rewraps.
		handlerFailure(
			'packageSave',
			'packages',
			repoChecksFailedErrorName,
			new RepoChecksFailedError('src/receive.js(12,3): type mismatch'),
		),
		handlerFailure(
			'packageSave',
			'packages',
			'Error',
			new Error(
				`${repoChecksFailedErrorName}: src/receive.js(12,3): type mismatch`,
			),
		),
		// Missing delete/move targets (KODY-9B). Plain Error from DO RPC.
		// Agents guess paths; the caller still receives the error.
		handlerFailure(
			'repoEditFiles',
			'repo',
			'Error',
			new Error(
				'repo session delete edit target "src/index.js" was not found.',
			),
		),
		handlerFailure(
			'repoEditFiles',
			'repo',
			'Error',
			new Error('repo session move edit source "index.ts" was not found.'),
		),
		handlerFailure(
			'repoEditFiles',
			'repo',
			'Error',
			new Error('Durable Object RPC failed', {
				cause: new Error(
					'repo session delete edit target "index.js" was not found.',
				),
			}),
		),
		handlerFailure(
			'repoEditFiles',
			'repo',
			'Error',
			new Error(
				'repo session edits cannot combine a delete/move touching "src/a.ts" with a write/replace/writeJson edit for the same path in one call. Split them into separate repoEditFiles calls.',
			),
		),
		// Malformed / non-applying patches (KODY-A3 / KODY-A4). Plain Error
		// from DO RPC, including the legacy `git apply patch: …` wrap.
		handlerFailure(
			'repoApplyPatch',
			'repo',
			'Error',
			new Error(
				'git apply patch is malformed: Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@. Hunk header line counts (the numbers after @@) must match the hunk body.',
			),
		),
		handlerFailure(
			'repoApplyPatch',
			'repo',
			'Error',
			new Error(
				'git apply patch: Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@',
			),
		),
		handlerFailure(
			'repoApplyPatch',
			'repo',
			'Error',
			new Error('git apply patch did not apply cleanly to src/index.ts.'),
		),
		handlerFailure(
			'repoApplyPatch',
			'repo',
			'Error',
			new Error('Durable Object RPC failed', {
				cause: new Error('git apply patch did not contain any file changes.'),
			}),
		),
		handlerFailure(
			'repoApplyPatch',
			'repo',
			'Error',
			new Error('Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@'),
		),
	]
	const payloads = captureMcpEvents(() => {
		for (const event of callerFailures) logMcpEvent(event)
	})

	expect(payloads).toHaveLength(35)
	expect(JSON.parse(payloads[0]!)).toMatchObject({
		tool: 'execute',
		outcome: 'failure',
		sandboxError: true,
	})
	expectNoSentry()

	captureMcpEvents(() => {
		logMcpEvent({
			...handlerFailure(
				'valueGet',
				null,
				'Error',
				new Error('platform handler blew up'),
			),
			capabilitySource: 'builtin',
			sandboxError: false,
		})
		logMcpEvent(
			handlerFailure(
				'packageGet',
				null,
				'Error',
				new Error('D1 write failed.', {
					cause: new Error('storage unavailable'),
				}),
			),
		)
		// Extended D1 constraint error from a non-storage capability must still
		// reach Sentry (KODY-8P regression guard — only storageQuery is exempt).
		logMcpEvent(
			handlerFailure(
				'packageSave',
				'packages',
				'Error',
				new Error(
					'D1_ERROR: UNIQUE constraint failed: saved_packages.user_id, saved_packages.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
				),
			),
		)
		logMcpEvent(
			handlerFailure(
				'mcp:home:bond_shade_set_position',
				'mcp:home',
				'Error',
				new Error('MCP tool "home:bond_shade_set_position" failed: timeout'),
			),
		)
		// Unrelated "was not found" phrases stay platform-visible (KODY-9B
		// must not swallow Source, Manifest, or Saved package misses).
		logMcpEvent(
			handlerFailure(
				'repoReadFile',
				'repo',
				'Error',
				new Error('Source "abc" was not found.'),
			),
		)
		logMcpEvent(
			handlerFailure(
				'repoOpenSession',
				'repo',
				'Error',
				new Error('Manifest "package.json" was not found.'),
			),
		)
		logMcpEvent(
			handlerFailure(
				'packageSave',
				'packages',
				'Error',
				new Error('Saved package "demo" was not found.'),
			),
		)
	})

	expect(sentryMock.captureException).toHaveBeenCalledTimes(7)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({ message: 'platform handler blew up' }),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({ message: 'D1 write failed.' }),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		3,
		expect.objectContaining({
			message:
				'D1_ERROR: UNIQUE constraint failed: saved_packages.user_id, saved_packages.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
		}),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		4,
		expect.objectContaining({
			message: 'MCP tool "home:bond_shade_set_position" failed: timeout',
		}),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		5,
		expect.objectContaining({ message: 'Source "abc" was not found.' }),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		6,
		expect.objectContaining({
			message: 'Manifest "package.json" was not found.',
		}),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		7,
		expect.objectContaining({
			message: 'Saved package "demo" was not found.',
		}),
	)
	expect(sentryMock.scope.setLevel).toHaveBeenCalledWith('error')
	expect(sentryMock.scope.setUser).toHaveBeenCalledWith({ id: 'user-1' })
	expect(sentryMock.scope.setContext).toHaveBeenCalledWith(
		'mcp',
		expect.objectContaining({
			baseUrl: 'https://example.com',
			hasUser: true,
			errorMessage: 'platform handler blew up',
			detail: undefined,
		}),
	)
	expect(sentryMock.captureMessage).not.toHaveBeenCalled()
})

test('package name, missing-import, execute-input, and description caller errors stay off Sentry', () => {
	const packageNameError = thrownBy(() =>
		normalizePackageNameInput({
			value: '@kody/google',
			ownerScope: 'grant',
			action: 'resolve',
		}),
	)
	expect(packageNameError).toBeInstanceOf(PackageNameInputError)
	const descriptionError = thrownBy(() =>
		assertKodyDescriptionLength('a'.repeat(KODY_DESCRIPTION_MAX_LENGTH + 1)),
	)
	expect(descriptionError).toBeInstanceOf(Error)
	const missingPackage = new SavedPackageNotFoundError('@distilledtom/google')
	const executeInputError = new McpCallerError(executeInvokeMissingInputMessage)

	const callerErrors: Array<McpEvent> = [
		handlerFailure(
			'packageGetGitRemote',
			'packages',
			'PackageNameInputError',
			packageNameError,
		),
		handlerFailure(
			'packageGetGitRemote',
			'packages',
			'Error',
			new Error('package lookup failed', { cause: packageNameError }),
		),
		handlerFailure(
			'packageSave',
			'packages',
			'SavedPackageNotFoundError',
			missingPackage,
		),
		handlerFailure(
			'packageSave',
			'packages',
			'Error',
			new Error('package graph rewrite failed', { cause: missingPackage }),
		),
		{
			...callerFailureBase,
			tool: 'execute',
			toolName: 'execute',
			errorName: 'McpCallerError',
			errorMessage: executeInputError.message,
			cause: executeInputError,
		},
		handlerFailure(
			'packageGetGitRemote',
			'packages',
			'Error',
			descriptionError,
		),
	]
	for (const event of callerErrors) {
		captureMcpEvents(() => logMcpEvent(event))
		expectNoSentry()
	}

	const opaqueRetry = new Error(
		[
			'packageGetGitRemote hit a transient Cloudflare Artifacts internal error.',
			'Retry the call.',
			'An internal error occurred.',
		].join(' '),
		{ cause: new Error('An internal error occurred.') },
	)
	captureMcpEvents(() => {
		logMcpEvent(
			handlerFailure('packageGetGitRemote', 'packages', 'Error', opaqueRetry),
		)
	})
	expectNoSentry()

	captureMcpEvents(() => {
		logMcpEvent(
			handlerFailure(
				'packageGetGitRemote',
				null,
				'Error',
				new Error('kody.description is missing'),
			),
		)
	})
	expect(sentryMock.captureException).toHaveBeenCalledTimes(1)
})

test('unauthenticated capability calls stay off Sentry (KODY-9C)', () => {
	const missingUser = thrownBy(() => requireMcpUser({ user: null }))
	const missingRequest = thrownBy(() => requireMcpRequest({}))
	for (const error of [missingUser, missingRequest]) {
		expect(error).toBeInstanceOf(McpCallerError)
		const payloads = captureMcpEvents(() => {
			logMcpEvent(
				handlerFailure('metaGetCurrentUser', 'meta', error.name, error, {
					hasUser: false,
					userId: undefined,
				}),
			)
		})
		expect(payloads).toHaveLength(1)
		expect(JSON.parse(payloads[0]!)).toMatchObject({
			tool: 'capability',
			capabilityName: 'metaGetCurrentUser',
			domain: 'meta',
			outcome: 'failure',
			failurePhase: 'handler',
			hasUser: false,
			errorName: 'McpCallerError',
			errorMessage: 'Authenticated MCP user is required for this capability.',
		})
		expectNoSentry()
	}
})
