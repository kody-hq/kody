import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadPackageWebhooksData,
	packageWebhookItemId,
	type WebhooksUser,
} from '#app/package-webhooks-data.ts'
import { isMcpCallerError, McpCallerError } from '#mcp/caller-error.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { operationResult } from '../operation-result.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	isWebhookUrlMinted,
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
	rotateWebhookUrlForUser,
	setWebhookEnabledForUser,
} from '#worker/webhooks/service.ts'
import {
	type PackageWebhookRevealedUrl,
	type PackageWebhooksActionPayload,
} from '#universal/loader-data.ts'

const webhookActionIntents = [
	'mint',
	'rotate',
	'reveal',
	'enable',
	'disable',
] as const

type WebhookActionIntent = (typeof webhookActionIntents)[number]

type AuthenticatedUser = WebhooksUser &
	Pick<
		NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>,
		'email' | 'request'
	>

async function authorizePackageWebhooks(
	request: Request,
	params: { username: string; kodyId: string },
	env: Env,
) {
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return { status: 401 as const, error: 'Unauthorized.' }
	}
	if (normalizeUsername(params.username) !== normalizeUsername(user.username)) {
		return { status: 404 as const, error: 'Package not found.' }
	}
	const savedPackage = await resolveSavedPackage({
		db: env.APP_DB,
		userId: ownerIdFromCaller({
			request: user.request,
			user: user.mcpUser,
		}),
		packageIdOrKodyId: params.kodyId.trim(),
	})
	if (!savedPackage) {
		return { status: 404 as const, error: 'Package not found.' }
	}
	return { status: 200 as const, user, packageKodyId: savedPackage.kodyId }
}

export async function readPackageWebhooksData(
	request: Request,
	params: { username: string; kodyId: string },
	env: Env,
) {
	const access = await authorizePackageWebhooks(request, params, env)
	if (access.status !== 200) return access
	return {
		status: 200 as const,
		data: await loadPackageWebhooksData({
			env,
			requestUrl: request.url,
			user: access.user,
			kodyId: access.packageKodyId,
		}),
	}
}

