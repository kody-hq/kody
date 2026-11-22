import { type Effect, Match } from 'effect'
import { McpCallerError } from '#mcp/caller-error.ts'
import { rethrow, runEdge } from '#worker/effect/edge.ts'
import { ExecutionContextError } from '#worker/execution-contexts/errors.ts'
import { publishBindingConfigPath } from './publish-routing.ts'
import * as PublishRouting from './publish-routing.ts'
import { publishBuildRejectionHint } from './policy.ts'
import { publishOffloadRuntime } from './services.ts'
import * as Store from './store.ts'
import type {
	PublishBindingUnavailable,
	PublishContextBuildFailed,
	PublishContextFlagsOff,
	PublishContextFromContextRun,
	PublishContextNeedsPerson,
	PublishContextTimedOut,
	PublishContextUnavailable,
} from './errors.ts'

/**
 * How each publish offload failure leaves an MCP capability: the exact
 * `ExecutionContextError` or `McpCallerError` the path threw before it ran
 * on Effect. Each edge picks the handlers for its own failure union and
 * passes them to `Match.tagsExhaustive`, so a new failure without a
 * handler here does not compile.
 */
export const mcpFailure = {
	PublishContextNeedsPerson: ({ message }: PublishContextNeedsPerson) => {
		throw new ExecutionContextError({
			status: 401,
			code: 'insufficient_scope',
			message,
		})
	},
	PublishContextFromContextRun: ({ message }: PublishContextFromContextRun) => {
		throw new ExecutionContextError({
			status: 403,
			code: 'insufficient_scope',
			message,
		})
	},
	PublishContextUnavailable: ({ message }: PublishContextUnavailable) => {
		throw new ExecutionContextError({
			status: 409,
			code: 'execution_context_unavailable',
			message,
		})
	},
	PublishContextTimedOut: ({ message }: PublishContextTimedOut) => {
		throw new ExecutionContextError({
			status: 504,
			code: 'execution_context_unavailable',
			message,
		})
	},
	PublishContextFlagsOff: ({ message }: PublishContextFlagsOff) => {
		throw new ExecutionContextError({
			status: 403,
			code: 'feature_disabled',
			message,
		})
	},
	PublishBindingUnavailable: ({
		message,
		context,
	}: PublishBindingUnavailable) => {
		throw new ExecutionContextError({
			status: 409,
			code: 'execution_context_binding_unavailable',
			message,
			details: { context, config: publishBindingConfigPath },
		})
	},
	PublishContextBuildFailed: ({ message }: PublishContextBuildFailed) => {
		throw new McpCallerError(message)
	},
	PublishOffloadDisabled: ({ message }: { message: string }) => {
		throw new McpCallerError(message)
	},
	PublishBuildRejected: ({ reason }: { reason: string }) => {
		throw new McpCallerError(
			`Publish build rejected: ${reason} ${publishBuildRejectionHint}`,
		)
	},
	PublishBuildCreateRefused: ({ message }: { message: string }) => {
		throw new McpCallerError(message)
	},
	DatabaseError: rethrow,
	OutboundCallError: rethrow,
} as const

/** `packagePublishExternalPush`: where this publish builds. */
export async function decidePublishRoute(input: {
	env: Env
	requestedContext: string | null | undefined
	packageRef: string
	deps: ReturnType<typeof PublishRouting.publishRouteDeps>
}): Promise<PublishRouting.PublishRoute> {
	const program = PublishRouting.decidePublishRoute(input)
	return await runEdge(
		publishOffloadRuntime(input.env),
		program,
		Match.type<Effect.Error<typeof program>>().pipe(
			Match.tagsExhaustive({
				PublishContextNeedsPerson: mcpFailure.PublishContextNeedsPerson,
				PublishContextFromContextRun: mcpFailure.PublishContextFromContextRun,
				PublishContextUnavailable: mcpFailure.PublishContextUnavailable,
				PublishContextTimedOut: mcpFailure.PublishContextTimedOut,
				PublishContextFlagsOff: mcpFailure.PublishContextFlagsOff,
				PublishBindingUnavailable: mcpFailure.PublishBindingUnavailable,
				PublishContextBuildFailed: mcpFailure.PublishContextBuildFailed,
				DatabaseError: mcpFailure.DatabaseError,
				OutboundCallError: mcpFailure.OutboundCallError,
			}),
		),
	)
}

/** `packagePublishExternalPush({ publish_build_id })`: the commit-time gate. */
export async function resolveUploadedPublishBuildForPublish(
	input: Parameters<typeof Store.resolveUploadedPublishBuildForPublish>[0] & {
		env: Env
	},
) {
	const program = Store.resolveUploadedPublishBuildForPublish(input)
	return await runEdge(
		publishOffloadRuntime(input.env),
		program,
		Match.type<Effect.Error<typeof program>>().pipe(
			Match.tagsExhaustive({
				PublishOffloadDisabled: mcpFailure.PublishOffloadDisabled,
				PublishBuildRejected: mcpFailure.PublishBuildRejected,
				DatabaseError: mcpFailure.DatabaseError,
			}),
		),
	)
}

/** `packageGet`: where the serving build was made (never fails). */
export async function getCommittedPublishBuildOrigin(
	input: Parameters<typeof Store.getCommittedPublishBuildOrigin>[0] & {
		env: Env
	},
) {
	return await publishOffloadRuntime(input.env).runPromise(
		Store.getCommittedPublishBuildOrigin(input),
	)
}
