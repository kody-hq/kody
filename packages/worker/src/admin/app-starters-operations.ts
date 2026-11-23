import { adminOperationResult } from './operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	addAppStarter,
	AppStarterError,
	removeAppStarter,
	reorderAppStarters,
	updateAppStarter,
} from '#worker/app-starters/service.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import type {
	AddAppStarterInput,
	RemoveAppStarterInput,
	ReorderAppStartersInput,
	UpdateAppStarterInput,
} from '#universal/admin-setting-mutations.ts'

async function runAppStarterOperation(input: {
	env: Env
	request: Request
	action: string
	reason: string
	run: () => Promise<unknown>
}) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	try {
		await input.run()
	} catch (error) {
		if (error instanceof AppStarterError) {
			return adminOperationResult(
				{ ok: false as const, error: error.message },
				error.status,
			)
		}
		throw error
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: input.action,
		result: 'success',
		email: actor.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: '/admin/starter-templates',
		reason: input.reason,
	})
	return adminOperationResult({ ok: true as const })
}

export function addAdminAppStarter(input: {
	env: Env
	request: Request
	fields: AddAppStarterInput
}) {
	return runAppStarterOperation({
		...input,
		action: 'app_starter_add',
		reason: `package=${input.fields.package}`,
		run: () =>
			addAppStarter({
				env: input.env,
				packageRef: input.fields.package,
				rank: input.fields.rank,
				enabled: input.fields.enabled,
			}),
	})
}

export function updateAdminAppStarter(input: {
	env: Env
	request: Request
	fields: UpdateAppStarterInput
}) {
	return runAppStarterOperation({
		...input,
		action: 'app_starter_update',
		reason: `package_id=${input.fields.packageId}`,
		run: () => updateAppStarter({ env: input.env, ...input.fields }),
	})
}

export function removeAdminAppStarter(input: {
	env: Env
	request: Request
	fields: RemoveAppStarterInput
}) {
	return runAppStarterOperation({
		...input,
		action: 'app_starter_remove',
		reason: `package_id=${input.fields.packageId}`,
		run: () =>
			removeAppStarter({ env: input.env, packageId: input.fields.packageId }),
	})
}

export function reorderAdminAppStarters(input: {
	env: Env
	request: Request
	fields: ReorderAppStartersInput
}) {
	return runAppStarterOperation({
		...input,
		action: 'app_starter_reorder',
		reason: `count=${String(input.fields.packageIds.length)}`,
		run: () =>
			reorderAppStarters({
				env: input.env,
				packageIds: input.fields.packageIds,
			}),
	})
}
