import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type ConnectWebhookApplyLoaderData } from '#universal/loader-data.ts'
import {
	approveWebhookApplyDestination,
	loadWebhookApplyDestinationApprovalView,
	rejectWebhookApplyDestination,
} from '#worker/webhooks/apply-destination-approval.ts'
import { parseWebhookUrlHandle } from '#worker/webhooks/handle.ts'

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

	const view = await loadWebhookApplyDestinationApprovalView({
		db: input.env.APP_DB,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		handle,
		fingerprint,
	})
	if (!view) {
		return {
			ok: false,
			error:
				'No pending or approved webhook apply destination matches this link.',
			handle,
			fingerprint,
		}
	}

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
	await approveWebhookApplyDestination({
		db: input.env.APP_DB,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
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
	await rejectWebhookApplyDestination({
		db: input.env.APP_DB,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
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
