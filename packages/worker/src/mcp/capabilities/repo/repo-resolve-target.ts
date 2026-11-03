import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveOwnedPackageSource } from '#mcp/capabilities/packages/resolve-package-source.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	getEntitySourceByEntity,
	getEntitySourceByIdForUser,
} from '#worker/repo/entity-sources.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import { getUserRepoById, getUserRepoByName } from '#worker/repo/user-repos.ts'
import type {
	repoOpenSessionInputSchema,
	repoResolvedTargetSchema,
	repoTargetSchema,
} from './repo-shared.ts'

type RepoTarget = z.infer<typeof repoTargetSchema>
type RepoOpenSessionInput = z.infer<typeof repoOpenSessionInputSchema>
type RepoResolvedTarget = z.infer<typeof repoResolvedTargetSchema>

async function requireOwnedEntitySource(input: {
	db: D1Database
	userId: OwnerId
	sourceId: string
}): Promise<EntitySourceRow> {
	const source = await getEntitySourceByIdForUser(input.db, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (!source) {
		throw new McpCallerError('Repo source was not found for this user.')
	}
	return source
}

function toResolvedSourceTarget(source: EntitySourceRow): RepoResolvedTarget {
	return {
		kind: 'source',
		source_id: source.id,
		entity_kind: source.entity_kind,
		entity_id: source.entity_id,
	}
}

async function requirePackageTarget(input: {
	db: D1Database
	userId: OwnerId
	ownerScope: string
	target: Extract<RepoTarget, { kind: 'package' }>
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	const resolved = await resolveOwnedPackageSource({
		db: input.db,
		userId: input.userId,
		ownerScope: input.ownerScope,
		args:
			'package_id' in input.target
				? { package_id: input.target.package_id }
				: { kody_id: input.target.kody_id },
	})
	return {
		source: resolved.source,
		resolvedTarget: {
			kind: 'package',
			source_id: resolved.source.id,
			package_id: resolved.packageId,
			kody_id: resolved.kodyId,
			name: resolved.name,
		},
	}
}

async function requirePlainRepoTarget(input: {
	db: D1Database
	userId: OwnerId
	target: Extract<RepoTarget, { kind: 'repo' }>
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	const userRepo =
		'repo_id' in input.target
			? await getUserRepoById(input.db, {
					userId: input.userId,
					repoId: input.target.repo_id,
				})
			: await getUserRepoByName(input.db, {
					userId: input.userId,
					name: input.target.name,
				})
	if (!userRepo) {
		const missingId =
			'repo_id' in input.target ? input.target.repo_id : input.target.name
		throw new McpCallerError(`Plain repo "${missingId}" was not found.`)
	}
	const source = await getEntitySourceByEntity(input.db, {
		userId: input.userId,
		entityKind: 'repo',
		entityId: userRepo.id,
	})
	if (!source) {
		throw new McpCallerError('Repo source was not found for this user.')
	}
	return {
		source,
		resolvedTarget: {
			kind: 'repo',
			source_id: source.id,
			repo_id: userRepo.id,
			name: userRepo.name,
		},
	}
}

export async function resolveRepoSourceReference(input: {
	db: D1Database
	userId: OwnerId
	ownerScope: string
	args: Pick<RepoOpenSessionInput, 'source_id' | 'target'>
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	if (input.args.source_id) {
		const source = await requireOwnedEntitySource({
			db: input.db,
			userId: input.userId,
			sourceId: input.args.source_id,
		})
		return {
			source,
			resolvedTarget: await resolveRepoTargetFromSource({
				db: input.db,
				userId: input.userId,
				sourceId: source.id,
			}),
		}
	}
	if (!input.args.target) {
		throw new McpCallerError('Repo source identity is required.')
	}
	switch (input.args.target.kind) {
		case 'package':
			return requirePackageTarget({
				db: input.db,
				userId: input.userId,
				ownerScope: input.ownerScope,
				target: input.args.target,
			})
		case 'repo':
			return requirePlainRepoTarget({
				db: input.db,
				userId: input.userId,
				target: input.args.target,
			})
		default: {
			const target: never = input.args.target
			throw new McpCallerError(
				`Unsupported repo target kind: ${String(target)}`,
			)
		}
	}
}

export async function resolveRepoTargetFromSource(input: {
	db: D1Database
	userId: OwnerId
	sourceId: string
}): Promise<RepoResolvedTarget> {
	const source = await requireOwnedEntitySource({
		db: input.db,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	switch (source.entity_kind) {
		case 'package': {
			const savedPackage = await getSavedPackageById(input.db, {
				userId: input.userId,
				packageId: source.entity_id,
			})
			if (!savedPackage) {
				return toResolvedSourceTarget(source)
			}
			return {
				kind: 'package',
				source_id: source.id,
				package_id: savedPackage.id,
				kody_id: savedPackage.kodyId,
				name: savedPackage.name,
			}
		}
		case 'repo': {
			const userRepo = await getUserRepoById(input.db, {
				userId: input.userId,
				repoId: source.entity_id,
			})
			if (!userRepo) {
				return toResolvedSourceTarget(source)
			}
			return {
				kind: 'repo',
				source_id: source.id,
				repo_id: userRepo.id,
				name: userRepo.name,
			}
		}
		default: {
			const entityKind: never = source.entity_kind
			throw new McpCallerError(
				`Unsupported entity source kind: ${String(entityKind)}`,
			)
		}
	}
}
