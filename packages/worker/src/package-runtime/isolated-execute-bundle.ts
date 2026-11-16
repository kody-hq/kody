/**
 * Hosted execute bundling without risking the calling isolate.
 *
 * An execute module that imports saved `kody:@` packages or npm packages is
 * bundled in a throwaway `REPO_SESSION` Durable Object. Done inline, one
 * large import reset the shared API isolate and every other in-flight
 * request with it: first through esbuild (2026-11-13), then while loading
 * and preparing a 5 MB published artifact with esbuild skipped (2026-11-16).
 * In the throwaway isolate, a build that exceeds the memory or CPU limits
 * fails only its own request.
 * That request is refused with a message that points at `execute --local`,
 * which bundles on the caller's machine.
 */
import { executeModuleEntryFile } from '@kody-internal/shared/execute-module.ts'
import {
	errorCauseChainIncludes,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { runWithRequestPermissions } from '#worker/authorization/authorize.ts'
import { isMcpCallerError, McpCallerError } from '#mcp/caller-error.ts'
import { executeBundleResourceLimitMessage } from '#mcp/execute-bundle-limit-messages.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import {
	collectLiteralImportSpecifiers,
	getBarePackageNameFromSpecifier,
} from './import-specifiers.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { buildKodyModuleBundle } from './module-graph.ts'
import type { RuntimeBundle } from './runtime-bundle-types.ts'

export class ExecuteBundleResourceLimitError extends McpCallerError {
	constructor(options?: ErrorOptions) {
		super(executeBundleResourceLimitMessage, options)
		this.name = 'ExecuteBundleResourceLimitError'
	}
}

export type IsolatedExecuteBundleRequest = {
	userId: OwnerId
	baseUrl: string
	sourceFiles: Record<string, string>
	/** Caller identity; the isolate recomputes its permissions from it. */
	request: RequestContext | null
}

export type IsolatedExecuteBundleOutcome =
	| { ok: true; bundle: RuntimeBundle }
	| { ok: false; name: string; message: string; callerError: boolean }

type IsolatedExecuteBundleStub = {
	buildIsolatedExecuteBundle(
		input: IsolatedExecuteBundleRequest,
	): Promise<IsolatedExecuteBundleOutcome>
}

/**
 * True when bundling loads code Kody does not ship in the runtime: a saved
 * package or an npm package. `kody:runtime` and relative imports cost nothing.
 */
async function importsPackages(code: string) {
	if (!code.includes('import') && !code.includes('from')) return false
	return (await collectLiteralImportSpecifiers(code)).some(
		(specifier) =>
			specifier.startsWith(packageSpecifierPrefix) ||
			getBarePackageNameFromSpecifier(specifier) != null,
	)
}

/**
 * Bundle an ad hoc execute module. A module with no package imports is built
 * here; any other module is bundled in a throwaway isolate.
 */
export async function buildExecuteModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	code: string
	sourceFiles: Record<string, string>
	request: RequestContext | null
}): Promise<RuntimeBundle> {
	if (!(await importsPackages(input.code))) {
		return await buildAdHocExecuteBundle(input.env, input)
	}
	// A fresh, org-namespaced id per build puts it in its own isolate, never
	// the calling isolate. The instance never touches its storage.
	const stub = input.env.REPO_SESSION.get(
		input.env.REPO_SESSION.idFromName(
			`isolated-execute-bundle-${input.userId}-${crypto.randomUUID()}`,
		),
	) as unknown as IsolatedExecuteBundleStub
	let outcome: IsolatedExecuteBundleOutcome
	try {
		outcome = await stub.buildIsolatedExecuteBundle({
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceFiles: input.sourceFiles,
			request: input.request,
		})
	} catch (error) {
		if (
			errorCauseChainIncludes(
				error,
				isDurableObjectIsolateResourceLimitResetMessage,
			)
		) {
			throw new ExecuteBundleResourceLimitError({ cause: error })
		}
		throw error
	}
	if (outcome.ok) return outcome.bundle
	const error = outcome.callerError
		? new McpCallerError(outcome.message)
		: new Error(outcome.message)
	error.name = outcome.name
	throw error
}

/** The isolate side of {@link buildExecuteModuleBundle}. Runs in `RepoSession`. */
export async function runIsolatedExecuteBundleBuild(
	env: Env,
	request: IsolatedExecuteBundleRequest,
): Promise<IsolatedExecuteBundleOutcome> {
	try {
		const bundle = await runWithRequestPermissions(
			{ env, request: request.request },
			() => buildAdHocExecuteBundle(env, request),
		)
		return { ok: true, bundle }
	} catch (error) {
		// Error classes do not survive the RPC boundary; carry what callers read.
		return {
			ok: false,
			name: error instanceof Error ? error.name : 'Error',
			message: getErrorMessage(error),
			callerError: isMcpCallerError(error),
		}
	}
}

async function buildAdHocExecuteBundle(
	env: Env,
	input: {
		userId: OwnerId
		baseUrl: string
		sourceFiles: Record<string, string>
	},
) {
	return await buildKodyModuleBundle({
		env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: executeModuleEntryFile,
		reuseCachedBundle: true,
		bundleContext: 'ad-hoc-execute',
		attachPublishedArtifacts: true,
	})
}
