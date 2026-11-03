import type { StorageContext } from '#mcp/storage.ts'
import {
	classifyApprovalHosts,
	type ClassifiedApprovalHosts,
} from './approval-host-shape.ts'
import { normalizeBulkPackageSecretApprovalNames } from './package-approval-url.ts'
import type { SecretScope } from './types.ts'

const connectSecretsPath = '/connect/secrets'
const maxBulkHostApprovalHosts = 20

export function classifyBulkApprovalHosts(
	hosts: Array<string>,
): ClassifiedApprovalHosts {
	return classifyApprovalHosts(hosts, { limit: maxBulkHostApprovalHosts })
}

export function normalizeBulkHostApprovalHosts(hosts: Array<string>) {
	return classifyBulkApprovalHosts(hosts).valid
}

export function buildSecretHostApprovalUrl(input: {
	baseUrl: string
	name: string
	scope: SecretScope
	requestedHost: string
	storageContext: StorageContext | null
}) {
	return buildSecretHostBulkApprovalUrl({
		baseUrl: input.baseUrl,
		names: [input.name],
		hosts: [input.requestedHost],
		scope: input.scope,
		storageContext: input.storageContext,
	})
}

export function buildSecretHostBulkApprovalUrl(input: {
	baseUrl: string
	names: Array<string>
	hosts: Array<string>
	scope?: SecretScope
	storageContext?: StorageContext | null
}) {
	const names = normalizeBulkPackageSecretApprovalNames(input.names)
	const hosts = normalizeBulkHostApprovalHosts(input.hosts)
	if (names.length === 0) {
		throw new Error('At least one secret name is required for host approval.')
	}
	if (hosts.length === 0) {
		throw new Error('At least one host is required for host approval.')
	}
	const url = new URL(connectSecretsPath, input.baseUrl)
	if (names.length === 1) {
		url.searchParams.set('name', names[0] ?? '')
	} else {
		url.searchParams.set('names', names.join(','))
	}
	url.searchParams.set('hosts', hosts.join(','))
	applyHostApprovalScopeParams(url, input.scope ?? 'user', input.storageContext)
	return url.toString()
}

export function buildSecretHostBulkApprovalUrlIfNeeded(input: {
	baseUrl: string
	names: Array<string>
	hosts: Array<string>
	scope?: SecretScope
	storageContext?: StorageContext | null
}) {
	const names = normalizeBulkPackageSecretApprovalNames(input.names)
	const hosts = normalizeBulkHostApprovalHosts(input.hosts)
	if (names.length < 2 && hosts.length < 2) return null
	return buildSecretHostBulkApprovalUrl({
		baseUrl: input.baseUrl,
		names,
		hosts,
		scope: input.scope,
		storageContext: input.storageContext,
	})
}

function applyHostApprovalScopeParams(
	url: URL,
	scope: SecretScope,
	storageContext: StorageContext | null | undefined,
) {
	switch (scope) {
		case 'user':
			return
		case 'package': {
			const packageId = storageContext?.packageId
			if (!packageId) {
				throw new Error(
					'storageContext.packageId is required for package-scope host approvals.',
				)
			}
			url.searchParams.set('scope', 'package')
			url.searchParams.set('packageId', packageId)
			return
		}
		case 'session': {
			const sessionId = storageContext?.sessionId
			if (!sessionId) {
				throw new Error(
					'storageContext.sessionId is required for session-scope host approvals.',
				)
			}
			url.searchParams.set('scope', 'session')
			url.searchParams.set('sessionId', sessionId)
			return
		}
		default: {
			const _exhaustive: never = scope
			throw new Error(`Unsupported host approval scope: ${String(_exhaustive)}`)
		}
	}
}
