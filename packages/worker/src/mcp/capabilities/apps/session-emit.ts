import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requirePackageRealtimeContext,
	sessionEmitInputSchema,
	sessionEmitOutputSchema,
} from './shared.ts'

export const sessionEmitCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'sessionEmit',
		contextRuns: 'allow',
		orgPermission: 'app:execute',
		description:
			'Send one websocket event to one active package realtime session.',
		keywords: ['session', 'websocket', 'emit', 'realtime', 'app'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: sessionEmitInputSchema,
		outputSchema: sessionEmitOutputSchema,
		async handler(args, ctx) {
			const realtimeContext = await requirePackageRealtimeContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
				explicitPackageId: args.package_id,
			})
			const result = await realtimeContext.realtime.emit(
				args.session_id,
				args.data,
			)
			return {
				delivered: result?.delivered === true,
				...(typeof result?.reason === 'string'
					? { reason: result.reason }
					: {}),
			}
		},
	},
)
