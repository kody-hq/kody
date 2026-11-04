import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { ExecutionContextError } from '#worker/execution-contexts/errors.ts'
import { isExecutionContextsEnabledFor } from '#worker/execution-contexts/flag.ts'
import { getChain } from '#worker/execution-contexts/store.ts'
import { packagePublishDefinitionSchema } from '#worker/package-registry/types.ts'
import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { dispatchContextPublishBuild } from './context-dispatch.ts'
import { isPublishOffloadEnabledFor } from './flag.ts'
import { createPublishBuild, discardUnstartedPublishBuild } from './store.ts'

/**
 * Where a publish builds (Kent, Nov 4 2026, question 1):
 *
 * 1. A context the trigger names (`context` on the publish, `--context` in
 *    the CLI). `"cloud"` builds on Kody cloud. A named context never falls
 *    back.
 * 2. Otherwise the package's `kody.publish.execution.context`. That is a
 *    binding: when the bound context errors or is unavailable, the publish
 *    fails with {@link publishBindingUnavailableMessage}.
 * 3. Otherwise the publisher's execution context chain, the same as execute:
 *    contexts in order, Kody cloud last unless the chain is strict.
 *
 * Only where both `execution-contexts` and `publish-offload` are on for the
 * publisher; otherwise every publish builds on Kody cloud exactly as before
 * (and a named context other than `"cloud"` is refused), the same as
 * automations' `execution` setting (ADR 0086).
 */
export type PublishRoute =
	| { kind: 'cloud'; via: PublishRouteVia }
	| {
			kind: 'context'
			via: Exclude<PublishRouteVia, 'flags_off'>
			buildId: string
			contextName: string
	  }

export type PublishRouteVia = 'requested' | 'bound' | 'chain' | 'flags_off'

export type PublishRouteBuildResult =
	| { kind: 'cloud' }
	| { kind: 'context'; buildId: string; contextName: string }

export type PublishRouteDeps = {
	/** `execution-contexts` and `publish-offload` are both on for the publisher. */
	flagsEnabled: () => Promise<boolean>
	/** `kody.publish.execution.context` at the commit being published. */
	readBoundContext: () => Promise<string | null>
	/** False only for a non-strict chain with no contexts (cloud only). */
	chainMayUseContexts: () => Promise<boolean>
	buildOnContext: (input: {
		context: string | null
		fallbackToCloud: boolean
	}) => Promise<PublishRouteBuildResult>
}

export const publishContextFlagsOffMessage =
	'Publishing on an execution context needs the execution-contexts and publish-offload feature flags, which are off for this account. Publish without `context` (or with `context: "cloud"`) to build on Kody cloud.'

export const publishBindingConfigPath = 'kody.publish.execution.context'

/** The error a bound package's publish fails with (no fallback). */
export function publishBindingUnavailableMessage(input: {
	packageRef: string
	context: string
	reason: string
}) {
	const reason = input.reason.trim().replace(/\.$/, '') || 'no details'
	return [
		`Package "${input.packageRef}" is bound to execution context "${input.context}" (package.json ${publishBindingConfigPath}), and that context is not available: ${reason}.`,
		'Nothing was published; the previously published version is still serving. A bound package never falls back to your chain or Kody cloud.',
		`To publish now, name a context for this publish: \`kody package publish ${input.packageRef} --context <name>\` (or \`--context cloud\`), or pass \`context\` to packagePublishExternalPush.`,
		`To change the binding, edit ${publishBindingConfigPath} in package.json (remove it to follow your execution chain), commit, push, and publish again.`,
	].join(' ')
}