type PackageWebhookInput = {
	request: Request
	params: { username: string; kodyId: string }
	env: Env
	webhookName: string
	endpointId?: string | null
	createInstance?: boolean
	instanceLabel?: string | null
}
export function mintPackageWebhook(input: PackageWebhookInput) {
	return changePackageWebhook(input, 'mint', async (target) => {
		if (!input.createInstance && (await isWebhookUrlMinted(target)))
			throw new McpCallerError(
				'This webhook already has a URL. Rotate it to issue a new one, or mint another URL with a label.',
			)
		const minted = await mintWebhookUrlForUser({
			...target,
			createInstance: input.createInstance === true,
			instanceLabel: input.instanceLabel?.trim() || null,
		})
		return {
			revealed: await revealForUi({ ...target, endpointId: minted.endpointId }),
			approvalUrl: minted.approvalUrl,
		}
	})
}
export function rotatePackageWebhook(input: PackageWebhookInput) {
	return changePackageWebhook(input, 'rotate', async (target) => {
		const { approvalUrl, endpointId } = await rotateWebhookUrlForUser(target)
		return {
			revealed: await revealForUi({ ...target, endpointId }),
			approvalUrl,
		}
	})
}
export function revealPackageWebhook(input: PackageWebhookInput) {
	return changePackageWebhook(input, 'reveal', async (target) => ({
		revealed: await revealForUi(target),
		approvalUrl: null,
	}))
}
export function enablePackageWebhook(input: PackageWebhookInput) {
	return changePackageWebhook(input, 'enable', async (target) => {
		await setWebhookEnabledForUser({ ...target, enabled: true })
		return { revealed: null, approvalUrl: null }
	})
}
export function disablePackageWebhook(input: PackageWebhookInput) {
	return changePackageWebhook(input, 'disable', async (target) => {
		await setWebhookEnabledForUser({ ...target, enabled: false })
		return { revealed: null, approvalUrl: null }
	})
}
function webhookTarget(
	env: Env,
	request: Request,
	user: AuthenticatedUser,
	packageKodyId: string,
	webhookName: string,
) {
	return {
		env,
		request: user.request,
		userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
		email: user.email,
		username: user.username,
		kodyId: packageKodyId,
		packageKodyId,
		webhookName,
		requestUrl: request.url,
		endpointId: null as string | null,
	}
}
async function changePackageWebhook(
	input: PackageWebhookInput,
	intent: WebhookActionIntent,
	apply: (target: ReturnType<typeof webhookTarget>) => Promise<{
		revealed: PackageWebhookRevealedUrl | null
		approvalUrl: string | null
	}>,
) {
	const { request, params, env } = input
	const access = await authorizePackageWebhooks(request, params, env)
	if (access.status !== 200)
		return operationResult({ ok: false, error: access.error }, access.status)
	const { user, packageKodyId } = access

	const webhookName = input.webhookName.trim()
	if (!webhookName) {
		return operationResult(
			{ ok: false, error: 'webhookName is required.' },
			400,
		)
	}

	const audit = (result: 'success' | 'failure', reason?: string) => {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: auditActionFor(intent),
			result,
			email: user.email,
			ip: getRequestIp(request) ?? undefined,
			path: new URL(request.url).pathname,
			reason: [
				`package=${packageKodyId}`,
				`webhook=${webhookName}`,
				...(input.endpointId ? [`endpoint=${input.endpointId}`] : []),
				...(input.createInstance ? ['createInstance'] : []),
				...(reason ? [reason] : []),
			].join(' '),
		})
	}

	try {
		const { revealed, approvalUrl } = await apply({
			...webhookTarget(env, request, user, packageKodyId, webhookName),
			endpointId: input.endpointId?.trim() || null,
		})
		audit('success')
		const payload: PackageWebhooksActionPayload = {
			ok: true,
			...(revealed ? { revealed } : {}),
			...(approvalUrl ? { approvalUrl } : {}),
		}
		return operationResult(payload)
	} catch (error) {
		const detail =
			error instanceof Error ? error.message : failureMessageFor(intent)
		audit('failure', detail)
		// Caller mistakes (undeclared webhook, not minted, legacy secret)
		// carry safe messages. Anything else is an infrastructure failure
		// whose text must not reach the browser.
		if (isMcpCallerError(error)) {
			return operationResult({ ok: false, error: detail }, 400)
		}
		console.error('package webhooks action failed', {
			intent,
			packageKodyId,
			webhookName,
			error,
		})
		return operationResult({ ok: false, error: failureMessageFor(intent) }, 500)
	}
}

async function revealForUi(input: {
	env: Env
	userId: OwnerId
	email: string
	username: string
	packageKodyId: string
	webhookName: string
	requestUrl: string
	endpointId?: string | null
}): Promise<PackageWebhookRevealedUrl> {
	const revealed = await revealWebhookUrlForWebsite({
		env: input.env,
		userId: input.userId,
		email: input.email,
		username: input.username,
		requestUrl: input.requestUrl,
		target: {
			kodyId: input.packageKodyId,
			webhookName: input.webhookName,
			endpointId: input.endpointId,
		},
	})
	return {
		id: packageWebhookItemId({
			packageKodyId: input.packageKodyId,
			name: input.webhookName,
			endpointId: revealed.endpointId,
		}),
		handle: revealed.handle,
		url: revealed.url,
	}
}

function auditActionFor(intent: WebhookActionIntent) {
	switch (intent) {
		case 'mint':
			return 'webhook_url_mint'
		case 'rotate':
			return 'webhook_url_rotate'
		case 'reveal':
			return 'webhook_url_reveal'
		case 'enable':
			return 'webhook_enable'
		case 'disable':
			return 'webhook_disable'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}

function failureMessageFor(intent: WebhookActionIntent) {
	switch (intent) {
		case 'mint':
			return 'Unable to mint the webhook URL.'
		case 'rotate':
			return 'Unable to rotate the webhook URL.'
		case 'reveal':
			return 'Unable to reveal the webhook URL.'
		case 'enable':
			return 'Unable to enable the webhook.'
		case 'disable':
			return 'Unable to disable the webhook.'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}
