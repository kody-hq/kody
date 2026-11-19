import { expect, test, vi } from 'vitest'
import * as authenticatedUser from '#app/authenticated-user.ts'
import * as runConsent from '#app/package-app-run-consent.ts'
import * as accountWrites from '#worker/account/deletion-state.ts'
import * as deviceVerification from '#worker/oauth-device/verification.ts'
import {
	loadPackageAppRunConsentView,
	postPackageAppRunConsent,
} from './package-app-run-consent-protocol.ts'

vi.mock('./request-env.ts', () => ({ getStartRequestEnv: () => env }))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: async () => ({
		email: 'visitor@example.com',
		username: 'visitor',
		displayName: 'Visitor',
		mcpUser: { userId: personId, username: 'visitor' },
	}),
}))
vi.mock('#app/package-app-owner.ts', () => ({
	resolvePackageAppOrgOwnerByHandle: async ({ handle }: { handle: string }) =>
		handle === 'publisher'
			? { userId: publisherId, username: 'publisher', displayName: 'Publisher' }
			: null,
}))
vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackageForPackageAppSlug: async ({ slug }: { slug: string }) =>
		slug === 'lantern'
			? {
					savedPackage: {
						id: packageId,
						name: '@publisher/lantern',
						hasApp: true,
					},
					retired: false,
				}
			: null,
}))
vi.mock('#app/package-viewer-access.ts', () => ({
	viewerCanExecutePackageApp: async () => true,
}))
vi.mock('#app/package-app-run-consent.ts', () => ({
	approvePackageAppRun: async () => ({}),
	needsPackageAppRunConsentForPerson: async () => true,
}))
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: async ({ write }: { write: () => Promise<unknown> }) =>
		write(),
}))
vi.mock('#worker/oauth-device/verification.ts', () => ({
	findPendingPackageAppDeviceAuthorization: async () => ({
		kind: 'found',
		row: { client_id: 'publisher/lantern' },
	}),
}))

const env = { APP_DB: {} } as Env
const origin = 'https://kody.test'
const personId = 'visitor-person'
const publisherId = 'publisher-org'
const packageId = 'package-id'
const returnTo = '/@publisher/packages/lantern/open/inbox?tab=new'
const oauthResume =
	'/oauth/package-app/authorize?client_id=publisher%2Flantern&state=literal%2Bstate'
const deviceResume = '/oauth/package-app/authorize?device_user_code=ABCD-EFGH'
const identity = { personId, publisherId, packageId }

function confirmationUrl(resume?: string) {
	const url = new URL('/oauth/package-app/run-as-me', origin)
	url.searchParams.set('returnTo', returnTo)
	if (resume) url.searchParams.set('resume', resume)
	return url
}

function submit(
	decision: 'approve' | 'decline',
	options: {
		resume?: string
		formIdentity?: Partial<typeof identity>
		origin?: string
	} = {},
) {
	return postPackageAppRunConsent({
		request: new Request(confirmationUrl(options.resume), {
			method: 'POST',
			headers: { Origin: options.origin ?? origin },
			body: new URLSearchParams({
				...identity,
				...options.formIdentity,
				decision,
			}),
		}),
	})
}

test('approval records the current visitor and app under a write lease before resuming', async () => {
	using writeLease = vi.spyOn(accountWrites, 'withAccountWriteLease')
	using approve = vi.spyOn(runConsent, 'approvePackageAppRun')

	const response = await submit('approve')

	expect(writeLease).toHaveBeenCalledOnce()
	expect(approve).toHaveBeenCalledExactlyOnceWith(
		env.APP_DB,
		personId,
		packageId,
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Refresh')).toBe(`0; url=${returnTo}`)
	expect(response.headers.has('Set-Cookie')).toBe(false)
})

test('decline reloads the confirmation with no approval, navigation to the app, or session cookie', async () => {
	using writeLease = vi.spyOn(accountWrites, 'withAccountWriteLease')
	using approve = vi.spyOn(runConsent, 'approvePackageAppRun')

	const response = await submit('decline', { resume: oauthResume })
	const location = confirmationUrl(oauthResume)
	location.searchParams.set('declined', '1')

	expect(response.status).toBe(303)
	expect(response.headers.get('Location')).toBe(
		`${location.pathname}${location.search}`,
	)
	expect(response.headers.has('Refresh')).toBe(false)
	expect(response.headers.has('Set-Cookie')).toBe(false)
	expect(writeLease).not.toHaveBeenCalled()
	expect(approve).not.toHaveBeenCalled()
	expect(
		await loadPackageAppRunConsentView(new Request(location), env),
	).toMatchObject({ declined: true, destination: oauthResume })
})

test.each(Object.keys(identity) as Array<keyof typeof identity>)(
	'rejects a stale form when its %s no longer matches',
	async (field) => {
		using approve = vi.spyOn(runConsent, 'approvePackageAppRun')

		const response = await submit('approve', {
			formIdentity: { [field]: 'stale' },
		})

		expect(response.status).toBe(409)
		expect(approve).not.toHaveBeenCalled()
	},
)

test('rejects a cross-origin approval before reading the visitor', async () => {
	using readUser = vi.spyOn(authenticatedUser, 'readAuthenticatedAppUser')
	using approve = vi.spyOn(runConsent, 'approvePackageAppRun')

	const response = await submit('approve', { origin: 'https://app.test' })

	expect(response.status).toBe(403)
	expect(readUser).not.toHaveBeenCalled()
	expect(approve).not.toHaveBeenCalled()
})

test.each([
	['browser OAuth', oauthResume],
	['device OAuth', deviceResume],
])('approval resumes matching %s authorization', async (_, resume) => {
	using approve = vi.spyOn(runConsent, 'approvePackageAppRun')

	const response = await submit('approve', { resume })

	expect(response.status).toBe(200)
	expect(response.headers.get('Refresh')).toBe(`0; url=${resume}`)
	expect(approve).toHaveBeenCalledOnce()
})

test.each([
	'https://app.test/oauth/package-app/authorize?client_id=publisher/lantern',
	'/oauth/package-app/authorize?client_id=publisher/sibling',
	'/account',
])('rejects an unrelated authorization resume %s', async (resume) => {
	using approve = vi.spyOn(runConsent, 'approvePackageAppRun')

	const response = await submit('approve', { resume })

	expect(response.status).toBe(404)
	expect(approve).not.toHaveBeenCalled()
})

test('rejects a device resume unavailable to the current visitor', async () => {
	using approve = vi.spyOn(runConsent, 'approvePackageAppRun')
	using findDevice = vi
		.spyOn(deviceVerification, 'findPendingPackageAppDeviceAuthorization')
		.mockResolvedValue({ kind: 'not_found' })

	const response = await submit('approve', { resume: deviceResume })

	expect(response.status).toBe(404)
	expect(findDevice).toHaveBeenCalledWith({
		request: expect.any(Request),
		env,
		user: { personId, email: 'visitor@example.com' },
		userCode: 'ABCD-EFGH',
	})
	expect(approve).not.toHaveBeenCalled()
})
