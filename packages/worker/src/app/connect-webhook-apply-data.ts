import {
	AuthorizationError,
	authorizePackageWrite,
} from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import type { ConnectWebhookApplyLoaderData } from '#universal/loader-data.ts'
import {
	approveWebhookApplyDestination,
	loadWebhookApplyDestinationApprovalView,
	rejectWebhookApplyDestination,
} from '#worker/webhooks/apply-destination-approval.ts'
import { parseWebhookUrlHandle } from '#worker/webhooks/handle.ts'

function callerOwnerId(user: AuthenticatedAppUser) {
	return ownerIdFromCaller({ request: user.request, user: user.mcpUser })
}

/**
 * Loads the destination behind an approval link and checks the caller may
 * decide it: approving lets `webhookUrlApply` send the webhook URL there, so
 * it needs Write on the webhook's package, like `webhookUrlApply` itself.
 */
async function loadAuthorizedApprovalView(input: {
	env: Env
	user: AuthenticatedAppUser
	handle: string
	fingerprint: string
}): Promise<
	| {
			ok: true
			view: NonNullable<
				Awaited<ReturnType<typeof loadWebhookApplyDestinationApprovalView>>
			>
	  }
	| { ok: false; error: string }
> {
	const ownerId = callerOwnerId(input.user)
	const view = await loadWebhookApplyDestinationApprovalView({
		db: input.env.APP_DB,
		userId: ownerId,
		handle: input.handle,
		fingerprint: input.fingerprint,
	})
	if (!view) {
		return {
			ok: false,
			error:
				'No pending or approved webhook apply destination matches this link.',
		}
	}
	try {
		await authorizePackageWrite(
			{ env: input.env, request: input.user.request },
			{ id: view.packageId, userId: ownerId, label: view.packageName },
		)
	} catch (error) {
		if (
			error instanceof AuthorizationError &&
			error.code === 'missing_permission' &&
			error.permission === 'package:write'
		) {
			return { ok: false, error: error.message }
		}
		throw error
	}
	return { ok: true, view }
}

export async function loadConnectWebhookApplyData(input: {
	env: Env
	user: AuthenticatedAppUser
	handle: string | null
	fingerprint: string | null
}): Promise<ConnectWebhookApplyLoaderData> {
	const { handle, fingerprint } = input
	if (!handle || !fingerprint) {
		return {
			ok: false,
			error: 'This approval link is missing handle or fingerprint.',
			handle,
			fingerprint,
		}
	}

	const authorized = await loadAuthorizedApprovalView({
		env: input.env,
		user: input.user,
		handle,
		fingerprint,
	})
	if (!authorized.ok) {
		return { ok: false, error: authorized.error, handle, fingerprint }
	}
	const { view } = authorized

	return {
		ok: true,
		handle: view.handle,
		fingerprint: view.fingerprint,
		packageId: view.packageId,
		packageKodyId: view.packageKodyId,
		packageName: view.packageName,
		webhookName: view.webhookName,
		destination: view.destination,
		alreadyGranted: view.alreadyGranted,
	}
}

export async function approveConnectWebhookApply(input: {
	env: Env
	user: AuthenticatedAppUser
	handle: string
	fingerprint: string
}): Promise<ConnectWebhookApplyLoaderData> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		return {
			ok: false,
			error: 'Invalid webhook handle.',
			handle: input.handle,
			fingerprint: input.fingerprint,
		}
	}
	const authorized = await loadAuthorizedApprovalView(input)
	if (!authorized.ok) {
		return {
			ok: false,
			error: authorized.error,
			handle: input.handle,
			fingerprint: input.fingerprint,
		}
	}
	await approveWebhookApplyDestination({
		db: input.env.APP_DB,
		userId: callerOwnerId(input.user),
		endpointId,
		fingerprint: input.fingerprint,
	})
	return loadConnectWebhookApplyData({
		env: input.env,
		user: input.user,
		handle: input.handle,
		fingerprint: input.fingerprint,
	})
}

export async function rejectConnectWebhookApply(input: {
	env: Env
	user: AuthenticatedAppUser
	handle: string
	fingerprint: string
}): Promise<ConnectWebhookApplyLoaderData> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		return {
			ok: false,
			error: 'Invalid webhook handle.',
			handle: input.handle,
			fingerprint: input.fingerprint,
		}
	}
	const authorized = await loadAuthorizedApprovalView(input)
	if (!authorized.ok) {
		return {
			ok: false,
			error: authorized.error,
			handle: input.handle,
			fingerprint: input.fingerprint,
		}
	}
	await rejectWebhookApplyDestination({
		db: input.env.APP_DB,
		userId: callerOwnerId(input.user),
		endpointId,
		fingerprint: input.fingerprint,
	})
	return {
		ok: false,
		error: 'Approval rejected. The agent must request a new approval link.',
		handle: input.handle,
		fingerprint: input.fingerprint,
	}
}
