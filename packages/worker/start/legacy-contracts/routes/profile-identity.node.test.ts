import { renderStartPage } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
const renderToString = async (...args: Parameters<typeof renderStartPage>) =>
	(await renderStartPage(...args)).replace(/<!-- -->/g, '')
import { renderProfileIdentity } from '../../components/profile-identity.tsx'
import { type ProfileShellLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'

const publicSelf = {
	ok: true,
	username: 'jane',
	displayName: 'Jane Example',
	bio: 'Builds packages for other people to take.',
	avatarUrl: '/profiles/jane/avatar/hash.png',
	joinedAt: '2026-03-01T00:00:00.000Z',
	isSelf: true,
	loggedIn: true,
	visibility: 'public',
} satisfies ProfileShellLoaderData

test('profile identity renders the person in HTML and keeps guest CTAs honest', async () => {
	const ownHtml = await renderToString(renderProfileIdentity(publicSelf))
	expect(ownHtml).toContain('data-testid="profile-identity"')
	expect(ownHtml).toContain('data-testid="profile-display-name"')
	expect(ownHtml).toContain('Jane Example')
	expect(ownHtml).toContain('@jane')
	expect(ownHtml).toContain('Builds packages for other people to take.')
	expect(ownHtml).toContain('src="/profiles/jane/avatar/hash.png"')
	expect(ownHtml).toContain('width:72px')
	expect(ownHtml).toContain('@media (min-width: 821px)')
	expect(ownHtml).toContain('width:160px')
	expect(ownHtml.replace(/<!-- -->/g, '')).toContain('Joined March 1, 2026')
	expect(ownHtml).toContain('Workspace')
	expect(ownHtml).toContain('data-testid="profile-workspace"')
	expect(ownHtml).toContain('href="/@jane/-/repositories"')
	expect(ownHtml).toContain('Account settings')
	expect(ownHtml).toContain(`href="${routes.account.href()}"`)
	expect(ownHtml).not.toContain('data-testid="profile-guest-cta"')
	expect(ownHtml).not.toContain('data-testid="profile-private-badge"')
	expect(ownHtml).not.toContain('Log out')

	// After a username rename the profile handle can diverge from the
	// immutable personal org slug; Workspace must follow the org.
	const renamedHtml = await renderToString(
		renderProfileIdentity(
			{ ...publicSelf, username: 'jane-new' },
			{ workspaceOrgSlug: 'jane' },
		),
	)
	expect(renamedHtml).toContain('@jane-new')
	expect(renamedHtml).toContain('href="/@jane/-/repositories"')
	expect(renamedHtml).not.toContain('href="/@jane-new/-/repositories"')

	const privateHtml = await renderToString(
		renderProfileIdentity({
			...publicSelf,
			visibility: 'private',
		}),
	)
	expect(privateHtml).toContain('data-testid="profile-private-badge"')
	expect(privateHtml).toContain('Private')

	const guestHtml = await renderToString(
		renderProfileIdentity({
			...publicSelf,
			isSelf: false,
			loggedIn: false,
		}),
	)
	expect(guestHtml).toContain('data-testid="profile-guest-cta"')
	expect(guestHtml).toContain('Log in or sign up to fork these packages.')
	expect(guestHtml).toContain('Log in')
	expect(guestHtml).toContain('Sign up')
	expect(guestHtml).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent('/@jane')}"`,
	)
	expect(guestHtml).toContain(
		`href="${routes.signup.href()}?redirectTo=${encodeURIComponent('/@jane')}"`,
	)
	expect(guestHtml).not.toContain('Account settings')
	expect(guestHtml).not.toContain('Workspace')
	expect(guestHtml).not.toContain('data-testid="profile-actions"')

	const visitorHtml = await renderToString(
		renderProfileIdentity({
			...publicSelf,
			isSelf: false,
			loggedIn: true,
		}),
	)
	expect(visitorHtml).not.toContain('data-testid="profile-guest-cta"')
	expect(visitorHtml).not.toContain('Account settings')
	expect(visitorHtml).not.toContain('Workspace')
	expect(visitorHtml).toContain('Jane Example')
})
