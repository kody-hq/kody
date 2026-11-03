import type { AdminReservedUsernamesLoaderData } from '#universal/loader-data.ts'
import { loadReservedUsernameAdminSnapshot } from '#worker/identity/reserved-username-settings.ts'

export async function loadAdminReservedUsernamesData(
	env: Env,
): Promise<AdminReservedUsernamesLoaderData> {
	const snapshot = await loadReservedUsernameAdminSnapshot(env)
	return {
		ok: true,
		...snapshot,
	}
}
