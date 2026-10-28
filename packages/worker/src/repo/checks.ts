import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	getPackageAppAssetsDirectory,
	getPackageAppClientEntryPath,
	listPackageSubscriptions,
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import {
	findStaticKodyDependencyCycle,
	formatStaticKodyDependencyCycleMessage,
	loadReachableStaticKodyDependencyEdges,
} from '#worker/package-registry/static-dependency-cycles.ts'
import {
	assertKodyDescriptionLength,
	listKodyPackageDependencyNames,
	type AuthoredPackageJson,
} from '#worker/package-registry/types.ts'
import {
	buildKodyAppBundle,
	buildKodyAppClientBundle,
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from '#worker/package-runtime/module-graph.ts'
import {
	collectReachableSourceFilePaths,
	readRootPackage,
} from '#worker/package-runtime/module-graph-workspace.ts'
import { validatePackageAppAssetsDirectory } from '#worker/package-runtime/package-app-assets-directory.ts'
import { validatePackageAppGraphSeparation } from '#worker/package-runtime/package-app-client-graph.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from '#worker/package-runtime/package-artifact-targets.ts'
import {
	collectDeprecatedInvocationUsage,
	formatRemovedInvocationUsageFailure,
} from '#worker/package-runtime/deprecated-invocation-usage.ts'
import { validateBarePackageImportDeclarations } from '#worker/package-runtime/bare-package-import-declarations.ts'
import {
	collectStaticKodyPackageImportsFromFiles,
	isTypeDeclarationFilePath,
} from '#worker/package-runtime/static-kody-imports.ts'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	importWorkerBundler,
	importWorkerBundlerTypescript,
} from '#worker/worker-bundler-modules.ts'
import {
	createRepoCapabilitiesModuleTypecheckHarness,
	mapRepoCapabilitiesModuleTypecheckHarnessLines,
	repoCapabilitiesModuleTypecheckHarnessPath,
} from './repo-kody-execution.ts'
import {
	collectEntrypointsMissingDefaultExport,
	formatMissingDefaultExportMessage,
} from './published-entrypoint-checks.ts'
import {
	createIsolatedCheckPhaseRunner,
	isolatedBundleChunkConcurrency,
	isolatedBundleChunkSize,
	type IsolatedCheckPhaseRunner,
} from './isolated-check-phases.ts'
import {
	buildRepoLargeFileMessage,
	maxRepoSourceFileBytes,
} from './large-file-policy.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'
import {
	timePublishExternalPushPhase,
	type PublishPhaseTimings,
} from './publish-phase-timing.ts'
import { validateRequiredPackageDocs } from './required-package-docs.ts'
import { validatePackageSkills } from '#worker/package-registry/package-skills.ts'
import { listScannableModulePaths } from '#worker/credentials/module-placeholder-scan.ts'
import {
	findFetchBodiesMissingSecretResolution,
	formatFetchBodySecretResolutionWarning,
} from '#worker/credentials/fetch-body-secret-resolution.ts'
import { buildCredentialPatternCheck } from './credential-pattern-check.ts'
import { resolveSecretProviderSlots } from '#worker/credentials/secret-provider-slots.ts'
import { credentialNeedKeyNotes } from '#worker/credentials/credential-needs.ts'
import { computeCredentialNeedsClosure } from '#worker/credentials/credential-needs-closure.ts'
import { republishedNeedsNote } from '#worker/enablements/republish-needs-note.ts'

export const repoCheckKinds = [
	'manifest',
	'docs',
	'skills',
	'dependencies',
	'bundle',
	'typecheck',
	'lint',
	'credentials',
	'smoke',
] as const

export type RepoCheckKind = (typeof repoCheckKinds)[number]

export type RepoCheckResult = {
	kind: RepoCheckKind
	ok: boolean
	message: string
}

export type RepoCheckRunResult =
	| {
			ok: true
			results: Array<RepoCheckResult>
			manifest: AuthoredPackageJson
			sourceFiles: Record<string, string>
	  }
	| {
			ok: false
			results: Array<RepoCheckResult>
			/**
			 * Present when the authored package.json parsed and only later checks
			 * failed. Null when the manifest itself is missing or invalid — callers
			 * must use `results` (kind `manifest`) for the failure message.
			 */
			manifest: AuthoredPackageJson | null
			sourceFiles: Record<string, string>
	  }

/**
 * Join failed check messages for callers that throw instead of returning
 * `checks_failed` (bootstrap / packageSave sync). Same messages
 * `publishFromExternalRef` exposes on `failed_checks`.
 */
export function formatFailedRepoCheckMessages(
	results: ReadonlyArray<RepoCheckResult>,
	fallback = 'Publish checks failed.',
) {
	const failed = results
		.filter((entry) => !entry.ok)
		.map((entry) => entry.message)
		.filter((message) => message.trim().length > 0)
	return failed.length > 0 ? failed.join('\n') : fallback
}

/**
 * In-memory workspace over a path→content map for the same `runRepoChecks`
 * surface used by external publish and community install.
 */
export function createSnapshotFilesWorkspace(files: Record<string, string>) {
	return {
		async readFile(path: string) {
			return files[normalizeRepoWorkspacePath(path)] ?? null
		},
		async glob() {
			return Object.keys(files).map((path) => ({
				path,
				type: 'file' as const,
			}))
		},
	}
}

function toRepoCheckRunResult(input: {
	results: Array<RepoCheckResult>
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}): RepoCheckRunResult {
	const ok = input.results.every((result) => result.ok)
	if (ok) {
		return {
			ok: true,
			results: input.results,
			manifest: input.manifest,
			sourceFiles: input.sourceFiles,
		}
	}
	return {
		ok: false,
		results: input.results,
		manifest: input.manifest,
		sourceFiles: input.sourceFiles,
	}
}

const executeTypecheckPreludePath = '.__kody_repo_runtime__.d.ts'
const repoChecksSyntheticTsconfigPath = 'tsconfig.json'
const repoChecksSyntheticTsconfigExtendsPath =
	'./.__kody_repo_tsconfig_base__.json'

/**
 * Publish checks materialize the whole source root in memory before bundling
 * and typechecking, so the walk is capped to keep a single check run within
 * Durable Object CPU/memory limits. The caps are intentionally larger than
 * the execution-path caps in `repo-kody-execution.ts` (250 files / 2 MiB)
 * because published packages may ship assets alongside runtime code.
 */
export const repoChecksSourceMaxFiles = 2_000
export const repoChecksSourceMaxTotalBytes = 15 * 1024 * 1024

async function loadWorkerBundlerSnapshotTools() {
	// Keep the experimental bundler out of the Worker's top-level deploy graph.
	const { createFileSystemSnapshot } = await importWorkerBundler()
	return {
		createFileSystemSnapshot,
	}
}

async function loadWorkerBundlerTypescriptTools() {
	const { createTypescriptLanguageService } =
		await importWorkerBundlerTypescript()
	return {
		createTypescriptLanguageService,
	}
}

type RepoChecksFileSystem = {
	read(path: string): string | null
	write(path: string, content: string): void
	delete(path: string): void
	list(prefix?: string): Array<string>
	flush(): Promise<void>
}

