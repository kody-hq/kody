import { z } from 'zod'
import { secretMetadataSchema } from '#mcp/capabilities/secrets/shared.ts'
import {
	packageCredentialKindValues,
	type SavedPackageRecord,
	type SavedPackageWithCommunityProvenanceRecord,
} from '#worker/package-registry/types.ts'

export const packageFileSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Package-relative file path to write into the saved package repo.',
		),
	content: z
		.string()
		.describe(
			'Full file contents for this package file. Publish requires non-empty root README.md (human-focused, including a concise Intent section) and AGENTS.md (agent-focused: imports, smoke tests, edge cases).',
		),
})

export const packageSummarySchema = z.object({
	package_id: z.string(),
	kody_id: z
		.string()
		.describe(
			'Package name leaf (same value as `slug`). Kept as a compatibility alias; prefer `slug` or `name`.',
		),
	slug: z
		.string()
		.describe(
			'Package name leaf (the path segment after the scope). Same value as `kody_id`.',
		),
	name: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	has_app: z.boolean(),
	hidden: z.boolean(),
	visibility: z
		.enum(['public', 'private'])
		.describe(
			'Repo visibility / forkable. Public means default-branch HEAD is world-readable and forkable and the package appears on /community. Private is owner-only. Independent of internet_visible.',
		),
	internet_visible: z
		.boolean()
		.describe(
			'When true, the hosted package app may be served on the public internet after capability approval. Independent of visibility/forkable. Defaults false.',
		),
	locked_at: z
		.string()
		.nullable()
		.describe(
			'When set, publishes require a website click at /@{username}/{kodyId}/approve-publish?commit=<full 40-character SHA>. Agents may lock via packageUpdate (`changes.locked: true`). Unlocking is website-only at /@{username}/{kodyId}/settings. Do not abbreviate the commit.',
		),
	source_id: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const packageSummaryWithCommunityProvenanceSchema =
	packageSummarySchema.extend({
		source_listing_id: z
			.string()
			.nullable()
			.describe(
				'Catalog entry id this package was forked from, or null for a self-authored package.',
			),
		listing_current: z
			.boolean()
			.nullable()
			.describe(
				'Whether the source catalog entry currently resolves to an active public package, or null for a self-authored package.',
			),
		listing_kody_id: z
			.string()
			.nullable()
			.describe(
				'Original public package name leaf recorded when this package was forked, or null for a self-authored package.',
			),
		listing_name: z
			.string()
			.nullable()
			.describe(
				'Current source listing package name when the listing is active, or null when this package is self-authored or the listing is gone.',
			),
		origin_commit: z
			.string()
			.nullable()
			.describe(
				'Listing pinned commit this fork last absorbed. Starts as the fork-time snapshot and moves when a later publish passes absorbed_upstream_commit.',
			),
		listing_pinned_commit: z
			.string()
			.nullable()
			.describe(
				'Current pinned commit of the source listing, or null when this package is self-authored or the listing is gone.',
			),
		listing_published_at: z
			.string()
			.nullable()
			.describe(
				'Last community publish time of the source listing, or null when this package is self-authored or the listing is gone.',
			),
		listing_ahead: z
			.boolean()
			.nullable()
			.describe(
				'True only when this community fork is outdated: the listing pin is not an ancestor of the fork tip. Null for a self-authored package. Otherwise false.',
			),
	})

const credentialNeedShapeSchema = z.object({
	kind: z
		.enum(packageCredentialKindValues)
		.optional()
		.describe(
			'Omitted when the need accepts any fetch-capable credential for the provider.',
		),
	provider: z.string(),
	multiple: z.boolean(),
})

/** One credential need a paused publish adds or reshapes. */
export const credentialNeedChangeSchema = z.discriminatedUnion('change', [
	z.object({
		key: z.string(),
		change: z.literal('added'),
		after: credentialNeedShapeSchema,
		from: z
			.string()
			.optional()
			.describe('The dependency that declared an inherited need.'),
	}),
	z.object({
		key: z.string(),
		change: z.literal('changed'),
		before: credentialNeedShapeSchema,
		after: credentialNeedShapeSchema,
		from: z
			.string()
			.optional()
			.describe('The dependency that declared an inherited need.'),
	}),
])

export const pendingPackageSecretApprovalsSchema = z
	.object({
		package_id: z.string().describe('Saved package id that needs approvals.'),
		kody_id: z
			.string()
			.describe(
				'Package name leaf that needs approvals (same value as `slug`).',
			),
		slug: z.string().describe('Package name leaf that needs approvals.'),
		secrets: z
			.array(
				z.object({
					secret_name: z.string(),
					approval_url: z
						.string()
						.describe('Per-secret package approval URL in the account UI.'),
				}),
			)
			.describe('User secrets that still need package approval.'),
		bulk_approval_url: z
			.string()
			.nullable()
			.describe(
				'One-click bulk approval URL when two or more secrets still need package approval; prefer this over individual links.',
			),
	})
	.nullable()
	.describe(
		'Pending user-secret package approvals detected from secretMounts and secret placeholders. Null when none are pending. Do not treat the package as ready to run until the user approves these and a static-import smoke test from execute succeeds against a read-only export or dry-run input that actually uses the approved secret.',
	)

export function toPackageSummary(savedPackage: SavedPackageRecord) {
	return {
		package_id: savedPackage.id,
		kody_id: savedPackage.kodyId,
		slug: savedPackage.kodyId,
		name: savedPackage.name,
		description: savedPackage.description,
		tags: savedPackage.tags,
		has_app: savedPackage.hasApp,
		hidden: savedPackage.hidden,
		visibility: savedPackage.isPrivate
			? ('private' as const)
			: ('public' as const),
		internet_visible: savedPackage.isInternetVisible,
		locked_at: savedPackage.lockedAt ?? null,
		source_id: savedPackage.sourceId,
		created_at: savedPackage.createdAt,
		updated_at: savedPackage.updatedAt,
	}
}

export function toPackageSummaryWithCommunityProvenance(
	savedPackage: SavedPackageWithCommunityProvenanceRecord,
) {
	return {
		...toPackageSummary(savedPackage),
		source_listing_id: savedPackage.sourceListingId,
		listing_current: savedPackage.listingCurrent,
		listing_kody_id: savedPackage.listingKodyId,
		listing_name: savedPackage.listingName,
		origin_commit: savedPackage.originCommit,
		listing_pinned_commit: savedPackage.listingPinnedCommit,
		listing_published_at: savedPackage.listingPublishedAt,
		listing_ahead: savedPackage.listingAhead,
	}
}

export const packageExportSurfaceSchema = z.object({
	subpath: z
		.string()
		.describe('Package export subpath from package.json exports.'),
	import_specifier: z
		.string()
		.describe('Ready-to-use kody: import specifier for this export.'),
	runtime_target: z
		.string()
		.nullable()
		.describe('Package-relative runtime source path for this export.'),
	types_path: z
		.string()
		.nullable()
		.describe(
			'Package-relative types source path for this export, when declared.',
		),
	description: z
		.string()
		.nullable()
		.describe('Export description parsed from JSDoc when available.'),
	type_definition: z
		.string()
		.nullable()
		.describe(
			'Primary export type signature parsed from source when available. Null when the export has more than one callable function; use `functions` in that case.',
		),
	functions: z
		.array(
			z.object({
				name: z
					.string()
					.describe(
						'Exported function name. Default exports use the name "default".',
					),
				description: z
					.string()
					.nullable()
					.describe('Function JSDoc description when available.'),
				type_definition: z
					.string()
					.nullable()
					.describe(
						'Function type signature parsed from source when available.',
					),
			}),
		)
		.describe(
			'Callable functions extracted from this export. Namespace modules that export several helpers list each one here.',
		),
	referenced_types: z
		.array(
			z.object({
				name: z.string(),
				kind: z.enum(['type', 'interface', 'enum']),
				definition: z
					.string()
					.describe('Source text of the referenced type, interface, or enum.'),
			}),
		)
		.describe(
			"Type, interface, and enum definitions referenced by this export's callable functions.",
		),
})

export const packageCredentialNeedSchema = z.object({
	key: z.string(),
	kind: z
		.enum(packageCredentialKindValues)
		.optional()
		.describe(
			'When set, only credentials of this kind match. When omitted, any fetch-capable credential (secret, oauth, login) for the provider matches.',
		),
	provider: z.string(),
	description: z.string(),
	multiple: z.boolean(),
	from: z
		.string()
		.optional()
		.describe('The imported package that declares this need, when inherited.'),
	status: z
		.enum(['ready', 'ambiguous', 'unbound'])
		.describe(
			'ready: exactly one of your credentials matches the need (kind filter and provider) and resolves with no call map entry. ambiguous: several match; pick one with a call map. unbound: none match.',
		),
	autoPick: z
		.string()
		.nullable()
		.describe('The credential name used when no call map entry is given.'),
	yourOptions: z
		.array(
			z.object({
				name: z.string(),
				scope: z.enum(['org', 'personal']),
				org: z.string().optional(),
				hosts: z.array(z.string()),
			}),
		)
		.describe(
			'Credentials you can Use that a call map may pick: the matches, plus matching-kind credentials with no provider (set their provider to auto-resolve).',
		),
})

export const packageDetailSchema =
	packageSummaryWithCommunityProvenanceSchema.extend({
		published_commit: z
			.string()
			.nullable()
			.describe(
				'Current published Artifacts commit for this package source (same field as `repoShowPublishNote` defaults to). Null when nothing has been published yet.',
			),
		exports: z.array(packageExportSurfaceSchema),
		package_secrets: z
			.array(secretMetadataSchema)
			.describe(
				'FYI metadata for package-scoped secrets owned by this package, including package_id. Never plaintext values. These are not execute-usable via search; using them still requires package context.',
			),
		credentials: z
			.object({
				needs: z.array(packageCredentialNeedSchema),
			})
			.describe(
				'Credential needs (ADR 0068): the published `kody.credentials` closure, including needs inherited from statically imported packages (`from`), each with how it resolves for you. Options list only credentials you can Use; never values.',
			),
	})
