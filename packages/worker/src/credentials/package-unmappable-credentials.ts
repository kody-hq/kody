/**
 * Unmappable package credentials: credentials a package resolves for whoever
 * runs or visits it that nobody can swap for their own, so they always act as
 * the owning org. A need is unmappable when it declares
 * `ownerCredentialForVisitors: true`, or `supplier: "publisher"` while the
 * `package-credential-suppliers` flag is on for the org. While a package's
 * published closure has one, only org Owners may change or publish it (see
 * `docs/guides/package-sharing.md#unmappable-credentials`).
 */
import * as Sentry from '@sentry/cloudflare'
import { isPackageCredentialSuppliersEnabled } from '#worker/credentials/credential-suppliers-flag.ts'
import { type CredentialNeed } from '#worker/credentials/credential-needs.ts'
import { getLatestPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'
import { visitorCredentialIdsByNeedKey } from '#worker/package-capabilities/capability-set.ts'
// Type-only and erased: repo/types.ts pulls in Workers-only modules at runtime.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { EntitySourceRow } from '#worker/repo/types.ts'
import { memoizePerRequest } from '#worker/request-context.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'

export type UnmappableCredential = {
	/** The need the credential fills. */
	needKey: string
	/** The credential's name, or null when the need has no credential picked yet. */
	credentialName: string | null
	/** `publisher`: a publisher-supplied need. `visitors`: shared with app visitors. */
	reason: 'publisher' | 'visitors' | 'unchecked'
}

/** The permissions only an org Owner keeps on a package with unmappable credentials. */
export const unmappableCredentialLockedPermissions = [
	'package:write',
	'package:publish',
] as const

export function isUnmappableCredentialLockedPermission(
	permission: string,
): permission is (typeof unmappableCredentialLockedPermissions)[number] {
	return (
		unmappableCredentialLockedPermissions as ReadonlyArray<string>
	).includes(permission)
}

export function isUnmappableNeed(
	need: Pick<CredentialNeed, 'ownerCredentialForVisitors' | 'supplier'>,
	suppliersEnabled: boolean,
) {
	return (
		need.ownerCredentialForVisitors === true ||
		(suppliersEnabled && need.supplier === 'publisher')
	)
}

type PackageRow = { id: string; source_id: string | null }

type EntitySource = EntitySourceRow

async function loadPackageRows(
	db: D1Database,
	orgId: string,
	packageIds: ReadonlyArray<string>,
) {
	const rows: Array<PackageRow> = []
	for (const chunk of chunkArray([...packageIds], maxD1BoundParameters - 1)) {
		const result = await db
			.prepare(
				`SELECT id, source_id FROM saved_packages
				 WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
			)
			.bind(orgId, ...chunk)
			.all<PackageRow>()
		rows.push(...(result.results ?? []))
	}
	return rows
}

async function describePackage(input: {
	env: Env
	orgId: string
	packageId: string
	source: EntitySource | null
	suppliersEnabled: boolean
	request?: object | null
}): Promise<Array<UnmappableCredential>> {
	const { env, orgId, packageId, source } = input
	if (!source?.published_commit) return []
	// Loaded lazily: these pull in Workers-only modules, and this module is
	// reachable from Node tooling (the OpenAPI generator) through capabilities.
	const { loadPublishedCredentialNeeds } =
		await import('#worker/credentials/credential-needs-closure.ts')
	const needs = await loadPublishedCredentialNeeds({
		env,
		userId: orgId,
		sourceId: source.id,
		source,
		supplierSemanticsEnabled: input.suppliersEnabled,
		request: input.request,
	})
	const unmappable = needs.filter((need) =>
		isUnmappableNeed(need, input.suppliersEnabled),
	)
	if (unmappable.length === 0) return []
	const keys = new Set(unmappable.map((need) => need.key))
	const idsByNeed = new Map<string, Set<string>>()
	const add = (needKey: string, ids: Iterable<string>) => {
		const set = idsByNeed.get(needKey) ?? new Set<string>()
		for (const id of ids) set.add(id)
		idsByNeed.set(needKey, set)
	}
	const { loadAllCredentialMappingsForPackage } =
		await import('#worker/credentials/credential-mappings.ts')
	const mappings = await loadAllCredentialMappingsForPackage({
		db: env.APP_DB,
		orgId,
		packageId,
	})
	for (const row of mappings) {
		if (row.target.target !== 'org' || !keys.has(row.needKey)) continue
		add(row.needKey, row.credentialIds)
	}
	if (unmappable.some((need) => need.ownerCredentialForVisitors)) {
		const approval = await getLatestPackageCapabilityApproval(env.APP_DB, {
			packageId,
			ownerUserId: orgId,
		})
		if (approval && approval.publishedCommit === source.published_commit) {
			for (const [needKey, ids] of visitorCredentialIdsByNeedKey(
				approval.capabilitySetJson,
			)) {
				if (keys.has(needKey)) add(needKey, ids)
			}
		}
	}
	const { listOrgCredentialsByIds } =
		await import('#worker/credentials/credential-ids.ts')
	const credentials = await listOrgCredentialsByIds(
		env.APP_DB,
		orgId,
		[...idsByNeed.values()].flatMap((ids) => [...ids]),
	)
	const result: Array<UnmappableCredential> = []
	for (const need of unmappable) {
		const reason = need.ownerCredentialForVisitors ? 'visitors' : 'publisher'
		const names = [
			...new Set(
				[...(idsByNeed.get(need.key) ?? [])].flatMap((id) => {
					const credential = credentials.get(id)
					return credential?.live ? [credential.name] : []
				}),
			),
		].sort()
		if (names.length === 0) {
			result.push({ needKey: need.key, credentialName: null, reason })
			continue
		}
		for (const name of names) {
			result.push({ needKey: need.key, credentialName: name, reason })
		}
	}
	return result
}

/**
 * Unmappable credentials per package id (packages with none are left out).
 * A package whose credentials cannot be read counts as locked, so a failed
 * read never hands out change rights.
 */
export async function loadPackageUnmappableCredentials(input: {
	env: Env
	orgId: string
	packageIds: ReadonlyArray<string>
	request?: object | null
}): Promise<Map<string, Array<UnmappableCredential>>> {
	const packageIds = [...new Set(input.packageIds.filter(Boolean))].sort()
	const locks = new Map<string, Array<UnmappableCredential>>()
	if (packageIds.length === 0) return locks
	return await memoizePerRequest({
		key: `package-unmappable-credentials:${input.orgId}:${packageIds.join(',')}`,
		load: async () => {
			let rows: Array<PackageRow>
			let sources: Map<string, EntitySource>
			let suppliersEnabled: boolean
			try {
				rows = await loadPackageRows(input.env.APP_DB, input.orgId, packageIds)
				if (rows.length === 0) return locks
				const sourceIds = rows.flatMap((row) =>
					row.source_id ? [row.source_id] : [],
				)
				sources = new Map(
					(
						await (
							await import('#worker/repo/entity-sources.ts')
						).listEntitySourcesByIds(input.env.APP_DB, sourceIds)
					).map((source) => [source.id, source]),
				)
				suppliersEnabled = await isPackageCredentialSuppliersEnabled({
					db: input.env.APP_DB,
					orgId: input.orgId,
					request: input.request,
				})
			} catch (error) {
				Sentry.captureException(error, {
					tags: { scope: 'packages.unmappable-credentials' },
				})
				for (const packageId of packageIds) {
					locks.set(packageId, [
						{ needKey: '', credentialName: null, reason: 'unchecked' },
					])
				}
				return locks
			}
			await Promise.all(
				rows.map(async (row) => {
					try {
						const credentials = await describePackage({
							env: input.env,
							orgId: input.orgId,
							packageId: row.id,
							source: row.source_id
								? (sources.get(row.source_id) ?? null)
								: null,
							suppliersEnabled,
							request: input.request,
						})
						if (credentials.length > 0) locks.set(row.id, credentials)
					} catch (error) {
						Sentry.captureException(error, {
							tags: { scope: 'packages.unmappable-credentials' },
							extra: { packageId: row.id },
						})
						locks.set(row.id, [
							{ needKey: '', credentialName: null, reason: 'unchecked' },
						])
					}
				}),
			)
			return locks
		},
	})
}

export async function loadOnePackageUnmappableCredentials(input: {
	env: Env
	orgId: string
	packageId: string
	request?: object | null
}) {
	const locks = await loadPackageUnmappableCredentials({
		...input,
		packageIds: [input.packageId],
	})
	return locks.get(input.packageId) ?? []
}

/** `"Prod DB" (need "rooms-db")`, joined; never ids or values. */
/** Owner notices skip `unchecked` markers: those only fail collaborator changes closed. */
export function knownUnmappableCredentials(
	credentials: ReadonlyArray<UnmappableCredential>,
) {
	return credentials.filter((credential) => credential.reason !== 'unchecked')
}

export function describeUnmappableCredentials(
	credentials: ReadonlyArray<UnmappableCredential>,
) {
	if (credentials.some((credential) => credential.reason === 'unchecked')) {
		return 'its credentials could not be checked just now'
	}
	return credentials
		.map((credential) =>
			credential.credentialName
				? `"${credential.credentialName}" (need "${credential.needKey}")`
				: `need "${credential.needKey}" (no credential picked yet; it fills from the owning org's credentials)`,
		)
		.join(', ')
}

/** The share-time warning, the same words on every surface. */
export function unmappableCredentialShareWarning(input: {
	packageLabel: string
	credentials: ReadonlyArray<UnmappableCredential>
	changesAllowed: boolean
}) {
	const list = describeUnmappableCredentials(input.credentials)
	const risk = `${input.packageLabel} has unmappable credentials: ${list}. They always act as the owning org: nobody who runs or visits the package can swap in their own. Anyone who can change or publish its code could make the package's code use them however they like.`
	return input.changesAllowed
		? `${risk} This grant allows changes despite unmappable credentials, so this collaborator could make the package's code use them.`
		: `${risk} Until an org Owner allows changes despite unmappable credentials on this grant, this collaborator can run the package but cannot push, publish, or otherwise change it.`
}

/**
 * What an Owner sees on the package page, Collaborators tab, and dev check /
 * publish output while the package has unmappable credentials.
 */
export function unmappableCredentialOwnerNotice(input: {
	packageLabel: string
	credentials: ReadonlyArray<UnmappableCredential>
}) {
	return `${input.packageLabel} has unmappable credentials: ${describeUnmappableCredentials(input.credentials)}. They always act as the owning org, so changes are owner-only: collaborators (people, teams, and their profiles) keep running it but cannot push, publish, or otherwise change its code or manifest. ${unmappableCredentialAllowHint}`
}

/** How an Owner lifts the lock for one collaborator. */
export const unmappableCredentialAllowHint =
	'An org Owner can allow one person or team anyway: the "Allow changes despite unmappable credentials" option on their grant in the package\'s Collaborators tab, `kody package grant <package> --user <name> --preset contribute --allow-changes-despite-unmappable-credentials`, or packageCollaboratorSet / accessGrant with allow_changes_despite_unmappable_credentials: true.'