function normalizeRepoChecksFileSystemPath(path: string) {
	return path.replace(/^\.?\//, '')
}

function createRepoChecksFileSystem(input: {
	fileSystem: RepoChecksFileSystem
}) {
	const overlay = new Map<string, string>()
	const deleted = new Set<string>()

	return {
		read(path: string) {
			const normalizedPath = normalizeRepoChecksFileSystemPath(path)
			if (overlay.has(normalizedPath)) {
				return overlay.get(normalizedPath) ?? null
			}
			if (deleted.has(normalizedPath)) {
				return null
			}
			return input.fileSystem.read(normalizedPath)
		},
		write(path: string, content: string) {
			const normalizedPath = normalizeRepoChecksFileSystemPath(path)
			overlay.set(normalizedPath, content)
			deleted.delete(normalizedPath)
		},
		delete(path: string) {
			const normalizedPath = normalizeRepoChecksFileSystemPath(path)
			overlay.delete(normalizedPath)
			deleted.add(normalizedPath)
		},
		list(prefix?: string) {
			const normalizedPrefix =
				prefix === undefined
					? undefined
					: normalizeRepoChecksFileSystemPath(prefix)
			const listed = new Set(
				input.fileSystem
					.list(normalizedPrefix)
					.map((path) => normalizeRepoChecksFileSystemPath(path))
					.filter((path) => !deleted.has(path)),
			)
			for (const path of overlay.keys()) {
				if (
					normalizedPrefix === undefined ||
					path.startsWith(normalizedPrefix)
				) {
					listed.add(path)
				}
			}
			return Array.from(listed)
		},
		async flush() {},
	} satisfies RepoChecksFileSystem
}

function buildRepoChecksTsconfig(baseConfigContent: string | null) {
	if (baseConfigContent == null) {
		return JSON.stringify({
			compilerOptions: {
				allowImportingTsExtensions: true,
				noEmit: true,
			},
		})
	}
	return JSON.stringify({
		extends: repoChecksSyntheticTsconfigExtendsPath,
		compilerOptions: {
			allowImportingTsExtensions: true,
			noEmit: true,
		},
	})
}

async function* workspaceFilesForSnapshot(input: {
	workspace: {
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
		readFile(path: string): Promise<string | null>
		stat?(path: string): Promise<{ size: number } | null>
	}
	root: string
}) {
	const encoder = new TextEncoder()
	const normalizedRoot = normalizeRepoWorkspacePath(input.root).replace(
		/\/+$/,
		'',
	)
	const pattern = normalizedRoot === '' ? '**/*' : `${normalizedRoot}/**/*`
	const files = await input.workspace.glob(pattern)
	for (const file of files) {
		if (file.type !== 'file') continue
		const normalizedPath = normalizeRepoWorkspacePath(file.path)
		if (normalizedPath.split('/').includes('.git')) continue
		const content = await input.workspace.readFile(file.path)
		if (content == null) continue
		const relativePath =
			normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
				? normalizedPath.slice(normalizedRoot.length + 1)
				: normalizedPath
		// Prefer the filesystem's byte size: readFile UTF-8-decodes binary
		// blobs lossily, so re-encoding the string can overstate a binary
		// file's size by up to 3x.
		const stats = input.workspace.stat
			? await input.workspace.stat(file.path)
			: null
		const byteLength = stats?.size ?? encoder.encode(content).byteLength
		yield [relativePath, content, byteLength] as const
	}
}

type TypecheckDiagnostic = {
	messageText: unknown
	code?: number
	start?: number
	length?: number
	file?: {
		fileName?: string
		text?: string
		getLineAndCharacterOfPosition(pos: number): {
			line: number
			character: number
		}
	}
}

/**
 * `@typescript/vfs` throws formatted compiler-options diagnostics (for
 * example TS2688 when a package tsconfig lists `types: ["node"]` and the
 * check filesystem has no `@types/node`) instead of returning them from
 * `getSemanticDiagnostics`. Invalid `tsconfig.json` parse errors are
 * thrown the same way from the worker-bundler host. Authors own those
 * configs — surface them as typecheck failures so publish returns
 * `checks_failed` instead of a Sentry-visible internal error.
 *
 * Match `error TS####:` anywhere: formatDiagnostics uses a bare
 * `error TS####:` prefix for config diagnostics without a file, and
 * `path(line,col): error TS####:` when the diagnostic points at the
 * author tsconfig (or the synthetic extends base we copy it into).
 */
function isTypescriptLanguageServiceCallerErrorMessage(message: string) {
	const trimmed = message.trimStart()
	return (
		/\berror TS\d+:/.test(trimmed) ||
		trimmed.startsWith('tsconfig.json:') ||
		trimmed.startsWith('.__kody_repo_tsconfig_base__.json:')
	)
}

async function createRepoChecksTypescriptLanguageService(input: {
	fileSystem: RepoChecksFileSystem
}): Promise<
	| {
			ok: true
			fileSystem: {
				write(path: string, content: string): void
			}
			languageService: {
				dispose(): void
				getSemanticDiagnostics(path: string): Array<TypecheckDiagnostic>
			}
	  }
	| { ok: false; message: string }
> {
	const { createTypescriptLanguageService } =
		await loadWorkerBundlerTypescriptTools()
	try {
		const created = await createTypescriptLanguageService({
			fileSystem: input.fileSystem,
		})
		return {
			ok: true,
			fileSystem: created.fileSystem,
			languageService: created.languageService,
		}
	} catch (error) {
		const message = getErrorMessage(error).trimEnd()
		if (isTypescriptLanguageServiceCallerErrorMessage(message)) {
			return { ok: false, message }
		}
		throw error
	}
}

function flattenDiagnosticMessageText(messageText: unknown): string {
	if (typeof messageText === 'string') return messageText
	if (
		messageText &&
		typeof messageText === 'object' &&
		'messageText' in messageText &&
		typeof messageText.messageText === 'string'
	) {
		const next = 'next' in messageText ? messageText.next : undefined
		const nested = Array.isArray(next)
			? next.map((entry) => flattenDiagnosticMessageText(entry))
			: []
		return [messageText.messageText, ...nested].join(' ')
	}
	return JSON.stringify(messageText)
}

function formatTypecheckDiagnostics(
	fileName: string,
	diagnostics: Array<TypecheckDiagnostic>,
) {
	return diagnostics.map((diagnostic) => {
		const diagnosticFileName =
			typeof diagnostic.file?.fileName === 'string'
				? diagnostic.file.fileName.replace(/\\/g, '/')
				: null
		// Harness diagnostics are attributed to a callable source path; keep
		// that path but drop harness coordinates so later callables are not
		// labeled with shifted generated line numbers.
		const locationBelongsToReportedFile =
			diagnosticFileName != null &&
			(diagnosticFileName === fileName ||
				diagnosticFileName.endsWith(`/${fileName}`))
		const location =
			locationBelongsToReportedFile &&
			typeof diagnostic.start === 'number' &&
			diagnostic.file
				? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
				: null
		const message = flattenDiagnosticMessageText(diagnostic.messageText)
		return location
			? `${fileName}:${location.line + 1}:${location.character + 1} ${message}`
			: `${fileName} ${message}`
	})
}

function formatTypeLiteralUnion(values: Array<string>) {
	const uniqueValues = Array.from(new Set(values)).sort((left, right) =>
		left.localeCompare(right),
	)
	if (uniqueValues.length === 0) return 'never'
	return uniqueValues.map((value) => JSON.stringify(value)).join(' | ')
}

function createExecuteTypecheckPrelude(input?: {
	emittedEventTopics?: Array<string>
}) {
	return `type KodyJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: KodyJsonValue }
  | Array<KodyJsonValue>;

type KodyCapabilityArgs = Record<string, unknown>;
type KodyCapabilityResult = unknown;
type KodyCapability = (args: KodyCapabilityArgs) => Promise<KodyCapabilityResult>;
type KodyMcpServerTools = Record<
  string,
  (args?: KodyCapabilityArgs) => Promise<KodyCapabilityResult>
>;
type KodyStorageRuntime = {
  id: string;
  get(key: string): Promise<unknown>;
  list(options?: KodyCapabilityArgs): Promise<unknown>;
  sql(query: string, params?: Array<KodyJsonValue>): Promise<unknown>;
  set(key: string, value: KodyJsonValue): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  clear(): Promise<unknown>;
};
type KodySecretScope = 'user' | 'package' | 'session';
type KodySecretHeadersRuntime = {
  basic(input: {
    usernameSecret: string;
    passwordSecret: string;
    scope?: KodySecretScope | null;
  }): string;
};
type KodyOauthClientCredentialsInput = {
  tokenUrl: string | URL;
  clientIdSecret: string;
  clientSecretSecret: string;
  scope?: KodySecretScope | null;
  authStyle?: 'basic';
  body?: Record<string, string>;
  headers?: Record<string, string>;
};
type KodyEmailRuntime = {
  getMessage(messageId: string): Promise<unknown>;
  getAttachment(attachmentId: string): Promise<unknown>;
  reply(input?: KodyCapabilityArgs): Promise<unknown>;
} | null;
type KodyWorkflowsRuntime = {
  create(input: KodyCapabilityArgs): Promise<unknown>;
} | null;
type KodyDeclaredEventTopic = ${formatTypeLiteralUnion(input?.emittedEventTopics ?? [])};
type KodyEventsRuntime = {
  dispatch(input: {
    topic: KodyDeclaredEventTopic;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
} | null;

declare module "kody:runtime" {
  export const kody: Record<string, KodyCapability> & {
    readonly mcp: Record<string, KodyMcpServerTools>;
    appRateLimit: (input: {
      key: string;
      limit: number;
      windowSeconds: number;
    }) => Promise<{
      allowed: boolean;
      remaining: number;
      resetAt: string;
      retryAfterSeconds: number | null;
    }>;
    appSpendGet: (input?: Record<string, never>) => Promise<{
      month: string;
      creditsMicroUsd: number;
      days: Array<{
        day: string;
        creditsMicroUsd: number;
        meters: Array<{
          meter: "unique_worker_days" | "durable_object_rows_read";
          units: number;
          creditsMicroUsd: number;
        }>;
      }>;
    }>;
  };
  export function hasScope(request: Request, scope: string): boolean;
  export function hasVisitorCredential(request: Request, key: string): boolean;
  export function createAuthenticatedFetch(
    providerName: string,
  ): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
  export const secretHeaders: KodySecretHeadersRuntime;
  export function oauthClientCredentials(
    input: KodyOauthClientCredentialsInput,
  ): Promise<Record<string, unknown>>;
  export const packageContext: {
    packageId: string;
    kodyId: string;
    appBasePath?: string;
    hostedUrl?: string;
    cookiePrefix?: string;
    assetBasePath?: string;
    clientModuleUrl?: string | null;
  } | null;
  /** Always null leftover so old if (packages) guards keep bundling. */
  export const packages: null;
  export function packageStorage(): KodyStorageRuntime;
  export const email: KodyEmailRuntime;
  export const workflows: KodyWorkflowsRuntime;
  export const events: KodyEventsRuntime;
  /**
   * A client for one credential. It holds no value: \`fetch\` sends the
   * credential only to its hosts, and \`sign\` / \`callTool\` run on the host.
   */
  export type KodyCredentialClient = {
    readonly name: string;
    readonly scope: "org" | "personal";
    readonly kind: "secret" | "oauth" | "url" | "login" | "mcp" | "signing";
    readonly hosts: ReadonlyArray<string>;
    /** Set when an explicit pick has no provider and could resolve on its own. */
    readonly hint?: string;
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    sign?: (operation: Record<string, unknown>) => Promise<string>;
    callTool?: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  /**
   * Open the credential bound to a need declared in package.json
   * (\`kody.credentials\`). Rejects with an Error carrying \`code\`
   * (\`credential_unbound\`, \`credential_ambiguous\`, \`credential_denied\`, …)
   * and \`retryWith\`.
   */
  export const credential: ((key: string) => Promise<KodyCredentialClient>) & {
    /** Ad hoc code and unshared personal packages only. */
    named(
      name: string,
      options?: { scope?: "org" | "personal" | null },
    ): Promise<KodyCredentialClient>;
  };
  /**
   * Every credential the caller's \`credentials\` map picks for the key, or
   * the one match when it picks none.
   */
  export function credentials(key: string): Promise<Array<KodyCredentialClient>>;
  export const packageSecrets:
    | {
        /**
         * Opaque \`{{secret:name|scope=…}}\` placeholder after mount + grant
         * checks. Never decrypted plaintext — put the string in secret-aware
         * fetch / secretHeaders / secretJwtSign so the host resolves it.
         */
        get(alias: string): Promise<string>;
        has(alias: string): Promise<boolean>;
      }
    | null;
  /**
   * Optional request-context key. \`context.get(KodyRuntime)\` (Remix) or
   * any library that reads \`defaultValue\` the same way returns this
   * module's exports for the current request; no middleware is needed to
   * install it. Other entries import named exports from this module.
   */
  export const KodyRuntime: {
    readonly defaultValue: {
      kody: typeof kody;
      createAuthenticatedFetch: typeof createAuthenticatedFetch;
      secretHeaders: typeof secretHeaders;
      oauthClientCredentials: typeof oauthClientCredentials;
      credential: typeof credential;
      credentials: typeof credentials;
      packageContext: typeof packageContext;
      packages: typeof packages;
      packageStorage: typeof packageStorage;
      email: typeof email;
      workflows: typeof workflows;
      events: typeof events;
      packageSecrets: typeof packageSecrets;
    };
  };
}
`.trim()
}

export type PackageBundleTarget = {
	path: string
	bundleKind: 'app' | 'client' | 'callable' | 'importable'
}

/**
 * `callable` entrypoints (jobs, subscription handlers) are invoked
 * through their default export, so they must default export a function.
 * `module` entrypoints are `package.json#exports` modules, which may expose
 * only named exports.
 */
export type PackageTypecheckTarget = {
	path: string
	kind: 'callable' | 'module'
	emittedEventTopics: Array<string>
}

function buildBundleTargetKey(target: PackageBundleTarget) {
	return `${target.path}:${target.bundleKind}`
}

function compareBundleTargets(
	left: PackageBundleTarget,
	right: PackageBundleTarget,
) {
	return buildBundleTargetKey(left).localeCompare(buildBundleTargetKey(right))
}

function toPackageBundleKind(target: PublishedPackageArtifactBuildTarget) {
	switch (target.bundleKind) {
		case 'app':
			return 'app'
		case 'app-client':
			return 'client'
		case 'module':
			return 'callable'
		case 'importable-module':
			return 'importable'
		default: {
			const bundleKind: never = target.bundleKind
			void bundleKind
			throw new Error('Unhandled package artifact bundle kind.')
		}
	}
}

function collectPackageBundleTargets(manifest: AuthoredPackageJson) {
	const targets = new Map<string, PackageBundleTarget>()
	const remember = (
		path: string,
		bundleKind: PackageBundleTarget['bundleKind'],
	) => {
		const normalizedPath = normalizePackageWorkspacePath(path)
		targets.set(buildBundleTargetKey({ path: normalizedPath, bundleKind }), {
			path: normalizedPath,
			bundleKind,
		})
	}
	for (const target of collectPublishedPackageArtifactTargets(manifest)) {
		remember(target.entryPoint, toPackageBundleKind(target))
	}
	return Array.from(targets.values()).sort(compareBundleTargets)
}

function collectPackageTypecheckTargets(manifest: AuthoredPackageJson) {
	const targets = new Map<string, PackageTypecheckTarget>()
	const emittedEventTopics = Object.keys(manifest.kody.emits ?? {})
	const remember = (path: string, kind: PackageTypecheckTarget['kind']) => {
		const normalizedPath = normalizePackageWorkspacePath(path)
		const existing = targets.get(normalizedPath)
		if (existing && (existing.kind === 'callable' || kind === 'module')) {
			return
		}
		targets.set(normalizedPath, {
			path: normalizedPath,
			kind,
			emittedEventTopics,
		})
	}
	for (const job of Object.values(manifest.kody.jobs ?? {})) {
		remember(job.entry, 'callable')
	}
	for (const subscription of listPackageSubscriptions(manifest)) {
		remember(subscription.handler, 'callable')
	}
	for (const target of collectPublishedPackageArtifactTargets(manifest)) {
		if (target.bundleKind === 'importable-module') {
			remember(target.entryPoint, 'module')
		}
	}
	for (const exportTarget of Object.values(manifest.exports)) {
		// Declaration files are skipped by `skipLibCheck`, so only authored
		// TypeScript `types` targets add diagnostics.
		if (
			typeof exportTarget !== 'string' &&
			exportTarget.types &&
			!isTypeDeclarationFilePath(
				normalizePackageWorkspacePath(exportTarget.types),
			)
		) {
			remember(exportTarget.types, 'module')
		}
	}
	return Array.from(targets.values())
}

function parseDeclaredNpmDependencies(packageJsonContent: string | null) {
	if (!packageJsonContent) return []
	const parsed = JSON.parse(packageJsonContent) as {
		dependencies?: unknown
	}
	const dependencies = parsed.dependencies
	if (
		dependencies !== undefined &&
		(!dependencies ||
			typeof dependencies !== 'object' ||
			Array.isArray(dependencies))
	) {
		throw new Error('package.json dependencies must be an object when present.')
	}
	return Object.keys(dependencies ?? {}).sort((left, right) =>
		left.localeCompare(right),
	)
}

function pluralize(count: number, singular: string, plural: string) {
	return count === 1 ? singular : plural
}

function formatQuotedList(values: Array<string>) {
	return values.map((value) => `"${value}"`).join(', ')
}

function formatNpmDependencyCheckMessage(input: {
	packageJsonMissing: boolean
	dependencies: Array<string>
}) {
	if (input.packageJsonMissing) {
		return 'No package.json found in source root; dependency check skipped.'
	}
	if (input.dependencies.length === 0) {
		return 'package.json declares no npm dependencies.'
	}
	return `package.json declares ${input.dependencies.length} npm ${pluralize(
		input.dependencies.length,
		'dependency',
		'dependencies',
	)}: ${formatQuotedList(input.dependencies)}.`
}

function getDeclaredStaticKodyPackageDependencies(
	manifest: AuthoredPackageJson,
) {
	return listKodyPackageDependencyNames(manifest.kody.dependencies)
}

function getImportedStaticKodyPackageDependencies(input: {
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}) {
	return Array.from(
		new Set(
			collectStaticKodyPackageImportsFromFiles(input.sourceFiles)
				.map((imported) => imported.packageName)
				.filter((packageName) => packageName !== input.manifest.name),
		),
	).sort((left, right) => left.localeCompare(right))
}

function validateStaticKodyPackageDependencyDeclarations(input: {
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}) {
	const declared = getDeclaredStaticKodyPackageDependencies(input.manifest)
	const imported = getImportedStaticKodyPackageDependencies(input)
	const missing = imported.filter(
		(packageName) => !declared.includes(packageName),
	)
	const unused = declared.filter(
		(packageName) => !imported.includes(packageName),
	)
	if (missing.length === 0 && unused.length === 0) {
		return {
			ok: true,
			message:
				declared.length === 0
					? 'package.json#kody.dependencies declares no static Kody package dependencies.'
					: `package.json#kody.dependencies declares ${declared.length} static Kody package ${pluralize(
							declared.length,
							'dependency',
							'dependencies',
						)}: ${formatQuotedList(declared)}.`,
		}
	}
	const details = [
		missing.length > 0 ? `missing ${formatQuotedList(missing)}` : null,
		unused.length > 0 ? `unused ${formatQuotedList(unused)}` : null,
	].filter((detail): detail is string => detail != null)
	return {
		ok: false,
		message: `package.json#kody.dependencies must match direct static kody:@ imports (${details.join('; ')}).`,
	}
}

export async function validatePackageBundles(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoints: Array<PackageBundleTarget>
}) {
	const failures: Array<string> = []
	for (const target of input.entryPoints) {
		try {
			if (target.bundleKind === 'app') {
				await buildKodyAppBundle({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint: target.path,
					cacheKey: null,
				})
			} else if (target.bundleKind === 'client') {
				await buildKodyAppClientBundle({
					sourceFiles: input.sourceFiles,
					entryPoint: target.path,
				})
			} else if (target.bundleKind === 'callable') {
				await buildKodyModuleBundle({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint: target.path,
				})
			} else if (target.bundleKind === 'importable') {
				await buildKodyImportableModuleBundle({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint: target.path,
				})
			} else {
				const exhaustive: never = target.bundleKind
				throw new Error(`Unsupported package bundle target kind: ${exhaustive}`)
			}
		} catch (error) {
			failures.push(`${target.path}: ${getErrorMessage(error)}`)
		}
	}
	return {
		ok: failures.length === 0,
		message:
			failures.length === 0
				? `Bundled ${input.entryPoints.length} package target(s) successfully.`
				: failures.join('\n'),
	}
}

