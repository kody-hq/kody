import { secretsInput } from './secrets-input.ts'
import {
	normalizePlacementApprovalParts,
	placementApprovalCredentialParam,
	placementApprovalParam,
} from '#universal/credential-placement-approval.ts'

import type {
	ConnectSecretsInput,
	ConnectOauthInput,
	ConnectWebhookInput,
} from './connect-input-types.ts'

function connectionLocation(search: string) {
	const params = new URLSearchParams(search)
	return {
		params,
		// Present-but-empty scope must fail validation, never select personal scope.
		orgSlug: params.has('org') ? params.get('org')!.trim() : undefined,
		search: Array.from(params.entries()),
	}
}
export function connectSecretsInput(search: string): ConnectSecretsInput {
	const { params, ...location } = connectionLocation(search)
	const { selectedSecretId, approval } = secretsInput(
		location.orgSlug ?? '',
		search,
	)
	const placement = normalizePlacementApprovalParts(
		params.getAll(placementApprovalParam),
	)
	const placementCredentialId =
		params.get(placementApprovalCredentialParam)?.trim() || undefined
	return {
		...location,
		selectedSecretId,
		approval,
		placement,
		placementCredentialId,
	}
}
export function connectOauthInput(search: string): ConnectOauthInput {
	const { params, ...location } = connectionLocation(search)
	return {
		...location,
		provider: params.get('provider') ?? undefined,
		code: params.get('code') ?? undefined,
		error: params.get('error') ?? undefined,
		appSlug: params.get('app') ?? undefined,
		platformSlug: params.get('platform') ?? undefined,
	}
}
export function connectWebhookInput(search: string): ConnectWebhookInput {
	const { params, ...location } = connectionLocation(search)
	return {
		...location,
		handle: params.get('handle')?.trim() || null,
		fingerprint: params.get('fingerprint')?.trim() || null,
	}
}
