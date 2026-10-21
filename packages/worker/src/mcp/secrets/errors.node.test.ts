import { expect, test } from 'vitest'
import {
	createSecretScopeUnavailableMessage,
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
	parseSecretScopeUnavailableMessage,
} from './errors.ts'

test('secret error message helpers parse auth, missing-secret, and approval payloads', () => {
	expect(
		parseMissingSecretMessage('Secret "lutronPassword" was not found.'),
	).toEqual({
		secretName: 'lutronPassword',
	})

	expect(
		parseHostApprovalRequiredMessage(
			'Secret "cloudflareToken" is not allowed for host "api.cloudflare.com". Retry after approval.',
		),
	).toEqual({
		secretName: 'cloudflareToken',
		host: 'api.cloudflare.com',
	})

	const hostEntries = [
		{
			secretName: 'cloudflareToken',
			host: 'api.cloudflare.com',
			approvalUrl:
				'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com',
		},
		{
			secretName: 'githubToken',
			host: 'api.github.com',
			approvalUrl:
				'https://example.com/account/secrets/user/githubToken?allowed-host=api.github.com',
		},
	]
	expect(
		parseHostApprovalRequiredBatchMessage(
			`Secrets require host approval: ${JSON.stringify({ entries: hostEntries })}`,
		),
	).toEqual({
		entries: hostEntries,
		bulkApprovalUrl: null,
	})
	expect(
		parseHostApprovalRequiredBatchMessage(
			`Secrets require host approval: ${JSON.stringify({
				entries: hostEntries,
				bulkApprovalUrl:
					'https://example.com/connect/secrets?names=cloudflareToken,githubToken&hosts=api.cloudflare.com,api.github.com',
			})}`,
		),
	).toEqual({
		entries: hostEntries,
		bulkApprovalUrl:
			'https://example.com/connect/secrets?names=cloudflareToken,githubToken&hosts=api.cloudflare.com,api.github.com',
	})

	const scopeUnavailableMessage =
		'Secret "discordBotToken" exists in package scope for package "discord-gateway" and is not visible from this runtime.'
	expect(parseSecretScopeUnavailableMessage(scopeUnavailableMessage)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: false,
	})
	expect(
		parseSecretScopeUnavailableMessage(
			'Secret "discordBotToken" exists in package scope for package id "pkg-1" and is not visible from this runtime.',
		),
	).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: null,
		packageId: 'pkg-1',
		missingPackageContext: false,
	})
	expect(parseMissingSecretMessage(scopeUnavailableMessage)).toBeNull()
	expect(
		parseSecretScopeUnavailableMessage(
			'Secret "discordBotToken" was not found.',
		),
	).toBeNull()
})

test('package secret scope errors distinguish missing package context from a different package runtime', () => {
	const differentPackageRuntime = createSecretScopeUnavailableMessage([
		{
			secretName: 'discordBotToken',
			scope: 'package',
			packageId: 'pkg-1',
			packageName: 'discord-gateway',
			sessionId: null,
			editorUrl:
				'https://example.com/@acme/-/secrets/package/pkg-1/discordBotToken',
		},
	])
	expect(differentPackageRuntime).toContain(
		'Prefer calling through an export of the owning package',
	)
	expect(differentPackageRuntime).toContain(
		"Changing the secret's scope is an explicit, owner-reviewed choice only",
	)
	expect(differentPackageRuntime).toContain(
		'https://example.com/@acme/-/secrets/package/pkg-1/discordBotToken',
	)
	expect(differentPackageRuntime).not.toContain('Do not widen the secret')
	expect(parseSecretScopeUnavailableMessage(differentPackageRuntime)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: false,
	})

	const missingPackageContext = createSecretScopeUnavailableMessage([
		{
			secretName: 'discordBotToken',
			scope: 'package',
			packageId: 'pkg-1',
			packageName: 'discord-gateway',
			sessionId: null,
			editorUrl:
				'https://example.com/@acme/-/secrets/package/pkg-1/discordBotToken',
			missingPackageContext: {
				kind: 'missing_package_context',
				runtimeLabel: 'job "nightly"',
				contextSavedAt: '2026-04-20T00:00:00.000Z',
			},
		},
	])
	expect(missingPackageContext).toContain('job "nightly"')
	expect(missingPackageContext).toContain('but its package context is missing')
	expect(missingPackageContext).toContain(
		'Republish the package so this runtime gets a fresh package context (package context last saved 2026-04-20T00:00:00.000Z)',
	)
	expect(missingPackageContext).toContain(
		"Do not widen the secret's scope to work around a missing package context",
	)
	expect(missingPackageContext).not.toContain('Editor link:')
	expect(missingPackageContext).not.toContain(
		'Prefer calling through an export of the owning package',
	)
	expect(parseSecretScopeUnavailableMessage(missingPackageContext)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: true,
	})
})

test('missing-context guidance leads with the package that owns this runtime', () => {
	const message = createSecretScopeUnavailableMessage([
		{
			secretName: 'discordBotToken',
			scope: 'package',
			packageId: 'pkg-aaa',
			packageName: 'other-gateway',
			sessionId: null,
			editorUrl:
				'https://example.com/@acme/-/secrets/package/pkg-aaa/discordBotToken',
		},
		{
			secretName: 'discordBotToken',
			scope: 'package',
			packageId: 'pkg-zzz',
			packageName: 'discord-gateway',
			sessionId: null,
			editorUrl: null,
			missingPackageContext: {
				kind: 'missing_package_context',
				runtimeLabel: 'job "nightly"',
				contextSavedAt: null,
			},
		},
	])
	expect(message).toContain(
		'exists in package scope for package "discord-gateway"',
	)
	expect(message).toContain('job "nightly"')
	expect(message).toContain('but its package context is missing')
	expect(message).toContain(
		'It also exists in package scope for package "other-gateway"',
	)
	expect(parseSecretScopeUnavailableMessage(message)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: true,
	})
})