const typecheckableSourceFilePattern = /\.(?:[cm]?ts|tsx)$/

/**
 * The check filesystem has no `node_modules`, so bare specifiers (npm
 * packages, `remix/*`, `kody:@scope/package`) never resolve to types. Those
 * imports degrade to `any` instead of failing the check; bundling still
 * verifies that they resolve.
 */
const unresolvedModuleDiagnosticCodes = new Set([2307, 2580, 2591, 2792, 7016])
const missingJsxRuntimeTypesDiagnosticCodes = new Set([2875, 7026])

function readDiagnosticModuleSpecifier(diagnostic: TypecheckDiagnostic) {
	const text = diagnostic.file?.text
	if (
		typeof text !== 'string' ||
		typeof diagnostic.start !== 'number' ||
		typeof diagnostic.length !== 'number'
	) {
		return null
	}
	const quoted = /^(['"`])(.*)\1$/.exec(
		text.slice(diagnostic.start, diagnostic.start + diagnostic.length),
	)
	return quoted ? quoted[2]! : null
}

function isUnavailablePackageTypesDiagnostic(diagnostic: TypecheckDiagnostic) {
	if (diagnostic.code == null) return false
	if (missingJsxRuntimeTypesDiagnosticCodes.has(diagnostic.code)) return true
	if (!unresolvedModuleDiagnosticCodes.has(diagnostic.code)) return false
	const specifier = readDiagnosticModuleSpecifier(diagnostic)
	return (
		specifier != null &&
		!specifier.startsWith('.') &&
		!specifier.startsWith('/')
	)
}

function collectReachableTypecheckSourceFiles(input: {
	sourceFiles: Record<string, string>
	targets: Array<PackageTypecheckTarget>
}) {
	const rootPackage = readRootPackage(input.sourceFiles)
	const paths = new Set<string>()
	for (const target of input.targets) {
		for (const path of collectReachableSourceFilePaths({
			files: input.sourceFiles,
			entryPoint: target.path,
			rootPackage,
			includeTypeOnly: true,
		})) {
			if (typecheckableSourceFilePattern.test(path)) paths.add(path)
		}
	}
	return Array.from(paths).sort((left, right) => left.localeCompare(right))
}

/**
 * Without a package tsconfig.json, publish checks only the callable
 * default-export contract. Existing packages were published without source
 * diagnostics and Kody's ambient types (`kody:runtime` results are `unknown`,
 * no Node built-in types) would fail most of them, so full source typecheck
 * is opted into by shipping the tsconfig the author's editor already uses.
 */
const sourceFilesNotTypecheckedMessage =
	'Package source files, including package.json exports, are not typechecked: add a root tsconfig.json to typecheck every TypeScript file reachable from exports, jobs, and subscription handlers.'

function getPackageTypecheckDiagnostics(input: {
	targets: Array<PackageTypecheckTarget>
	/**
	 * When present, diagnostics inside these files are reported too. Only
	 * publish (and `kody dev check`) typechecks; runtime rebuilds of
	 * already-published source never do (see published-entrypoint-checks.ts),
	 * so no check here can break a published package retroactively.
	 */
	reachableSourceFilePaths?: Array<string>
	languageService: {
		getSemanticDiagnostics(path: string): Array<TypecheckDiagnostic>
	}
	fileSystem: {
		write(path: string, content: string): void
	}
}): Array<{
	fileName: string
	diagnostics: Array<TypecheckDiagnostic>
}> {
	const writePrelude = (emittedEventTopics: Array<string>) =>
		input.fileSystem.write(
			executeTypecheckPreludePath,
			createExecuteTypecheckPrelude({ emittedEventTopics }),
		)
	const results: Array<{
		fileName: string
		diagnostics: Array<TypecheckDiagnostic>
	}> = []
	const callableTargets = input.targets.filter(
		(target) => target.kind !== 'module',
	)
	if (callableTargets.length > 0) {
		const entryPoints = callableTargets.map((target) => target.path)
		writePrelude(callableTargets[0]!.emittedEventTopics)
		const harnessSource = createRepoCapabilitiesModuleTypecheckHarness({
			entryPoints,
		})
		input.fileSystem.write(
			repoCapabilitiesModuleTypecheckHarnessPath,
			harnessSource,
		)
		const lineToEntryPoint = mapRepoCapabilitiesModuleTypecheckHarnessLines({
			entryPoints,
		})
		const harnessDiagnostics = input.languageService.getSemanticDiagnostics(
			repoCapabilitiesModuleTypecheckHarnessPath,
		)
		const diagnosticsByEntryPoint = new Map<
			string,
			Array<TypecheckDiagnostic>
		>()
		for (const entryPoint of entryPoints) {
			diagnosticsByEntryPoint.set(entryPoint, [])
		}
		for (const diagnostic of harnessDiagnostics) {
			const attributedPath = attributeTypecheckDiagnosticToEntryPoint({
				diagnostic,
				entryPoints,
				lineToEntryPoint,
			})
			const bucket =
				diagnosticsByEntryPoint.get(attributedPath) ??
				diagnosticsByEntryPoint.get(entryPoints[0]!)
			bucket?.push(diagnostic)
		}
		for (const target of callableTargets) {
			results.push({
				fileName: target.path,
				diagnostics: diagnosticsByEntryPoint.get(target.path) ?? [],
			})
		}
	}
	if (!input.reachableSourceFilePaths) return results
	writePrelude(input.targets.flatMap((target) => target.emittedEventTopics))
	for (const path of input.reachableSourceFilePaths) {
		results.push({
			fileName: path,
			diagnostics: input.languageService
				.getSemanticDiagnostics(path)
				.filter(
					(diagnostic) => !isUnavailablePackageTypesDiagnostic(diagnostic),
				),
		})
	}
	return results
}

function attributeTypecheckDiagnosticToEntryPoint(input: {
	diagnostic: TypecheckDiagnostic
	entryPoints: ReadonlyArray<string>
	lineToEntryPoint: Map<number, string>
}) {
	const diagnosticFileName =
		typeof input.diagnostic.file?.fileName === 'string'
			? input.diagnostic.file.fileName.replace(/\\/g, '/')
			: null
	if (diagnosticFileName) {
		const matchingEntry = input.entryPoints.find(
			(entryPoint) =>
				diagnosticFileName === entryPoint ||
				diagnosticFileName.endsWith(`/${entryPoint}`),
		)
		if (matchingEntry) return matchingEntry
	}
	if (
		diagnosticFileName?.endsWith(repoCapabilitiesModuleTypecheckHarnessPath) ||
		diagnosticFileName === repoCapabilitiesModuleTypecheckHarnessPath ||
		diagnosticFileName == null
	) {
		if (typeof input.diagnostic.start === 'number' && input.diagnostic.file) {
			const { line } = input.diagnostic.file.getLineAndCharacterOfPosition(
				input.diagnostic.start,
			)
			const fromLine = input.lineToEntryPoint.get(line)
			if (fromLine) return fromLine
		}
	}
	return input.entryPoints[0]!
}

function formatPackageTypecheckDiagnostics(
	diagnostics: ReturnType<typeof getPackageTypecheckDiagnostics>,
) {
	return diagnostics.flatMap(({ fileName, diagnostics: fileDiagnostics }) =>
		formatTypecheckDiagnostics(fileName, fileDiagnostics),
	)
}

function formatBundleCheckMessage(input: {
	missingEntryPoints: Array<string>
	targetCount: number
}) {
	if (input.missingEntryPoints.length > 0) {
		return `Package bundle target(s) missing from the repo session snapshot: ${input.missingEntryPoints
			.map((path) => `"${path}"`)
			.join(', ')}.`
	}
	if (input.targetCount === 0) {
		return 'Package defines no app entry, exports, jobs, or subscriptions to bundle.'
	}
	return `Resolved ${input.targetCount} package target(s) for bundling.`
}

/**
 * Bundle-check message when publish will rebuild the same callable /
 * importable / app targets as published artifacts. Check-time esbuild is
 * skipped so a multi-export publish does not pay for bundling twice.
 */
const deferredBundleCheckMessage =
	'Bundle validation deferred to published artifact rebuild.'

const lintPlaceholderPassedMessage = 'Lint placeholder passed for this phase.'
const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const maxAmbientStorageReportedFiles = 5

function moduleImportsAmbientStorage(source: string) {
	let parsed: ModuleAstNode
	try {
		parsed = parseModuleSource(source) as unknown as ModuleAstNode
	} catch {
		return false
	}
	const program = parsed.program as { body?: Array<ModuleAstNode> } | undefined
	const body =
		program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
	if (!Array.isArray(body)) return false
	for (const node of body) {
		if (node?.type !== 'ImportDeclaration') continue
		if ((node as { importKind?: unknown }).importKind === 'type') continue
		const specifier = (node as { source?: { value?: unknown } }).source?.value
		if (specifier !== 'kody:runtime') continue
		const specifiers = (node as { specifiers?: unknown }).specifiers
		if (!Array.isArray(specifiers)) continue
		for (const importSpecifier of specifiers) {
			const typedSpecifier = importSpecifier as {
				type?: string
				importKind?: unknown
				imported?: { name?: unknown; value?: unknown }
			}
			if (typedSpecifier.type !== 'ImportSpecifier') continue
			if (typedSpecifier.importKind === 'type') continue
			const importedName =
				typeof typedSpecifier.imported?.name === 'string'
					? typedSpecifier.imported.name
					: typeof typedSpecifier.imported?.value === 'string'
						? typedSpecifier.imported.value
						: null
			if (importedName === 'storage') return true
		}
	}
	return false
}

export function collectAmbientStorageImportFiles(
	sourceFiles: Record<string, string>,
) {
	const filePaths: Array<string> = []
	for (const [filePath, source] of Object.entries(sourceFiles)) {
		if (!scannableModuleFilePattern.test(filePath)) continue
		if (isTypeDeclarationFilePath(filePath)) continue
		if (!source.includes('kody:runtime')) continue
		if (moduleImportsAmbientStorage(source)) {
			filePaths.push(filePath)
		}
	}
	return filePaths.sort((left, right) => left.localeCompare(right))
}

/**
 * Storage prescription lint rule (failing): saved-package source must use
 * `packageStorage()` instead of the removed ambient `storage` binding.
 * This only runs where repo checks run — new session check runs,
 * session/external publishes, and community fork installs — so
 * already-published artifacts are never re-validated retroactively.
 * This permanent publish guard keeps package code portable across every
 * package surface and points authors at the canonical package bucket.
 */
function buildLintCheck(sourceFiles: Record<string, string>): {
	ok: boolean
	message: string
} {
	// Permanent authoring guard: unsupported invocation forms fail every
	// publish with the replacement named. Runtime teaching errors provide the
	// same guidance when these forms reach execution.
	const removedUsageFailure = formatRemovedInvocationUsageFailure(
		collectDeprecatedInvocationUsage(sourceFiles),
	)
	if (removedUsageFailure) {
		return { ok: false, message: removedUsageFailure }
	}
	const ambientStorageFiles = collectAmbientStorageImportFiles(sourceFiles)
	if (ambientStorageFiles.length === 0) {
		return { ok: true, message: lintPlaceholderPassedMessage }
	}
	const shownFiles = ambientStorageFiles.slice(
		0,
		maxAmbientStorageReportedFiles,
	)
	const hiddenCount = ambientStorageFiles.length - shownFiles.length
	const fileList =
		shownFiles.map((filePath) => `"${filePath}"`).join(', ') +
		(hiddenCount > 0 ? ` (and ${hiddenCount} more)` : '')
	return {
		ok: false,
		message:
			`Package code imports the ambient \`storage\` helper from 'kody:runtime': ${fileList}. ` +
			"Use `packageStorage()` from 'kody:runtime' for package-owned data instead: it reaches the identical " +
			"bucket in the package's own runtime and keeps working when the code is statically imported into " +
			'another context. Ambient `storage` is not a kody:runtime export.',
	}
}

/**
 * The expensive half of the typecheck check: a TypeScript language service
 * over the full source snapshot. Exported so throwaway check-phase isolates
 * can run it against KV-staged source files (see isolated-check-phases.ts).
 */
export async function runPackageTypecheckLanguageService(input: {
	sourceFiles: Record<string, string>
	targets: Array<PackageTypecheckTarget>
}): Promise<{ ok: boolean; message: string }> {
	const { createFileSystemSnapshot } = await loadWorkerBundlerSnapshotTools()
	const snapshot = await createFileSystemSnapshot(
		(async function* () {
			for (const [path, content] of Object.entries(input.sourceFiles)) {
				yield [path, content] as const
			}
		})(),
	)
	const typecheckFileSystem = createRepoChecksFileSystem({
		fileSystem: snapshot,
	})
	const baseTsconfig = snapshot.read(repoChecksSyntheticTsconfigPath)
	if (baseTsconfig != null) {
		typecheckFileSystem.write(
			repoChecksSyntheticTsconfigExtendsPath.slice('./'.length),
			baseTsconfig,
		)
	}
	typecheckFileSystem.write(
		repoChecksSyntheticTsconfigPath,
		buildRepoChecksTsconfig(baseTsconfig),
	)
	const created = await createRepoChecksTypescriptLanguageService({
		fileSystem: typecheckFileSystem,
	})
	if (!created.ok) {
		return created
	}
	const { fileSystem, languageService } = created
	try {
		const reachableSourceFilePaths =
			baseTsconfig == null
				? undefined
				: collectReachableTypecheckSourceFiles({
						sourceFiles: input.sourceFiles,
						targets: input.targets,
					})
		const diagnostics = getPackageTypecheckDiagnostics({
			targets: input.targets,
			reachableSourceFilePaths,
			languageService,
			fileSystem,
		})
		const ok = diagnostics.every((entry) => entry.diagnostics.length === 0)
		if (!ok) {
			return {
				ok,
				message: formatPackageTypecheckDiagnostics(diagnostics).join('\n'),
			}
		}
		return {
			ok,
			message: reachableSourceFilePaths
				? `No semantic diagnostics for ${input.targets.length} package runtime entrypoint(s) across ${reachableSourceFilePaths.length} reachable source file(s).`
				: `Default exports of ${input.targets.length} callable package runtime entrypoint(s) type-check as invocable functions. ${sourceFilesNotTypecheckedMessage}`,
		}
	} finally {
		// Release the compiler program before anything else allocates.
		languageService.dispose()
	}
}

async function mapPool<T, R>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<Array<R>> {
	if (items.length === 0) return []
	const limit = Math.max(1, Math.min(concurrency, items.length))
	const results: Array<R> = []
	let nextIndex = 0
	let firstError: unknown
	async function worker() {
		while (nextIndex < items.length) {
			const index = nextIndex
			nextIndex += 1
			const item = items[index]
			if (item === undefined) return
			try {
				results[index] = await mapper(item)
			} catch (error) {
				firstError ??= error
			}
		}
	}
	await Promise.all(Array.from({ length: limit }, () => worker()))
	if (firstError !== undefined) throw firstError
	return results
}

async function runChunkedBundleValidation(input: {
	runner: IsolatedCheckPhaseRunner
	stagingKey: string
	baseUrl: string
	userId: string
	entryPoints: Array<PackageBundleTarget>
}) {
	const chunks: Array<Array<PackageBundleTarget>> = []
	for (
		let start = 0;
		start < input.entryPoints.length;
		start += isolatedBundleChunkSize
	) {
		chunks.push(input.entryPoints.slice(start, start + isolatedBundleChunkSize))
	}
	// Each chunk runs in its own throwaway isolate. Cap how many of those
	// isolates one check request starts together so a many-export package
	// cannot stampede Durable Object capacity.
	const outcomes = await mapPool(
		chunks,
		isolatedBundleChunkConcurrency,
		(bundleTargets) =>
			input.runner.run({
				phase: 'bundle-chunk',
				stagingKey: input.stagingKey,
				baseUrl: input.baseUrl,
				userId: input.userId,
				bundleTargets,
			}),
	)
	const failures = outcomes
		.filter((outcome) => !outcome.ok)
		.map((outcome) => outcome.message)
	return {
		ok: failures.length === 0,
		message:
			failures.length === 0
				? `Bundled ${input.entryPoints.length} package target(s) successfully.`
				: failures.join('\n'),
	}
}

/**
 * `kody.credentials` needs (ADR 0068): a key the package and a dependency
 * declare with a different kind or provider fails; keys that are not
 * provider slugs get an informational note. Null when there is nothing to
 * say. Without env (offline checks) only the package's own needs are read.
 */
async function buildCredentialNeedsCheck(input: {
	env?: Env
	userId?: string
	sourceId?: string
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}): Promise<RepoCheckResult | null> {
	const notes = credentialNeedKeyNotes(input.manifest.kody.credentials)
	let conflicts: Array<string> = []
	if (input.env && input.userId) {
		try {
			const closure = await computeCredentialNeedsClosure({
				env: input.env,
				userId: input.userId,
				manifest: input.manifest,
				files: input.sourceFiles,
			})
			conflicts = closure.conflicts
			const republished =
				conflicts.length === 0
					? await republishedNeedsNote({
							env: input.env,
							userId: input.userId,
							sourceId: input.sourceId ?? null,
							packageName: input.manifest.name,
							needs: closure.needs,
						})
					: null
			if (republished) notes.push(republished)
		} catch (error) {
			// A lookup failure is not a conflict: note it and let publish go on.
			notes.push(
				`Dependency credential needs were not checked: ${getErrorMessage(error)}`,
			)
		}
	}
	if (conflicts.length > 0) {
		return {
			kind: 'manifest',
			ok: false,
			message: [
				'kody.credentials needs conflict with a dependency:',
				...conflicts,
			].join('\n'),
		}
	}
	if (notes.length === 0) return null
	return {
		kind: 'manifest',
		ok: true,
		message: ['kody.credentials notes (publish is unaffected):', ...notes].join(
			'\n',
		),
	}
}

export async function runRepoChecks(input: {
	workspace: {
		readFile(path: string): Promise<string | null>
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
		/**
		 * Optional true byte size. When present (the real @cloudflare/shell
		 * workspace), per-file size checks use it so binary files are measured
		 * exactly instead of via lossy UTF-8 round-tripping.
		 */
		stat?(path: string): Promise<{ size: number } | null>
	}
	manifestPath: string
	sourceRoot: string
	env?: Env
	baseUrl?: string
	userId?: string
	/** The entity source being published, when there is one. */
	sourceId?: string
	expectedPackageScope?: string
	phaseTimings?: PublishPhaseTimings
	/**
	 * Skip full esbuild validation when the caller is about to rebuild the
	 * same published artifact targets. Missing entrypoints still fail. The
	 * `checks/bundle` timer is omitted. Rebuild failure must surface as a
	 * bundle `checks_failed` result.
	 */
	deferBundleCheckToRebuild?: boolean
	/**
	 * Publish and `repoRunChecks` require non-empty root README.md +
	 * AGENTS.md. Community install and platform codemods skip this so
	 * existing listings stay forkable and migratable.
	 */
	requirePackageDocs?: boolean
	/**
	 * When false, credential-stamp gate findings stay informational and do
	 * not fail `runRepoChecks` early. Community install and platform
	 * codemods pass false so legacy packages remain forkable and migratable
	 * until phase 2/3 of #3836. Omit (default true) for authoring publish.
	 */
	enforceCredentialStamp?: boolean
}): Promise<RepoCheckRunResult> {
	const manifestContent = await input.workspace.readFile(input.manifestPath)
	if (manifestContent == null) {
		// Caller-authored source mistake (missing package.json). Return a failed
		// check instead of throwing so MCP publish surfaces checks_failed and
		// does not open a Sentry "platform bug" issue.
		return {
			ok: false,
			results: [
				{
					kind: 'manifest',
					ok: false,
					message: `Manifest "${input.manifestPath}" was not found.`,
				},
			],
			manifest: null,
			sourceFiles: {},
		}
	}
	let manifest: AuthoredPackageJson
	try {
		manifest = parseAuthoredPackageJson({
			content: manifestContent,
			manifestPath: input.manifestPath,
			expectedPackageScope: input.expectedPackageScope,
		})
		assertKodyDescriptionLength(manifest.kody.description)
	} catch (error) {
		// Invalid package.json shape (e.g. kody.dependencies values other than
		// "*") is a caller fix — keep it on the check result path, not as an
		// exception.
		return {
			ok: false,
			results: [
				{
					kind: 'manifest',
					ok: false,
					message: getErrorMessage(error),
				},
			],
			manifest: null,
			sourceFiles: {},
		}
	}
	const results: Array<RepoCheckResult> = [
		{
			kind: 'manifest',
			ok: true,
			message: `Validated ${input.manifestPath}.`,
		},
	]

	const sourceRoot = normalizeRepoWorkspacePath(input.sourceRoot).replace(
		/\/+$/,
		'',
	)
	const sourceWalk = await (async () => {
		const collected: Record<string, string> = {}
		let fileCount = 0
		let totalBytes = 0
		for await (const [path, content, fileBytes] of workspaceFilesForSnapshot({
			workspace: input.workspace,
			root: sourceRoot,
		})) {
			fileCount += 1
			if (fileCount > repoChecksSourceMaxFiles) {
				return {
					ok: false as const,
					message: `Repo checks aborted: source root "${sourceRoot || '/'}" contains more than the ${repoChecksSourceMaxFiles}-file publish check limit. Remove files that should not be published (for example build output, vendored dependencies, or data files) and run the checks again.`,
				}
			}
			if (fileBytes > maxRepoSourceFileBytes) {
				return {
					ok: false as const,
					message: `Repo checks aborted: ${buildRepoLargeFileMessage({
						path,
						byteLength: fileBytes,
					})}`,
				}
			}
			totalBytes += fileBytes
			if (totalBytes > repoChecksSourceMaxTotalBytes) {
				return {
					ok: false as const,
					message: `Repo checks aborted: source root "${sourceRoot || '/'}" exceeds the ${repoChecksSourceMaxTotalBytes}-byte (${Math.round(repoChecksSourceMaxTotalBytes / (1024 * 1024))} MiB) publish check limit. Remove or shrink large files that should not be published (for example build output, vendored dependencies, or data files) and run the checks again.`,
				}
			}
			collected[path] = content
		}
		return {
			ok: true as const,
			collected,
		}
	})()
	if (!sourceWalk.ok) {
		results.push({
			kind: 'bundle',
			ok: false,
			message: sourceWalk.message,
		})
		return toRepoCheckRunResult({
			results,
			manifest,
			sourceFiles: {},
		})
	}
	let sourceFiles = sourceWalk.collected
	// Before any gate that returns early, so owners see it while fixing others.
	// May auto-write missing kody.credentials keys into sourceFiles (never
	// overwrites descriptions). Hard-fails on unstampable patterns / server eval
	// / missing descriptions (issue #3836 phase 1) unless the caller opts out
	// (community install / platform codemods).
	const credentialPatternCheck = buildCredentialPatternCheck(sourceFiles, {
		secretProviders:
			input.env && input.userId
				? await resolveSecretProviderSlots({
						env: input.env,
						userId: input.userId,
						files: sourceFiles,
					})
				: undefined,
	})
	sourceFiles = credentialPatternCheck.sourceFiles
	const enforceCredentialStamp = input.enforceCredentialStamp !== false
	const credentialCheckOk = enforceCredentialStamp
		? credentialPatternCheck.ok
		: true
	const credentialCheckMessage =
		!enforceCredentialStamp && !credentialPatternCheck.ok
			? credentialPatternCheck.message
					.replace(
						/^Credential stamp publish gate \(issue #3836 phase 1\):/,
						'Credential stamp notes (informational; enforceCredentialStamp=false):',
					)
					.replace(
						/^Publish failed\. ?/m,
						'Stamp findings below do not fail this check (community install / platform codemod lane). Authoring publish still enforces the gate.\n',
					)
			: credentialPatternCheck.message
	const fetchBodyWarning = credentialCheckOk
		? fetchBodySecretResolutionNotice(sourceFiles)
		: null
	results.push({
		kind: credentialPatternCheck.kind,
		ok: credentialCheckOk,
		message: fetchBodyWarning
			? `${credentialCheckMessage}\n\n${fetchBodyWarning}`
			: credentialCheckMessage,
	})
	if (enforceCredentialStamp && !credentialPatternCheck.ok) {
		return toRepoCheckRunResult({ results, manifest, sourceFiles })
	}
	const credentialNeedsCheck = await buildCredentialNeedsCheck({
		env: input.env,
		userId: input.userId,
		...(input.sourceId ? { sourceId: input.sourceId } : {}),
		manifest,
		sourceFiles,
	})
	if (credentialNeedsCheck) {
		results.push(credentialNeedsCheck)
		if (!credentialNeedsCheck.ok) {
			return toRepoCheckRunResult({ results, manifest, sourceFiles })
		}
	}
	// Cheap static gates for the package-app browser surface run before the
	// heavy phases so a misconfigured manifest fails fast with one message.
	const packageAppSurfaceChecks = [
		validatePackageAppAssetsDirectory({
			assetsDirectory: getPackageAppAssetsDirectory(manifest),
			sourceFiles,
			clientDeclared: getPackageAppClientEntryPath(manifest) !== null,
		}),
		validatePackageAppGraphSeparation({ manifest, sourceFiles }),
	]
	const failedPackageAppSurfaceCheck = packageAppSurfaceChecks.find(
		(check) => !check.ok,
	)
	if (failedPackageAppSurfaceCheck) {
		results.push({
			kind: 'bundle',
			ok: false,
			message: failedPackageAppSurfaceCheck.message,
		})
		return toRepoCheckRunResult({
			results,
			manifest,
			sourceFiles,
		})
	}
	if (input.requirePackageDocs !== false) {
		const docsCheck = validateRequiredPackageDocs(sourceFiles)
		results.push({
			kind: 'docs',
			ok: docsCheck.ok,
			message: docsCheck.message,
		})
		if (!docsCheck.ok) {
			return toRepoCheckRunResult({
				results,
				manifest,
				sourceFiles,
			})
		}
	}
	const skillsCheck = await validatePackageSkills({
		files: sourceFiles,
		kodyId: manifest.name,
	})
	results.push({
		kind: 'skills',
		ok: skillsCheck.ok,
		message: skillsCheck.message,
	})
	if (!skillsCheck.ok) {
		return toRepoCheckRunResult({
			results,
			manifest,
			sourceFiles,
		})
	}
	const lintCheck = buildLintCheck(sourceFiles)
	const { createFileSystemSnapshot } = await loadWorkerBundlerSnapshotTools()
	const snapshot = await createFileSystemSnapshot(
		(async function* () {
			for (const [path, content] of Object.entries(sourceFiles)) {
				yield [path, content] as const
			}
		})(),
	)

	const packageJson = snapshot.read('package.json')
	const declaredNpmDependencies = parseDeclaredNpmDependencies(packageJson)
	const staticKodyDependencyCheck =
		validateStaticKodyPackageDependencyDeclarations({
			manifest,
			sourceFiles,
		})
	let staticKodyDependencyMessage = staticKodyDependencyCheck.message
	let staticKodyDependencyOk = staticKodyDependencyCheck.ok
	if (
		staticKodyDependencyOk &&
		input.env &&
		input.userId &&
		getDeclaredStaticKodyPackageDependencies(manifest).length > 0
	) {
		const graph = await loadReachableStaticKodyDependencyEdges({
			env: input.env,
			baseUrl: input.baseUrl ?? input.sourceRoot,
			userId: input.userId,
			rootPackageName: manifest.name,
			rootDependencies: getDeclaredStaticKodyPackageDependencies(manifest),
		})
		if (!graph.ok) {
			staticKodyDependencyOk = false
			staticKodyDependencyMessage = graph.message
		} else {
			const cycle = findStaticKodyDependencyCycle({
				rootPackageName: manifest.name,
				edges: graph.edges,
			})
			if (cycle) {
				staticKodyDependencyOk = false
				staticKodyDependencyMessage =
					formatStaticKodyDependencyCycleMessage(cycle)
			}
		}
	}
	const bundleTargets = collectPackageBundleTargets(manifest)
	const barePackageImportCheck = validateBarePackageImportDeclarations({
		manifest,
		sourceFiles,
		entryPoints: bundleTargets,
		declaredDependencies: declaredNpmDependencies,
	})
	results.push({
		kind: 'dependencies',
		ok: staticKodyDependencyOk && barePackageImportCheck.ok,
		message: [
			formatNpmDependencyCheckMessage({
				packageJsonMissing: packageJson == null,
				dependencies: declaredNpmDependencies,
			}),
			staticKodyDependencyMessage,
			barePackageImportCheck.message,
		].join(' '),
	})

	const packageTypecheckTargets = collectPackageTypecheckTargets(manifest)
	const typecheckTargets =
		snapshot.read(repoChecksSyntheticTsconfigPath) == null
			? packageTypecheckTargets.filter((target) => target.kind === 'callable')
			: packageTypecheckTargets
	const missingBundleTargets = [
		...new Set(
			bundleTargets
				.map((target) => target.path)
				.filter((path) => snapshot.read(path) == null),
		),
	]
	const missingTypecheckTargets = [
		...new Set(
			typecheckTargets
				.map((target) => target.path)
				.filter((path) => snapshot.read(path) == null),
		),
	]
	const bundleContext =
		input.env && input.userId
			? {
					env: input.env,
					baseUrl: input.baseUrl ?? input.sourceRoot,
					userId: input.userId,
				}
			: null
	// Heavy phases (TypeScript language service, esbuild-wasm bundling) run
	// in fresh throwaway isolates whenever the env carries the bindings for
	// it: one large package could otherwise push this isolate (session
	// workspace + git state + checks) over the Durable Object memory limit
	// and kill every publish attempt (kody-hq/kody#987). Without the
	// bindings (unit tests, minimal envs) the phases run inline; typecheck
	// then runs BEFORE bundling so its disposable heap never stacks on top
	// of esbuild-wasm memory, which stays resident once grown. The reported
	// `results` order is unchanged: bundle before typecheck.
	const isolatedRunner = bundleContext
		? createIsolatedCheckPhaseRunner(bundleContext.env)
		: null
	const wantsLanguageServiceTypecheck =
		missingTypecheckTargets.length === 0 && typecheckTargets.length > 0
	const wantsFullBundleValidation =
		input.deferBundleCheckToRebuild !== true &&
		bundleContext !== null &&
		missingBundleTargets.length === 0 &&
		bundleTargets.length > 0
	const stagingKey =
		isolatedRunner &&
		bundleContext &&
		(wantsLanguageServiceTypecheck || wantsFullBundleValidation)
			? await isolatedRunner.stage({
					userId: bundleContext.userId,
					sourceFiles,
				})
			: null

	let typecheckResult: RepoCheckResult
	let bundleCheckResult: { ok: boolean; message: string }
	try {
		const runTypecheckPhase = async (): Promise<RepoCheckResult> => {
			const { value } = await timePublishExternalPushPhase(
				{ phase: 'checks/typecheck', timings: input.phaseTimings },
				async () => {
					if (missingTypecheckTargets.length > 0) {
						return {
							kind: 'typecheck' as const,
							ok: false,
							message: `Typecheck skipped because package runtime entrypoint(s) are missing from the repo session snapshot: ${missingTypecheckTargets
								.map((path) => `"${path}"`)
								.join(', ')}.`,
						}
					}
					const callableTargetsMissingDefaultExport =
						collectEntrypointsMissingDefaultExport({
							snapshot,
							targets: typecheckTargets.filter(
								(target) => target.kind === 'callable',
							),
						})
					if (callableTargetsMissingDefaultExport.length > 0) {
						return {
							kind: 'typecheck' as const,
							ok: false,
							message: formatMissingDefaultExportMessage(
								callableTargetsMissingDefaultExport,
							),
						}
					}
					if (typecheckTargets.length === 0) {
						return {
							kind: 'typecheck' as const,
							ok: true,
							message:
								packageTypecheckTargets.length === 0
									? 'No package runtime entrypoint(s) to typecheck.'
									: sourceFilesNotTypecheckedMessage,
						}
					}
					const outcome =
						isolatedRunner && stagingKey && bundleContext
							? await isolatedRunner.run({
									phase: 'typecheck',
									stagingKey,
									userId: bundleContext.userId,
									typecheckTargets,
								})
							: await runPackageTypecheckLanguageService({
									sourceFiles,
									targets: typecheckTargets,
								})
					return { kind: 'typecheck' as const, ...outcome }
				},
			)
			return value
		}

		const cheapBundleCheckResult = (): {
			ok: boolean
			message: string
		} => {
			if (missingBundleTargets.length > 0) {
				return {
					ok: false,
					message: formatBundleCheckMessage({
						missingEntryPoints: missingBundleTargets,
						targetCount: bundleTargets.length,
					}),
				}
			}
			if (
				input.deferBundleCheckToRebuild === true &&
				bundleTargets.length > 0
			) {
				return {
					ok: true,
					message: deferredBundleCheckMessage,
				}
			}
			return {
				ok: true,
				message: formatBundleCheckMessage({
					missingEntryPoints: missingBundleTargets,
					targetCount: bundleTargets.length,
				}),
			}
		}

		const runBundlePhase = async (): Promise<{
			ok: boolean
			message: string
		}> => {
			if (input.deferBundleCheckToRebuild === true) {
				return cheapBundleCheckResult()
			}
			const { value } = await timePublishExternalPushPhase(
				{ phase: 'checks/bundle', timings: input.phaseTimings },
				async () => {
					if (missingBundleTargets.length > 0) {
						return cheapBundleCheckResult()
					}
					if (!bundleContext) {
						return cheapBundleCheckResult()
					}
					if (isolatedRunner && stagingKey) {
						return await runChunkedBundleValidation({
							runner: isolatedRunner,
							stagingKey,
							baseUrl: bundleContext.baseUrl,
							userId: bundleContext.userId,
							entryPoints: bundleTargets,
						})
					}
					return await validatePackageBundles({
						...bundleContext,
						sourceFiles,
						entryPoints: bundleTargets,
					})
				},
			)
			return value
		}

		// Isolated phases use separate throwaway isolates, so overlapping them
		// (and overlapping bundle chunks) does not stack DO heap the way the
		// inline fallback would. Keep the inline path sequential: typecheck
		// first so its disposable heap never sits on top of resident
		// esbuild-wasm memory. When bundle validation is deferred to rebuild,
		// do not start bundle-chunk isolates or time checks/bundle.
		if (isolatedRunner && stagingKey && wantsFullBundleValidation) {
			const typecheckPromise = runTypecheckPhase()
			const bundlePromise = runBundlePhase()
			const [typecheckSettled, bundleSettled] = await Promise.allSettled([
				typecheckPromise,
				bundlePromise,
			])
			if (typecheckSettled.status === 'rejected') {
				throw typecheckSettled.reason
			}
			if (bundleSettled.status === 'rejected') {
				throw bundleSettled.reason
			}
			typecheckResult = typecheckSettled.value
			bundleCheckResult = bundleSettled.value
		} else {
			typecheckResult = await runTypecheckPhase()
			bundleCheckResult = await runBundlePhase()
		}
	} finally {
		if (isolatedRunner && stagingKey) {
			await isolatedRunner.discard(stagingKey)
		}
	}
	results.push({
		kind: 'bundle',
		ok: bundleCheckResult.ok,
		message: bundleCheckResult.message,
	})
	results.push(typecheckResult)
	results.push({
		kind: 'lint',
		ok: lintCheck.ok,
		message: lintCheck.message,
	})
	return toRepoCheckRunResult({
		results,
		manifest,
		sourceFiles,
	})
}

type RepoSourceWalkWorkspace = {
	readFile(path: string): Promise<string | null>
	glob(pattern: string): Promise<Array<{ path: string; type: string }>>
	stat?(path: string): Promise<{ size: number } | null>
}

/**
 * Plain-repo publish gate: walk the source tree and enforce per-file and
 * aggregate size limits only (no manifest, bundle, typecheck, or lint).
 */
export async function runRepoSourceWalkChecks(input: {
	workspace: RepoSourceWalkWorkspace
	sourceRoot: string
}): Promise<{
	ok: boolean
	message: string
	sourceFiles: Record<string, string>
}> {
	const sourceRoot = normalizeRepoWorkspacePath(input.sourceRoot).replace(
		/\/+$/,
		'',
	)
	const collected: Record<string, string> = {}
	let fileCount = 0
	let totalBytes = 0
	for await (const [path, content, fileBytes] of workspaceFilesForSnapshot({
		workspace: input.workspace,
		root: sourceRoot,
	})) {
		fileCount += 1
		if (fileCount > repoChecksSourceMaxFiles) {
			return {
				ok: false,
				message: `Repo checks aborted: source root "${sourceRoot || '/'}" contains more than the ${repoChecksSourceMaxFiles}-file publish check limit. Remove files that should not be published (for example build output, vendored dependencies, or data files) and run the checks again.`,
				sourceFiles: {},
			}
		}
		if (fileBytes > maxRepoSourceFileBytes) {
			return {
				ok: false,
				message: `Repo checks aborted: ${buildRepoLargeFileMessage({
					path,
					byteLength: fileBytes,
				})}`,
				sourceFiles: {},
			}
		}
		totalBytes += fileBytes
		if (totalBytes > repoChecksSourceMaxTotalBytes) {
			return {
				ok: false,
				message: `Repo checks aborted: source root "${sourceRoot || '/'}" exceeds the ${repoChecksSourceMaxTotalBytes}-byte (${Math.round(repoChecksSourceMaxTotalBytes / (1024 * 1024))} MiB) publish check limit. Remove or shrink large files that should not be published (for example build output, vendored dependencies, or data files) and run the checks again.`,
				sourceFiles: {},
			}
		}
		collected[path] = content
	}
	return {
		ok: true,
		message: `Validated ${fileCount} source file(s) within size limits.`,
		sourceFiles: collected,
	}
}

/**
 * Advisory publish note. Omitted when the credential stamp gate already
 * failed, so that failure stays the message authors fix first.
 */
function fetchBodySecretResolutionNotice(
	sourceFiles: Record<string, string>,
): string | null {
	const hits: Array<{ path: string; line: number }> = []
	for (const path of listScannableModulePaths(sourceFiles)) {
		const source = sourceFiles[path]
		if (typeof source !== 'string') continue
		for (const hit of findFetchBodiesMissingSecretResolution(source)) {
			hits.push({ path, line: hit.line })
		}
	}
	return formatFetchBodySecretResolutionWarning(hits)
}
