import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import type { UserMeterRpc } from './user-meter-do.ts'

export type UserMeterEnv = {
	USER_METER?: DurableObjectNamespace
}

export function userMeterNamespace(
	env: UserMeterEnv,
): DurableObjectNamespace | null {
	return env.USER_METER ?? null
}

/**
 * Typed UserMeter RPC stub; throws when `USER_METER` is missing.
 * `userId` is the durable object name key (org id for team billing; for
 * personal orgs the org id equals the owner user id).
 */
export function userMeterRpc(input: {
	env: UserMeterEnv
	userId: OwnerId
}): UserMeterRpc {
	const namespace = userMeterNamespace(input.env)
	if (!namespace) {
		throw new Error('USER_METER Durable Object binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(userMeterDurableObjectName(input.userId)),
	) as unknown as UserMeterRpc
}

export type { UserMeterRpc }
