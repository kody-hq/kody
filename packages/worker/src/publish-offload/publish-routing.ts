import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { Effect, Exit, Option, Schema } from 'effect'
import { fromD1Promise, D1 } from '#worker/effect/d1.ts'
import { outbound } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { isExecutionContextsEnabledFor } from '#worker/execution-contexts/flag.ts'
import { getChain } from '#worker/execution-contexts/store.ts'
import { packagePublishDefinitionSchema } from '#worker/package-registry/types.ts'
import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { dispatchContextPublishBuild } from './context-dispatch.ts'
import { PublishBindingUnavailable, PublishContextFlagsOff } from './errors.ts'
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

export type PublishRouteDeps<E = never, R = never> = {
	/** `execution-contexts` and `publish-offload` are both on for the publisher. */
	flagsEnabled: () => Effect.Effect<boolean, E, R>
	/** `kody.publish.execution.context` at the commit being published. */
	readBoundContext: () => Effect.Effect<string | null, E, R>
	/** False only for a non-strict chain with no contexts (cloud only). */
	chainMayUseContexts: () => Effect.Effect<boolean, E, R>
	buildOnContext: (input: {
		context: string | null
		fallbackToCloud: boolean
	}) => Effect.Effect<PublishRouteBuildResult, E, R>
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

export function decidePublishRoute<E, R>(input: {
	requestedContext: string | null | undefined
	packageRef: string
	deps: PublishRouteDeps<E, R>
}): Effect.Effect<
	PublishRoute,
	E | PublishContextFlagsOff | PublishBindingUnavailable,
	R
> {
	return Effect.gen(function* () {
		const requested = input.requestedContext?.trim() || null
		const route = (value: PublishRoute) => value
		if (requested === 'cloud') return route({ kind: 'cloud', via: 'requested' })
		if (!(yield* input.deps.flagsEnabled())) {
			if (requested) {
				return yield* new PublishContextFlagsOff({
					message: publishContextFlagsOffMessage,
				})
			}
			return route({ kind: 'cloud', via: 'flags_off' })
		}
		if (requested) {
			const built = yield* input.deps.buildOnContext({
				context: requested,
				fallbackToCloud: false,
			})
			return built.kind === 'context'
				? route({ ...built, via: 'requested' })
				: route({ kind: 'cloud', via: 'requested' })
		}
		const bound = yield* input.deps.readBoundContext()
		if (bound === 'cloud') return route({ kind: 'cloud', via: 'bound' })
		if (bound) {
			const built = yield* input.deps
				.buildOnContext({ context: bound, fallbackToCloud: false })
				.pipe(
					Effect.mapError((error) =>
						bindingUnavailable(input.packageRef, bound, errorText(error)),
					),
				)
			if (built.kind !== 'context') {
				return yield* bindingUnavailable(
					input.packageRef,
					bound,
					'it did not take the publish build',
				)
			}
			return route({ ...built, via: 'bound' })
		}
		if (!(yield* input.deps.chainMayUseContexts())) {
			return route({ kind: 'cloud', via: 'chain' })
		}
		const built = yield* input.deps.buildOnContext({
			context: null,
			fallbackToCloud: true,
		})
		return built.kind === 'context'
			? route({ ...built, via: 'chain' })
			: route({ kind: 'cloud', via: 'chain' })
	}).pipe(Effect.withSpan('PublishOffload.decideRoute'))
}

function bindingUnavailable(
	packageRef: string,
	context: string,
	reason: string,
) {
	return new PublishBindingUnavailable({
		message: publishBindingUnavailableMessage({ packageRef, context, reason }),
		context,
	})
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

const PublishBindingManifest = Schema.fromJsonString(
	Schema.Struct({
		kody: Schema.optionalKey(
			Schema.Struct({ publish: Schema.optionalKey(Schema.Unknown) }),
		),
	}),
)

/** Reads `kody.publish.execution.context` from package.json text. */
export function parsePublishBinding(manifestText: string | null) {
	if (!manifestText) return null
	const manifest = Schema.decodeUnknownOption(PublishBindingManifest)(
		manifestText,
	)
	if (Option.isNone(manifest)) return null
	const publish = manifest.value.kody?.publish
	if (publish === undefined) return null
	const result = packagePublishDefinitionSchema.safeParse(publish)
	return result.success ? (result.data.execution?.context ?? null) : null
}

/** The real dependencies for {@link decidePublishRoute}. */
export function publishRouteDeps(input: {
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
}) {
	const orgId = input.request.org.id
	const deps = {
		flagsEnabled: Effect.fn('PublishRoute.flagsEnabled')(function* () {
			const db = yield* D1
			const [contexts, offload] = yield* Effect.all(
				[
					fromD1Promise('execution_contexts.flag', () =>
						isExecutionContextsEnabledFor(db.database(), input.personId, orgId),
					),
					isPublishOffloadEnabledFor(input.personId, orgId),
				],
				{ concurrency: 'unbounded' },
			)
			return contexts && offload
		}),
		readBoundContext: Effect.fn('PublishRoute.readBoundContext')(function* () {
			const env = yield* WorkerEnv
			const bytes = yield* outbound('artifacts.read_file_at_commit', () =>
				readArtifactFileAtCommit({
					env,
					repoId: input.source.repo_id,
					commit: input.commit,
					filePath: input.source.manifest_path,
				}),
			)
			return parsePublishBinding(bytes ? new TextDecoder().decode(bytes) : null)
		}),
		chainMayUseContexts: Effect.fn('PublishRoute.chainMayUseContexts')(
			function* () {
				const db = yield* D1
				const chain = yield* fromD1Promise('execution_contexts.chain', () =>
					getChain(db.database(), { orgId, userId: input.personId }),
				)
				return (
					chain.strict ||
					chain.entries.some((entry) => entry.kind === 'context')
				)
			},
		),
		buildOnContext: Effect.fn('PublishRoute.buildOnContext')(function* ({
			context,
			fallbackToCloud,
		}: {
			context: string | null
			fallbackToCloud: boolean
		}) {
			// A build Kody cloud took instead is discarded on the way out; a
			// failed build is left for the expiry sweep, which also drops any
			// chunks a context may still be uploading.
			return yield* Effect.acquireUseRelease(
				createPublishBuild({
					packageId: input.packageId,
					sourceId: input.source.id,
					ownerUserId: input.ownerUserId,
					requesterUserId: input.personId,
					orgId,
					commit: input.commit,
					origin: 'context',
				}),
				(created) =>
					dispatchContextPublishBuild({
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
					}).pipe(
						Effect.map((dispatched): PublishRouteBuildResult =>
							dispatched.kind === 'cloud'
								? { kind: 'cloud' }
								: {
										kind: 'context',
										buildId: created.buildId,
										contextName: dispatched.contextName,
									},
						),
					),
				(created, exit) =>
					Exit.isSuccess(exit) && exit.value.kind === 'cloud'
						? discardUnstartedPublishBuild(created.buildId).pipe(
								Effect.catchTag('DatabaseError', (error) =>
									Effect.logDebug('publish_build_discard_failed', {
										buildId: created.buildId,
										message: error.message,
									}),
								),
							)
						: Effect.void,
			)
		}),
	}
	return deps
}