export async function decidePublishRoute(input: {
	requestedContext: string | null | undefined
	packageRef: string
	deps: PublishRouteDeps
}): Promise<PublishRoute> {
	const requested = input.requestedContext?.trim() || null
	if (requested === 'cloud') return { kind: 'cloud', via: 'requested' }
	if (!(await input.deps.flagsEnabled())) {
		if (requested) {
			throw new ExecutionContextError({
				status: 403,
				code: 'feature_disabled',
				message: publishContextFlagsOffMessage,
			})
		}
		return { kind: 'cloud', via: 'flags_off' }
	}
	if (requested) {
		const built = await input.deps.buildOnContext({
			context: requested,
			fallbackToCloud: false,
		})
		return built.kind === 'context'
			? { ...built, via: 'requested' }
			: { kind: 'cloud', via: 'requested' }
	}
	const bound = await input.deps.readBoundContext()
	if (bound === 'cloud') return { kind: 'cloud', via: 'bound' }
	if (bound) {
		let built: PublishRouteBuildResult
		try {
			built = await input.deps.buildOnContext({
				context: bound,
				fallbackToCloud: false,
			})
		} catch (error) {
			throw bindingUnavailable(input.packageRef, bound, errorText(error))
		}
		if (built.kind !== 'context') {
			throw bindingUnavailable(
				input.packageRef,
				bound,
				'it did not take the publish build',
			)
		}
		return { ...built, via: 'bound' }
	}
	if (!(await input.deps.chainMayUseContexts())) {
		return { kind: 'cloud', via: 'chain' }
	}
	const built = await input.deps.buildOnContext({
		context: null,
		fallbackToCloud: true,
	})
	return built.kind === 'context'
		? { ...built, via: 'chain' }
		: { kind: 'cloud', via: 'chain' }
}

function bindingUnavailable(
	packageRef: string,
	context: string,
	reason: string,
) {
	return new ExecutionContextError({
		status: 409,
		code: 'execution_context_binding_unavailable',
		message: publishBindingUnavailableMessage({ packageRef, context, reason }),
		details: { context, config: publishBindingConfigPath },
	})
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

/** Reads `kody.publish.execution.context` from package.json text. */
export function parsePublishBinding(manifestText: string | null) {
	if (!manifestText) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestText)
	} catch {
		return null
	}
	const kody =
		parsed && typeof parsed === 'object'
			? (parsed as { kody?: unknown }).kody
			: null
	const publish =
		kody && typeof kody === 'object'
			? (kody as { publish?: unknown }).publish
			: undefined
	if (publish === undefined) return null
	const result = packagePublishDefinitionSchema.safeParse(publish)
	return result.success ? (result.data.execution?.context ?? null) : null
}

/** The real dependencies for {@link decidePublishRoute}. */
export function publishRouteDeps(input: {
	env: Env
	callerContext: McpCallerContext
	request: RequestContext
	personId: string
	packageId: string
	packageName: string
	ownerUserId: string
	source: {
		id: string
		repo_id: string
		source_root: string
		manifest_path: string
	}
	commit: string
}): PublishRouteDeps {
	const db = input.env.APP_DB
	const orgId = input.request.org.id
	return {
		flagsEnabled: async () => {
			const [contexts, offload] = await Promise.all([
				isExecutionContextsEnabledFor(db, input.personId, orgId),
				isPublishOffloadEnabledFor(db, input.personId, orgId),
			])
			return contexts && offload
		},
		readBoundContext: async () => {
			const bytes = await readArtifactFileAtCommit({
				env: input.env,
				repoId: input.source.repo_id,
				commit: input.commit,
				filePath: input.source.manifest_path,
			})
			return parsePublishBinding(bytes ? new TextDecoder().decode(bytes) : null)
		},
		chainMayUseContexts: async () => {
			const chain = await getChain(db, { orgId, userId: input.personId })
			return (
				chain.strict || chain.entries.some((entry) => entry.kind === 'context')
			)
		},
		buildOnContext: async ({ context, fallbackToCloud }) => {
			const created = await createPublishBuild({
				db,
				packageId: input.packageId,
				sourceId: input.source.id,
				ownerUserId: input.ownerUserId,
				requesterUserId: input.personId,
				orgId,
				commit: input.commit,
				origin: 'context',
			})
			// A failed build is left for the expiry sweep, which also drops any
			// chunks it uploaded.
			const dispatched = await dispatchContextPublishBuild({
				env: input.env,
				callerContext: input.callerContext,
				request: input.request,
				buildId: created.buildId,
				ticket: created.ticket,
				uploadPath: `/v1/publish-builds/${created.buildId}`,
				packageId: input.packageId,
				packageName: input.packageName,
				repoId: input.source.repo_id,
				commit: input.commit,
				sourceRoot: input.source.source_root,
				manifestPath: input.source.manifest_path,
				context,
				fallbackToCloud,
			})
			if (dispatched.kind === 'cloud') {
				await discardUnstartedPublishBuild(db, created.buildId).catch(() => {})
				return { kind: 'cloud' }
			}
			return {
				kind: 'context',
				buildId: created.buildId,
				contextName: dispatched.contextName,
			}
		},
	}
}
