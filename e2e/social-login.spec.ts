import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { completeUsernameChoice } from './complete-username-choice.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	executeE2eD1Command,
} from './d1-utils.ts'
import { buildDeleteUserAndPersonalOrgSql } from '../tools/seed-sql.ts'

// The test wrangler env ships MOCK_ social-login client ids, so the full
// start -> provider -> callback redirect round-trip runs in-worker against
// canned mock provider profiles (no provider apps or network needed).
test('social login signs in via mock GitHub and manages connections', async ({
	page,
}) => {
	const mockSocialEmails = [
		'mock-github-user@example.com',
		'mock-google-user@example.com',
		'mock-discord-user@example.com',
	]
	executeE2eD1Command(
		`DELETE FROM oauth_connections WHERE provider_id IN ('mock-github-user-1', 'mock-google-user-1', 'mock-x-user-1', 'mock-discord-user-1');
${buildDeleteUserAndPersonalOrgSql({
	emails: mockSocialEmails,
	// OAuth signup mints a new stable_user_id each run; drop orphaned slugs
	// left when older tests deleted users without org cleanup.
	orphanPersonalOrgSlugs: [
		'mock-octo',
		'mock-google-user',
		'mock-discord-user',
	],
})}`,
	)
	clearAuthRateLimitsInE2eDatabase()
	await page.context().clearCookies()

	await page.goto('/login')
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Continue with GitHub' }).click()
	await completeUsernameChoice(page, 'mock-octo')

	// A brand-new social account lands on onboarding rather than the account
	// page, matching where password signups go after verification.
	await expect(page).toHaveURL(/\/onboarding\/step-1\?accountCreated=1$/)
	await expect(
		page.getByRole('heading', { name: /Get started with\s*Kody/i }),
	).toBeVisible()

	await page.goto('/account')
	await expect(
		page.getByRole('heading', {
			level: 1,
			name: 'Account settings',
			exact: true,
		}),
	).toBeVisible()
	// The redesign moved the verified state out of the sentence and into a pill
	// beside the address, so "(verified)" is no longer part of one contiguous
	// string. Assert the address and the pill separately.
	const emailNote = page.getByText('Email: mock-github-user@example.com')
	await expect(emailNote).toBeVisible()
	await expect(emailNote.getByText('verified')).toBeVisible()

	await page.goto('/account/security')
	await expect(
		page.getByRole('heading', { level: 1, name: 'Security', exact: true }),
	).toBeVisible()
	const connectionsCard = page.getByRole('region', {
		name: 'Connected accounts',
	})
	await expect(
		connectionsCard.getByText('Connected as mock-octo'),
	).toBeVisible()

	clearAuthRateLimitsInE2eDatabase()
	await waitForClientHydration(page)
	await connectionsCard.getByRole('button', { name: 'Connect Google' }).click()
	await expect(page).toHaveURL(/\/account\/security\?oauthLinked=google$/)
	await expect(page.getByText('Google connected.')).toBeVisible()
	const googleRow = connectionsCard
		.getByRole('listitem')
		.filter({ hasText: 'Google' })
	await expect(googleRow).toBeVisible()
	await expect(
		googleRow.getByText('Connected as Mock Google User'),
	).toBeVisible()

	clearAuthRateLimitsInE2eDatabase()
	await waitForClientHydration(page)
	await connectionsCard.getByRole('button', { name: 'Connect Discord' }).click()
	await expect(page).toHaveURL(/\/account\/security\?oauthLinked=discord$/)
	await expect(page.getByText('Discord connected.')).toBeVisible()
	const discordRow = connectionsCard
		.getByRole('listitem')
		.filter({ hasText: 'Discord' })
	await expect(discordRow).toBeVisible()
	await expect(
		discordRow.getByText('Connected as mock-discord-user'),
	).toBeVisible()
	await expect(
		discordRow.getByRole('link', { name: 'Join the Kody Discord' }),
	).toBeVisible()
})
