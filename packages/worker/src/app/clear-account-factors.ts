import { deletePasskeysForUser } from '#app/passkeys.ts'
import { disableTwoFactor } from '#worker/identity/two-factor.ts'

export type ClearedAccountFactors = {
	twoFactorRows: number
	passkeys: number
	oauthConnections: number
}

export function clearedFactorsAuditReason(cleared: ClearedAccountFactors) {
	return `two_factor=${cleared.twoFactorRows};passkeys=${cleared.passkeys};oauth_connections=${cleared.oauthConnections}`
}

export async function clearSecondFactorsAndConnections(
	d1: D1Database,
	userId: number,
): Promise<ClearedAccountFactors> {
	const twoFactorRows = await disableTwoFactor(d1, userId)
	const passkeys = await deletePasskeysForUser(d1, userId)
	const oauthResult = await d1
		.prepare(`DELETE FROM oauth_connections WHERE user_id = ?`)
		.bind(userId)
		.run()
	return {
		twoFactorRows,
		passkeys,
		oauthConnections: oauthResult.meta?.changes ?? 0,
	}
}
