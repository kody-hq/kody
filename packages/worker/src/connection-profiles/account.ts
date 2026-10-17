import {
	buildConnectionProfileMcpUrl,
	connectionProfileNameMaxLength,
} from '#universal/connection-profiles/names.ts'
import { connectionProfilesFlagKey } from '#universal/feature-flags/registry.ts'
import { type AccountConnectionProfileView } from '#universal/loader-data.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import {
	createConnectionProfile,
	deleteConnectionProfile,
	listConnectionProfiles,
	updateConnectionProfile,
	type ConnectionProfileRecord,
} from '#worker/connection-profiles/repo.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { buildMcpServerUrl } from '#worker/onboarding-prompts.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export { connectionProfileNameMaxLength }

function toProfileView(input: {
	profile: ConnectionProfileRecord
	mcpServerUrl: string
}): AccountConnectionProfileView {
	return {
		id: input.profile.id,
		name: input.profile.name,
		grants: input.profile.grants,
		mcpServerUrl: input.mcpServerUrl
			? buildConnectionProfileMcpUrl({
					mcpServerUrl: input.mcpServerUrl,
					profileName: input.profile.name,
				})
			: '',
		createdAt: input.profile.createdAt,
		updatedAt: input.profile.updatedAt,
	}
}

export async function isConnectionProfilesEnabledForUser(input: {
	db: D1Database
	userId: string
}) {
	try {
		const row = await input.db
			.prepare(
				`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(input.userId)
			.first<{ id: number }>()
		if (!row) return false
		return await isFeatureEnabled(input.db, connectionProfilesFlagKey, row.id)
	} catch {
		// Fail closed: profiles stay hidden when flag evaluation cannot run.
		return false
	}
}

export async function loadConnectionProfilesForAccount(input: {
	env: Env
	requestUrl: string | URL
	userId: string
	emailVerified: boolean
}): Promise<{
	connectionProfilesEnabled: boolean
	connectionProfiles: Array<AccountConnectionProfileView>
	connectionProfilePackageOptions: Array<{
		id: string
		name: string
		kodyId: string
	}>
}> {
	const enabled = await isConnectionProfilesEnabledForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	if (!enabled) {
		return {
			connectionProfilesEnabled: false,
			connectionProfiles: [],
			connectionProfilePackageOptions: [],
		}
	}
	const mcpServerUrl = input.emailVerified
		? buildMcpServerUrl({ env: input.env, requestUrl: input.requestUrl })
		: ''
	const [profiles, packages] = await Promise.all([
		listConnectionProfiles({
			db: input.env.APP_DB,
			userId: input.userId,
		}),
		listSavedPackagesByUserId(input.env.APP_DB, { userId: input.userId }),
	])
	return {
		connectionProfilesEnabled: true,
		connectionProfiles: profiles.map((profile) =>
			toProfileView({ profile, mcpServerUrl }),
		),
		connectionProfilePackageOptions: packages.map((pkg) => ({
			id: pkg.id,
			name: pkg.name,
			kodyId: pkg.kodyId,
		})),
	}
}

async function writeConnectionProfile<T>(input: {
	env: Env
	userId: string
	write: () => Promise<T>
}): Promise<
	{ ok: true; result: T } | { ok: false; error: string; status: number }
> {
	const enabled = await isConnectionProfilesEnabledForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	if (!enabled) {
		return {
			ok: false,
			error: 'Connection profiles are not enabled for this account.',
			status: 404,
		}
	}
	try {
		return { ok: true, result: await input.write() }
	} catch (error) {
		if (error instanceof McpCallerError) {
			return { ok: false, error: error.message, status: 400 }
		}
		if (error instanceof Error) {
			return { ok: false, error: error.message, status: 400 }
		}
		throw error
	}
}

type ProfileWriteContext = Omit<
	Parameters<typeof writeConnectionProfile>[0],
	'write'
>
export function createAccountConnectionProfile(
	input: ProfileWriteContext & { name: string; grants: unknown },
) {
	return writeConnectionProfile({
		...input,
		write: () =>
			createConnectionProfile({
				db: input.env.APP_DB,
				userId: input.userId,
				orgId: input.userId,
				name: input.name,
				grants: input.grants,
			}),
	})
}
export function updateAccountConnectionProfile(
	input: ProfileWriteContext & {
		profileId: string
		name?: string
		grants?: unknown
	},
) {
	return writeConnectionProfile({
		...input,
		write: () =>
			updateConnectionProfile({
				db: input.env.APP_DB,
				userId: input.userId,
				profileId: input.profileId,
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.grants !== undefined ? { grants: input.grants } : {}),
			}),
	})
}
export function deleteAccountConnectionProfile(
	input: ProfileWriteContext & { profileId: string },
) {
	return writeConnectionProfile({
		...input,
		write: () =>
			deleteConnectionProfile({
				db: input.env.APP_DB,
				userId: input.userId,
				profileId: input.profileId,
			}),
	})
}
