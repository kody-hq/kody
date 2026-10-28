import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requirePackageRealtimeContext,
	packageRealtimeSessionRecordSchema,
} from './shared.ts'
import { z } from 'zod'

const inputSchema = z.object({
	facet: z.string().min(1).optional(),
	topic: z.string().min(1).optional(),
	package_id: z.string().min(1).optional(),
})

const outputSchema = z.object({
	package_id: z.string(),
	kody_id: z.string(),
	sessions: z.array(packageRealtimeSessionRecordSchema),
})

export const sessionListCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'sessionList',
		contextRuns: 'allow',
		orgPermission: 'app:read',
		description:
			'List active websocket sessions for a package app, optionally filtered by facet or subscribed topic.',
		keywords: ['app', 'websocket', 'session', 'list', 'facet', 'topic'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const realtimeContext = await requirePackageRealtimeContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
				explicitPackageId: args.package_id,
			})
			const result = await realtimeContext.realtime.listSessions({
				facet: args.facet ?? null,
				topic: args.topic ?? null,
			})
			const sessions = Array.isArray(result?.sessions) ? result.sessions : []
			return {
				package_id: realtimeContext.savedPackage.id,
				kody_id: realtimeContext.savedPackage.kodyId,
				sessions,
			}
		},
	},
)
