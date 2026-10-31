import { expect, test } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	enhanceGitRemoteReadDenial,
	enhanceGitRemoteWriteDenial,
	isGitReceivePackUrl,
	mapGitRemotePushAuthFailure,
	pickGitRemoteAccessScope,
} from './git-remote-scope.ts'

test('receive-pack URL detection covers info/refs and path forms', () => {
	expect(
		isGitReceivePackUrl(
			'https://example.test/repo.git/info/refs?service=git-receive-pack',
		),
	).toBe(true)
	expect(
		isGitReceivePackUrl('https://example.test/repo.git/git-receive-pack'),
	).toBe(true)
	expect(
		isGitReceivePackUrl(
			'https://example.test/repo.git/info/refs?service=git-upload-pack',
		),
	).toBe(false)
})

test('mapGitRemotePushAuthFailure rewrites receive-pack 401/403', () => {
	expect(
		mapGitRemotePushAuthFailure({
			url: 'https://example.test/repo.git/git-receive-pack',
			statusCode: 403,
		})?.message,
	).toBe("this remote is read-only; request scope: 'write'")
	expect(
		mapGitRemotePushAuthFailure({
			url: 'https://example.test/repo.git/git-upload-pack',
			statusCode: 403,
		}),
	).toBeNull()
})

test('pickGitRemoteAccessScope defaults from write access and honors explicit scope', () => {
	expect(
		pickGitRemoteAccessScope({ requested: undefined, canWrite: true }),
	).toBe('write')
	expect(
		pickGitRemoteAccessScope({ requested: undefined, canWrite: false }),
	).toBe('read')
	expect(pickGitRemoteAccessScope({ requested: 'read', canWrite: true })).toBe(
		'read',
	)
	expect(
		pickGitRemoteAccessScope({ requested: 'write', canWrite: false }),
	).toBe('write')
})

test('enhanceGitRemoteWriteDenial keeps AuthorizationError and adds next steps', () => {
	const base = new AuthorizationError({
		code: 'profile_grant',
		permission: 'package:write',
		orgId: ownerIdFromStored('user-1'),
		resource: null,
		message: 'This profile cannot write.',
	})
	const enhanced = enhanceGitRemoteWriteDenial({
		error: base,
		resourceLabel: 'package @you/demo',
		operation: 'packageGetGitRemote',
		canRead: true,
	})
	expect(enhanced).toBeInstanceOf(AuthorizationError)
	expect(enhanced.code).toBe('profile_grant')
	expect(enhanced.message).toMatch(
		/You have read access to package @you\/demo, not write[\s\S]*scope: 'read'[\s\S]*communityFork/,
	)
})

test('enhanceGitRemoteReadDenial keeps AuthorizationError and names actionable next steps', () => {
	const base = new AuthorizationError({
		code: 'missing_permission',
		permission: 'package:read',
		orgId: ownerIdFromStored('user-1'),
		resource: null,
		message: 'Missing package:read.',
	})
	const packageDenial = enhanceGitRemoteReadDenial({
		error: base,
		resourceLabel: 'package @you/demo',
		operation: 'packageGetGitRemote',
	})
	expect(packageDenial.code).toBe('missing_permission')
	expect(packageDenial.message).toMatch(
		/Missing package:read on package @you\/demo[\s\S]*communityFork/,
	)
	const repoDenial = enhanceGitRemoteReadDenial({
		error: base,
		resourceLabel: 'repo notes',
		operation: 'repoGetGitRemote',
	})
	expect(repoDenial.message).toMatch(
		/Missing package:read on repo notes[\s\S]*across this org[\s\S]*single-package grant/,
	)
	expect(repoDenial.message).not.toMatch(/communityFork/)
})
