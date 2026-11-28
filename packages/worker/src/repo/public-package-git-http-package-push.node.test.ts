import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { http, HttpResponse } from 'msw'
import { expect, test, vi } from 'vitest'
import {
	encodeGitFlushPkt,
	encodeGitPktLine,
} from '#worker/repo/git-pkt-line.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

const noted = vi.hoisted(() => [] as Array<unknown>)

vi.mock('#worker/package-runtime/package-app-authority.ts', () => ({
	notePackageAppPublishRequester: async (input: {
		scope: unknown
		personId: string
		commit: string
	}) => {
		noted.push({
			scope: input.scope,
			personId: input.personId,
			commit: input.commit,
		})
	},
}))

vi.mock('#worker/api-tokens/service.ts', () => ({
	authenticateApiToken: async () => ({
		ok: true,
		record: { user_id: 'user-pusher', scopes: null },
	}),
	getApiTokenIssuedAtMs: () => 0,
	slideApiTokenExpiry: () => null,
	touchApiToken: async () => false,
}))

vi.mock('#worker/mcp-auth-user-context.ts', () => ({
	buildMcpUserContextFromGrantProps: async () => ({
		user: { userId: 'user-pusher', username: 'pusher' },
		emailVerified: true,
		suspended: false,
		passwordChangedAt: null,
	}),
}))

vi.mock('#worker/password-change-lockout.ts', () => ({
	isCredentialInvalidatedByStoredPasswordChange: () => false,
}))

vi.mock('#worker/repo/git-http-target.ts', () => ({
	resolveGitHttpTargetAccess: async () => ({
		ownerHandle: 'acme',
		repoName: 'app',
		resourceKind: 'package',
		resourceId: 'pkg-app',
		resourceOrgId: ownerIdFromStored('org-acme'),
		sourceId: 'source-app',
		repoId: 'app',
		canRead: true,
		canWrite: true,
	}),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) => remote,
	parseArtifactTokenSecret: (token: string) => token,
	resolveExistingArtifactSourceRepo: async () => ({
		info: async () => ({ remote: artifactsRemote, defaultBranch: 'main' }),
		createToken: async () => ({ plaintext: 'art_token' }),
	}),
}))

vi.mock('#app/rate-limit.ts', () => ({
	checkRateLimit: async () => ({ allowed: true }),
}))

vi.mock('#worker/audit-log.ts', () => ({
	getRequestIp: () => '203.0.113.10',
}))

const { handlePublicPackageGitHttpRequest } =
	await import('./public-package-git-http.ts')

const artifactsRemote =
	'https://acct.artifacts.cloudflare.net/git/default/app.git'
const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
const packResult = '000eunpack ok\n0000'

test('a package push notes the authenticated pusher for each pushed commit', async () => {
	noted.length = 0
	const newOid = '2'.repeat(40)
	const body =
		encodeGitPktLine(
			`${'1'.repeat(40)} ${newOid} refs/heads/main\0 report-status\n`,
		) +
		encodeGitFlushPkt() +
		'PACK-bytes'
	const forwarded: Array<string> = []
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async ({ request }) => {
			forwarded.push(await request.text())
			return HttpResponse.text(packResult, { status: 200 })
		}),
	])
	const pending: Array<Promise<unknown>> = []
	const response = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@acme/app.git/git-receive-pack', {
			method: 'POST',
			headers: {
				Authorization: `Basic ${btoa(`pusher:${apiToken}`)}`,
				'Content-Type': 'application/x-git-receive-pack-request',
			},
			body,
		}),
		{ APP_DB: {} } as unknown as Env,
		(promise) => pending.push(promise),
	)
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
	await Promise.all(pending)
	expect(forwarded).toEqual([body])
	expect(noted).toEqual([
		{
			scope: { orgId: 'org-acme', packageId: 'pkg-app' },
			personId: 'user-pusher',
			commit: newOid,
		},
	])
})
