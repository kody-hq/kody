import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'

const packageSubscriptionSchema = z.object({
	package_id: z.string(),
	kody_id: z.string().describe('Package name leaf (same value as `slug`).'),
	slug: z.string().describe('Package name leaf (same value as `kody_id`).'),
	name: z.string(),
	topic: z.string(),
	handler: z.string(),
	description: z.string().nullable(),
	filters: z.record(z.string(), z.unknown()).nullable(),
})

export const listPackageSubscriptionsCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageSubscriptionsList',
		orgPermission: 'package:read',
		description:
			'List package.json#kody.subscriptions entries for the packages you can read in the org this connection is bound to, optionally filtered by exact event topic. Use this to discover package event handlers such as email receipt, delivery-update, repo.pushed / repo.created / repo.deleted Artifacts lifecycle notifiers, run.error.recorded activity notifiers, integration.auth.failed / integration.auth.succeeded reconnect notifiers, mcp.server.disconnected / mcp.server.reconnected connection episodes, community.fork.upstream_updated fork notifiers, follow.published / follow.pushed follow notifiers, admin platform-feedback, admin community-activity, admin community-listing-published, admin status-incident, admin fleet.package_error_rate.elevated, admin fleet.package_owner_error_spike, admin fleet.users_affected.elevated, admin fleet.users_affected.resolved, admin fleet.entitlement.crossed, admin auth.denial.burst, admin email.delivery.burst, admin user.created / user.deleted, admin user.email_verification.failed, admin user.email_verification.stalled, admin user.email_outbound.paused, or admin email.system-message.sent notification subscribers before debugging dispatch or building fan-out. Admin-only topics carry only their documented payload, and declaring one does not grant delivery; dispatch checks the package owner role fresh at delivery time.',
		keywords: [
			'package',
			'package.json#kody.subscriptions',
			'subscription',
			'subscriptions',
			'event',
			'event topic',
			'handler',
			'email.message.received',
			'email message received',
			'email.message.delivery.updated',
			'email delivery updated',
			'email.system-message.received',
			'email.system-message.sent',
			'system email sent',
			'system email',
			'run.error.recorded',
			'run error recorded',
			'activity error',
			'repo.pushed',
			'repo pushed',
			'repo.created',
			'repo.deleted',
			'artifacts push',
			'platform.feedback.submitted',
			'platform feedback submitted',
			'community.activity.recorded',
			'community activity recorded',
			'community.listing.published',
			'public package published',
			'community listing published',
			'community.fork.upstream_updated',
			'fork upstream updated',
			'follow.published',
			'follow published',
			'follow.pushed',
			'follow pushed',
			'follow_repo',
			'forked package updated',
			'status.incident.opened',
			'status incident opened',
			'status.incident.resolved',
			'status incident resolved',
			'fleet.package_error_rate.elevated',
			'fleet package error rate',
			'fleet.package_owner_error_spike',
			'fleet package owner error spike',
			'fleet.users_affected.elevated',
			'fleet users affected elevated',
			'fleet.users_affected.resolved',
			'fleet users affected resolved',
			'fleet.entitlement.crossed',
			'fleet entitlement crossed',
			'entitlement crossing',
			'user.created',
			'user created',
			'user.deleted',
			'user deleted',
			'user.email_verification.failed',
			'email verification failed',
			'user.email_verification.stalled',
			'email verification stalled',
			'user.email_outbound.paused',
			'outbound email paused',
			'auth.denial.burst',
			'auth denial burst',
			'email.delivery.burst',
			'email delivery burst',
			'account created',
			'account deleted',
			'integration.auth.failed',
			'integration.auth.succeeded',
			'mcp.server.disconnected',
			'mcp.server.reconnected',
			'mcp server disconnected',
			'inbound email',
			'list',
			'discover',
			'manifest',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			topic: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional exact event topic filter such as "email.message.received", "repo.pushed", "run.error.recorded", "integration.auth.failed", "integration.auth.succeeded", "mcp.server.disconnected", "community.fork.upstream_updated", "follow.published", "follow.pushed", "platform.feedback.submitted", "community.activity.recorded", "community.listing.published", "status.incident.opened", "fleet.package_error_rate.elevated", "fleet.package_owner_error_spike", "fleet.entitlement.crossed", "auth.denial.burst", "email.delivery.burst", "user.created", "user.deleted", "user.email_verification.failed", "user.email_verification.stalled", "user.email_outbound.paused", or "email.system-message.sent".',
				),
		}),
		outputSchema: z.object({
			subscriptions: z.array(packageSubscriptionSchema),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const access = await computeEffectivePermissions({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
			})
			const packages = (
				await listSavedPackagesByUserId(ctx.env.APP_DB, { userId: ownerId })
			).filter(
				(savedPackage) =>
					checkPermission(access, 'package:read', packageResource(savedPackage))
						.allowed,
			)
			const loadedManifests = await Promise.all(
				packages.map(async (savedPackage) => ({
					savedPackage,
					loaded: await loadPackageManifestBySourceId({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						userId: ownerId,
						sourceId: savedPackage.sourceId,
					}).catch((error) => {
						console.warn('Failed to load package manifest for subscriptions', {
							packageId: savedPackage.id,
							sourceId: savedPackage.sourceId,
							error,
						})
						return null
					}),
				})),
			)
			const subscriptions: Array<z.infer<typeof packageSubscriptionSchema>> = []
			for (const { savedPackage, loaded } of loadedManifests) {
				if (!loaded) continue
				const declared = loaded.manifest.kody.subscriptions ?? {}
				for (const [topic, definition] of Object.entries(declared)) {
					if (args.topic && args.topic !== topic) continue
					subscriptions.push({
						package_id: savedPackage.id,
						kody_id: savedPackage.kodyId,
						slug: savedPackage.kodyId,
						name: savedPackage.name,
						topic,
						handler: definition.handler,
						description: definition.description ?? null,
						filters: definition.filters ?? null,
					})
				}
			}
			return {
				subscriptions: subscriptions.sort((left, right) => {
					return (
						left.topic.localeCompare(right.topic) ||
						left.kody_id.localeCompare(right.kody_id)
					)
				}),
			}
		},
	},
)
