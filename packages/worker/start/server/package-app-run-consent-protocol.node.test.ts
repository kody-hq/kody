import { beforeEach, expect, test, vi } from 'vitest'
import {
	loadPackageAppRunConsentView,
	postPackageAppRunConsent,
} from './package-app-run-consent-protocol.ts'

const state = vi.hoisted(() => ({
	env: { APP_DB: {} } as Env,
	authenticated: vi.fn(),
	resolveOwner: vi.fn(),
	resolveApp: vi.fn(),
	canExecute: vi.fn(),
	needsConsent: vi.fn(),
	writeApproval: vi.fn(),
	writeLease: vi.fn(async ({ write }: { write: () => Promise<unknown> }) =>
		write(),
	),
	findDevice: vi.fn(),
}))

vi.mock('./request-env.ts', () => ({ getStartRequestEnv: () => state.env }))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: state.authenticated,
}))
vi.mock('#app/package-app-owner.ts', () => ({
	resolvePackageAppOrgOwnerByHandle: state.resolveOwner,
}))
vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackageForPackageAppSlug: state.resolveApp,
}))
vi.mock('#app/package-viewer-access.ts', () => ({
	viewerCanExecutePackageApp: state.canExecute,
}))
vi.mock('#app/package-app-run-consent.ts', () => ({
	approvePackageAppRun: state.writeApproval,
	needsPackageAppRunConsentForPerson: state.needsConsent,
}))
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: state.writeLease,
}))
vi.mock('#worker/oauth-device/verification.ts', () => ({
	findPendingPackageAppDeviceAuthorization: state.findDevice,
}))

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

beforeEach(() => {
	vi.clearAllMocks()
	state.authenticated.mockResolvedValue({
		email: 'visitor@example.com',
		username: 'visitor',
		displayName: 'Visitor',
		mcpUser: { userId: personId, username: 'visitor' },
	})
	state.resolveOwner.mockResolvedValue({
		userId: publisherId,
		username: 'publisher',
		displayName: 'Publisher',
	})
	state.resolveApp.mockResolvedValue({
		savedPackage: { id: packageId, name: '@publisher/lantern', hasApp: true },
		retired: false,
	})
	state.canExecute.mockResolvedValue(true)
	state.needsConsent.mockResolvedValue(true)
	state.findDevice.mockResolvedValue({
		kind: 'found',
		row: { client_id: 'publisher/lantern' },
	})
})

test('approval records the current visitor and app under a write lease before resuming', async () => {
	const response = await submit('approve')

	expect(state.writeLease).toHaveBeenCalledOnce()
	expect(state.writeApproval).toHaveBeenCalledExactlyOnceWith(
		state.env.APP_DB,
		personId,
		packageId,
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Refresh')).toBe(`0; url=${returnTo}`)
	expect(response.headers.has('Set-Cookie')).toBe(false)
})

test('decline reloads the confirmation with no approval, navigation to the app, or session cookie', async () => {
	const response = await submit('decline', { resume: oauthResume })
	const location = confirmationUrl(oauthResume)
	location.searchParams.set('declined', '1')

	expect(response.status).toBe(303)
	expect(response.headers.get('Location')).toBe(
		`${location.pathname}${location.search}`,
	)
	expect(response.headers.has('Refresh')).toBe(false)
	expect(response.headers.has('Set-Cookie')).toBe(false)
	expect(state.writeLease).not.toHaveBeenCalled()
	expect(state.writeApproval).not.toHaveBeenCalled()
	expect(
		await loadPackageAppRunConsentView(new Request(location), state.env),
	).toMatchObject({ declined: true, destination: oauthResume })
})

test.each(Object.keys(identity) as Array<keyof typeof identity>)(
	'rejects a stale form when its %s no longer matches',
	async (field) => {
		const response = await submit('approve', {
			formIdentity: { [field]: 'stale' },
		})

		expect(response.status).toBe(409)
		expect(state.writeApproval).not.toHaveBeenCalled()
	},
)

test('rejects a cross-origin approval before reading the visitor', async () => {
	const response = await submit('approve', { origin: 'https://app.test' })

	expect(response.status).toBe(403)
	expect(state.authenticated).not.toHaveBeenCalled()
	expect(state.writeApproval).not.toHaveBeenCalled()
})

test.each([
	['browser OAuth', oauthResume],
	['device OAuth', deviceResume],
])('approval resumes matching %s authorization', async (_, resume) => {
	const response = await submit('approve', { resume })

	expect(response.status).toBe(200)
	expect(response.headers.get('Refresh')).toBe(`0; url=${resume}`)
	expect(state.writeApproval).toHaveBeenCalledOnce()
})

test.each([
	'https://app.test/oauth/package-app/authorize?client_id=publisher/lantern',
	'/oauth/package-app/authorize?client_id=publisher/sibling',
	'/account',
])('rejects an unrelated authorization resume %s', async (resume) => {
	const response = await submit('approve', { resume })

	expect(response.status).toBe(404)
	expect(state.writeApproval).not.toHaveBeenCalled()
})

test('rejects a device resume unavailable to the current visitor', async () => {
	state.findDevice.mockResolvedValueOnce({ kind: 'not_found' })
	const response = await submit('approve', { resume: deviceResume })

	expect(response.status).toBe(404)
	expect(state.findDevice).toHaveBeenCalledWith({
		request: expect.any(Request),
		env: state.env,
		user: { personId, email: 'visitor@example.com' },
		userCode: 'ABCD-EFGH',
	})
	expect(state.writeApproval).not.toHaveBeenCalled()
})
