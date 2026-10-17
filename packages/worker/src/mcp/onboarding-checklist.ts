import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	readCurrentEntitlementResourceUsage,
	type EntitlementUsageEnv,
} from '#worker/entitlements/service.ts'
import { listMemoriesByUserId } from '#mcp/memory/repo.ts'
import {
	userHasFirstExecute,
	userHasFirstSearch,
} from '#worker/identity/activation-stamps.ts'
import {
	type OnboardingChecklistItem,
	type OnboardingChecklistItemId,
} from '#universal/onboarding-process.ts'

/**
 * Derived onboarding progress. Every item is computed from data the platform
 * already stores. Dismissal lives on `users.onboarding_checklist_dismissed_at`.
 */

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export type { OnboardingChecklistItem, OnboardingChecklistItemId }

export type OnboardingChecklist = {
	items: Array<OnboardingChecklistItem>
	complete: boolean
}

export type OnboardingChecklistEnv = Pick<Env, 'APP_DB'> & EntitlementUsageEnv

/**
 * Compute the checklist from existing signals: MCP OAuth grants (passed in),
 * a Step 2 access win (first search, memory, execute, or package), a second host grant,
 * and the saved-package meter. Individual probe failures fail open to "not
 * done" so a storage blip never breaks onboarding surfaces. The optional
 * first-win email loop is not a checklist item.
 */
// Activation and dismissal are person-keyed. Resources are org-keyed.
// OAuth and activation APIs still brand their person storage keys as OwnerId.
export async function loadOnboardingAccessWin(
	env: OnboardingChecklistEnv,
	userId: OwnerId,
	personId: OwnerId,
): Promise<boolean> {
	const [firstSearch, execute, memories, savedPackages] = await Promise.all([
		userHasFirstSearch(env.APP_DB, personId).catch(() => false),
		userHasFirstExecute(env.APP_DB, personId).catch(() => false),
		listMemoriesByUserId(env.APP_DB, userId, { limit: 1 })
			.then((rows) => rows.length > 0)
			.catch(() => false),
		readCurrentEntitlementResourceUsage({
			db: env.APP_DB,
			env,
			userId,
			resource: 'saved_packages',
			now: new Date(),
		})
			.then((count) => count > 0)
			.catch(() => false),
	])
	return firstSearch || execute || memories || savedPackages
}

/**
 * Newest active memory subject for Step 3 reuse chrome. This is newest-active,
 * not a recorded Step 2 snapshot — the chip truncates long subjects and hides
 * if nothing sensible remains. Fail-open to null so a storage blip never
 * invents an artifact.
 */
export async function loadOnboardingAccessWinMemorySubject(
	env: OnboardingChecklistEnv,
	userId: OwnerId,
): Promise<string | null> {
	try {
		const rows = await listMemoriesByUserId(env.APP_DB, userId, {
			statuses: ['active'],
			limit: 1,
		})
		const subject = rows[0]?.subject.trim()
		return subject ? subject : null
	} catch {
		return null
	}
}

export async function deriveOnboardingChecklist(input: {
	env: OnboardingChecklistEnv
	userId: OwnerId
	personId: OwnerId
	emailVerified: boolean
	hasMcpClient: boolean
	hasAccessWin?: boolean
	hasSecondMcpClient?: boolean
	savedPackageCount?: number
	now?: Date
}): Promise<OnboardingChecklist> {
	const { env, userId } = input
	const now = input.now ?? new Date()
	const [hasAccessWin, savedPackages] = await Promise.all([
		input.hasAccessWin === undefined
			? loadOnboardingAccessWin(env, userId, input.personId)
			: input.hasAccessWin,
		input.savedPackageCount ??
			readCurrentEntitlementResourceUsage({
				db: env.APP_DB,
				env,
				userId,
				resource: 'saved_packages',
				now,
			}).catch(() => 0),
	])

	const items: Array<OnboardingChecklistItem> = [
		{ id: 'verify-email', done: input.emailVerified },
		{ id: 'connect-agent', done: input.hasMcpClient },
		{ id: 'give-access', done: hasAccessWin === true },
		{
			id: 'connect-second-agent',
			done: input.hasSecondMcpClient === true,
		},
		{ id: 'install-starter', done: savedPackages > 0 },
	]
	return {
		items,
		complete: items.every((item) => item.done),
	}
}

export async function readOnboardingChecklistDismissed(input: {
	env: Pick<Env, 'APP_DB'>
	personId: OwnerId
}): Promise<boolean> {
	try {
		const dismissedAt = await readDismissedAtColumn(
			input.env.APP_DB,
			input.personId,
		)
		return Boolean(dismissedAt)
	} catch {
		return false
	}
}

export async function dismissOnboardingChecklist(input: {
	env: Pick<Env, 'APP_DB'>
	personId: OwnerId
}): Promise<void> {
	await writeDismissedAtColumn(
		input.env.APP_DB,
		input.personId,
		new Date().toISOString(),
	)
}

async function readDismissedAtColumn(db: D1Database, personId: OwnerId) {
	const row = await db
		.prepare(
			`SELECT onboarding_checklist_dismissed_at
			 FROM users
			 WHERE stable_user_id = ?
			 ${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(personId)
		.first<{ onboarding_checklist_dismissed_at: string | null }>()
	const dismissedAt = row?.onboarding_checklist_dismissed_at?.trim()
	return dismissedAt ? dismissedAt : null
}

async function writeDismissedAtColumn(
	db: D1Database,
	personId: OwnerId,
	dismissedAt: string,
) {
	await db
		.prepare(
			`UPDATE users
			 SET onboarding_checklist_dismissed_at = ?,
			     updated_at = CURRENT_TIMESTAMP
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(dismissedAt, personId)
		.run()
}
