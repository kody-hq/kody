import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { isOrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { profileGrantResourceTypes } from '#worker/profiles/rules.ts'
import {
	createProfile,
	getProfile,
	listProfiles,
	requireProfilesCaller,
	revokeProfile,
	updateProfile,
} from '#worker/profiles/service.ts'

const domain = capabilityDomainNames.profiles
const idSchema = z.string().min(1).describe('Profile id (prf_...).')
const expiresAtSchema = z
	.string()
	.datetime({ offset: true })
	.describe(
		'ISO 8601 time the profile stops working. A sub-profile never outlives its parents; when omitted it inherits the earliest parent expiry.',
	)

const grantSchema = z.object({
	resource_type: z
		.enum(profileGrantResourceTypes)
		.describe(
			'One resource kind, or `org` (resource_id = the org id) for org-level permissions only: org:read, org:execute, search:read, member:read, team:read, audit:read, profile:manage (for sub-profiles), and <type>:create. A profile never gets org-wide reads of a resource kind.',
		),
	resource_id: z
		.string()
		.min(1)
		.describe('Id of that resource (package id, app id, credential id, ...).'),
	permissions: z
		.array(
			z
				.string()
				.refine(isOrgPermission, 'Unknown permission')
				.describe('A permission of that kind, such as package:execute.'),
		)
		.min(1)
		.describe(
			'Permissions the profile snapshots now. Each must be one you hold on that resource, and for a sub-profile one every parent holds.',
		),
})

function caller(ctx: CapabilityContext) {
	return requireProfilesCaller(ctx)
}

const keywords = [
	'profile',
	'profiles',
	'agent identity',
	'bot identity',
	'sub-profile',
	'sub-agent',
	'scoped identity',
	'expiry',
	'revoke',
]

export const profileCreateCapability = defineDomainCapability(domain, {
	name: 'profileCreate',
	contextRuns: 'deny',
	orgPermission: 'profile:manage',
	featureFlag: 'profiles',
	description:
		'Create a profile: a scoped identity in this org for an agent or bot you run. It starts with a snapshot of grants (each one a subset of what you hold now), an optional expiry, and an optional parent profile to make a sub-profile (at most 5 levels). Profiles never gain access later when you or a parent do. A request running as a profile reaches only what you, the profile, and every parent allow. Share a package with a profile through packageCollaboratorSet (profile_id). Guide: guide:profiles.',
	keywords: [...keywords, 'create profile', 'new profile'],
	readOnly: false,
	idempotent: false,
	destructive: false,
	inputSchema: z.object({
		name: z
			.string()
			.min(1)
			.max(63)
			.describe(
				'Lowercase letters, digits, and dashes; unique among your profiles under the same parent.',
			),
		parent_profile_id: idSchema
			.optional()
			.describe('Make this a sub-profile of one of your profiles.'),
		expires_at: expiresAtSchema.optional(),
		grants: z.array(grantSchema).max(50).optional(),
	}),
	async handler(args, ctx) {
		return await createProfile(await caller(ctx), {
			name: args.name,
			parentProfileId: args.parent_profile_id ?? null,
			expiresAt: args.expires_at ?? null,
			grants: (args.grants ?? []).map((grant) => ({
				resourceType: grant.resource_type,
				resourceId: grant.resource_id,
				permissions: grant.permissions.filter(isOrgPermission),
			})),
		})
	},
})

export const profileListCapability = defineDomainCapability(domain, {
	name: 'profileList',
	contextRuns: 'allow',
	orgPermission: 'profile:manage',
	featureFlag: 'profiles',
	description:
		'List your profiles in this org with their status (active, expired, revoked, or parent_inactive), parent chain, effective expiry, and grant snapshot. Owners can pass all_members to see every member’s profiles.',
	keywords: [...keywords, 'list profiles'],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({
		all_members: z
			.boolean()
			.optional()
			.describe('Owners only: list every profile in the org.'),
	}),
	async handler(args, ctx) {
		return {
			profiles: await listProfiles(await caller(ctx), {
				allMembers: args.all_members === true,
			}),
		}
	},
})

export const profileGetCapability = defineDomainCapability(domain, {
	name: 'profileGet',
	contextRuns: 'allow',
	orgPermission: 'profile:manage',
	featureFlag: 'profiles',
	description:
		'Read one profile: status, parent chain (root first), its own and effective expiry, and its grant snapshot.',
	keywords: [...keywords, 'profile detail'],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({ profile_id: idSchema }),
	async handler(args, ctx) {
		return await getProfile(await caller(ctx), args.profile_id)
	},
})

export const profileUpdateCapability = defineDomainCapability(domain, {
	name: 'profileUpdate',
	contextRuns: 'deny',
	orgPermission: 'profile:manage',
	featureFlag: 'profiles',
	description:
		'Shorten a profile’s expiry. Expiry only moves earlier: a later time or clearing it is refused, so create a new profile for more time. Only the person the profile acts for (or a profile above it) can change it; a profile cannot change itself, its parents, or its siblings, and Owners can only list and revoke.',
	keywords: [...keywords, 'shorten expiry', 'update profile'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({
		profile_id: idSchema,
		expires_at: expiresAtSchema,
	}),
	async handler(args, ctx) {
		return await updateProfile(await caller(ctx), {
			profileId: args.profile_id,
			expiresAt: args.expires_at,
		})
	},
})

export const profileRevokeCapability = defineDomainCapability(domain, {
	name: 'profileRevoke',
	contextRuns: 'deny',
	orgPermission: 'profile:manage',
	featureFlag: 'profiles',
	description:
		'Revoke a profile for good. Every sub-profile below it stops working too. Revoke cannot be undone. You can revoke your own profiles; an org Owner can revoke any profile in the org.',
	keywords: [...keywords, 'revoke profile', 'disable profile'],
	readOnly: false,
	idempotent: true,
	destructive: true,
	inputSchema: z.object({ profile_id: idSchema }),
	async handler(args, ctx) {
		return await revokeProfile(await caller(ctx), {
			profileId: args.profile_id,
		})
	},
})
