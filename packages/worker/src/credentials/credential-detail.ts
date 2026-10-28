/**
 * What the Credentials detail pane adds to a list row: the placeholder that
 * fills it, the team orgs a personal credential is granted to, and which of
 * the org's package needs it can fill. Reads no value.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import * as Sentry from '@sentry/cloudflare'
import { type CredentialListItem } from '#universal/credential-contracts.ts'
import {
	type AccountCredentialDetail,
	type CredentialNeedFit,
} from '#universal/credentials-list.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	listUsableCredentialsByPackage,
	resolveNeedCandidates,
} from './credential-candidates.ts'
import { readCredentialHostSettings } from './credential-hosts.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
import { savedCredentialNeeds } from './credential-needs.ts'
import { isPackageCredentialSuppliersEnabled } from './credential-suppliers-flag.ts'
import { readFillPlacementObservation } from './fill-placement-observations.ts'

/** Each package costs a closure read, so usage checks the most recent ones. */
export const maxUsagePackages = 40

const placeholderNamePattern = /^[a-zA-Z0-9._-]+$/

/**
 * The placeholder code writes for `credential`, or null when none reaches it.
 * Placeholders and `credential()` resolve the same set, so a personal
 * credential granted to the bound org shows the same placeholder as an org
 * credential (it still only works in the owner's runs).
 */
export function credentialPlaceholder(credential: CredentialListItem) {
	if (!placeholderNamePattern.test(credential.name)) return null
	switch (credential.kind) {
		case 'secret':
			return credential.packageId
				? `{{secret:${credential.name}|scope=package}}`
				: `{{secret:${credential.name}}}`
		case 'oauth':
			return `{{integration-token:${credential.name}}}`
		case 'mcp':
		case 'url':
		case 'login':
		case 'signing':
			return null
		default: {
			const exhaustive: never = credential.kind
			return exhaustive
		}
	}
}

async function listGrants(db: D1Database, credentialId: string) {
	const result = await db
		.prepare(
			`SELECT o.slug AS slug, COALESCE(o.display_name, o.slug) AS name,
				g.created_at AS created_at
			FROM credential_org_grants g JOIN orgs o ON o.id = g.org_id
			WHERE g.credential_id = ? AND o.deleted_at IS NULL
			ORDER BY o.slug`,
		)
		.bind(credentialId)
		.all<{ slug: string; name: string; created_at: string }>()
	return (result.results ?? []).map((row) => ({
		orgSlug: row.slug,
		orgName: row.name,
		grantedAt: row.created_at,
	}))
}

async function listUsage(input: {
	env: Env
	request: RequestContext
	orgId: string
	credentialId: string
	packages: ReadonlyArray<SavedPackageRecord>
}) {
	// Shared org/personal/MCP rows load once; package-bound Keys are batched
	// (KODY-BD). Closures still run per package in parallel, but the suppliers
	// flag is evaluated once for the org and threaded with `request` so nested
	// dependency walks share the same memo (Sentry KODY-BW / KODY-BT /
	// KODY-BV). A flag failure marks usage unreadable once instead of failing
	// the whole detail.
	let supplierSemanticsEnabled: boolean
	try {
		supplierSemanticsEnabled = await isPackageCredentialSuppliersEnabled({
			db: input.env.APP_DB,
			orgId: input.orgId,
			request: input.request,
		})
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: 'credentials.detail.usage' },
			extra: { orgId: input.orgId },
		})
		return { usage: [], unreadable: input.packages.length }
	}
	const [usableByPackage, needResults] = await Promise.all([
		listUsableCredentialsByPackage({
			env: input.env,
			request: input.request,
			packageIds: input.packages.map((pkg) => pkg.id),
		}),
		Promise.all(
			input.packages.map(async (pkg) => {
				try {
					const needs = savedCredentialNeeds(
						await loadPublishedCredentialNeeds({
							env: input.env,
							userId: input.orgId,
							sourceId: pkg.sourceId,
							supplierSemanticsEnabled,
							request: input.request,
						}),
					)
					return { pkg, needs }
				} catch (error) {
					Sentry.captureException(error, {
						tags: { scope: 'credentials.detail.usage' },
						extra: { packageId: pkg.id },
					})
					return { pkg, needs: null }
				}
			}),
		),
	])
	const packageViews = needResults.map(({ pkg, needs }) => ({
		pkg,
		needs,
		usable: usableByPackage.get(pkg.id) ?? [],
	}))
	const usage: AccountCredentialDetail['usage'] = []
	let unreadable = 0
	for (const { pkg, needs, usable } of packageViews) {
		if (needs === null) {
			unreadable += 1
			continue
		}
		for (const need of needs) {
			const resolution = resolveNeedCandidates(need, usable)
			const fit: CredentialNeedFit | null =
				resolution.autoPick?.id === input.credentialId
					? 'auto'
					: resolution.candidates.some((c) => c.id === input.credentialId)
						? 'candidate'
						: resolution.possibleMatches.some(
									(c) => c.id === input.credentialId,
							  )
							? 'possible'
							: null
			if (fit) {
				usage.push({
					packageId: pkg.id,
					kodyId: pkg.kodyId,
					needKey: need.key,
					fit,
				})
			}
		}
	}
	return {
		usage: usage.sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.needKey.localeCompare(right.needKey),
		),
		unreadable,
	}
}

