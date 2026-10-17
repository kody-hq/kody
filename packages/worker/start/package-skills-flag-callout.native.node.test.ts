import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { renderPackageSkillsFlagCallout } from './pages/package-skills-flag-callout.tsx'
import { routes } from '#universal/routes.ts'

test('package skills flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderPackageSkillsFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="package-skills-flag-callout"')
	expect(loggedOut).toContain('data-testid="package-skills-flag-login"')
	expect(loggedOut).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent(routes.docDetail.href({ slug: 'package-skills' }))}"`,
	)
	expect(loggedOut).not.toContain('data-testid="package-skills-flag-opt-in"')

	const loggedIn = await renderToString(
		renderPackageSkillsFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="package-skills-flag-opt-in"')
	expect(loggedIn).toContain('type="button"')
	expect(loggedIn).not.toContain('data-testid="package-skills-flag-login"')

	const alreadyOn = await renderToString(
		renderPackageSkillsFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).not.toContain('data-testid="package-skills-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="package-skills-flag-login"')
})