/**
 * A personal credential granted into a team org is edited from the personal
 * org that owns it, so only the org's own Keys and OAuth connections qualify.
 */
async function readEditableHostSettings(input: {
	db: D1Database
	orgId: string
	credential: CredentialListItem
}) {
	if (input.credential.scope === 'personal') return null
	switch (input.credential.kind) {
		case 'secret':
		case 'oauth':
			return readCredentialHostSettings({
				db: input.db,
				orgId: input.orgId,
				credential: {
					id: input.credential.id,
					kind: input.credential.kind === 'oauth' ? 'integration' : 'secret',
					name: input.credential.name,
					live: true,
				},
			})
		case 'mcp':
		case 'url':
		case 'login':
		case 'signing':
			return null
		default: {
			const exhaustive: never = input.credential.kind
			return exhaustive
		}
	}
}

export async function loadCredentialDetail(input: {
	env: Env
	request: RequestContext
	orgId: string
	/** The viewer's own credential, so its team-org grants are theirs to see. */
	ownedByViewer: boolean
	credential: CredentialListItem
	/** The org's packages, most recently updated first. */
	packages: ReadonlyArray<SavedPackageRecord>
}): Promise<AccountCredentialDetail> {
	// A package key fills its own package's placeholders and that package's
	// declared needs. A locked credential is never picked for a package
	// outside its locks.
	const locks = input.credential.lockedToPackageIds
	const reachable =
		locks.length > 0
			? input.packages.filter((pkg) => locks.includes(pkg.id))
			: input.packages
	const checked = input.credential.packageId
		? reachable.filter((pkg) => pkg.id === input.credential.packageId)
		: reachable.slice(0, maxUsagePackages)
	const [grants, usage, hostSettings, fillPlacementObservation] =
		await Promise.all([
			input.ownedByViewer
				? listGrants(input.env.APP_DB, input.credential.id)
				: [],
			checked.length > 0
				? listUsage({
						env: input.env,
						request: input.request,
						orgId: input.orgId,
						credentialId: input.credential.id,
						packages: checked,
					})
				: { usage: [], unreadable: 0 },
			readEditableHostSettings({
				db: input.env.APP_DB,
				orgId: input.orgId,
				credential: input.credential,
			}),
			showsFillPlacementObservation(input.credential.kind)
				? readFillPlacementObservation(input.env.APP_DB, input.credential.id)
				: null,
		])
	return {
		id: input.credential.id,
		placeholder: credentialPlaceholder(input.credential),
		grants,
		usage: usage.usage,
		usageTruncated:
			!input.credential.packageId && reachable.length > checked.length,
		usageUnreadable: usage.unreadable,
		hostSettings,
		fillPlacementObservation,
	}
}

function showsFillPlacementObservation(
	kind: CredentialListItem['kind'],
): boolean {
	switch (kind) {
		case 'secret':
		case 'oauth':
		case 'url':
		case 'login':
		case 'signing':
			return true
		case 'mcp':
			return false
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
