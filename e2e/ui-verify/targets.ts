import type { Page } from '@playwright/test'
import { expect } from '../playwright-utils.ts'

export type Theme = 'light' | 'dark'
export const themes: Theme[] = ['light', 'dark']

export const viewports = {
	desktop: { width: 1280, height: 800 },
	mobile: { width: 390, height: 844 },
} as const
export type ViewportName = keyof typeof viewports

/**
 * How a target is compared with its committed baseline:
 * - `sections`: one baseline per `[data-ui-gallery-section]` (the gallery)
 * - `page`: one full-page baseline
 * - `none`: content varies per run (ids, dates); screenshot and scan only
 */
export type VisualCheck =
	| { kind: 'sections' }
	| { kind: 'page'; mask?: string[] }
	| { kind: 'none'; reason: string }

export type UiVerifyTarget = {
	id: string
	path: string
	session: 'anonymous' | 'user' | 'admin'
	visual: VisualCheck
	ready: (page: Page) => Promise<void>
	/** Selector axe skips, with the owner of the known violation. */
	axeExclude?: string
}

/**
 * Hydration enables the auth submit button and fades it from the disabled
 * 0.7 opacity. Axe blends that opacity into the measured colours, so a scan
 * mid-fade reports a false contrast failure (#4507).
 */
async function expectSubmitSettled(page: Page) {
	const submit = page.getByRole('button', {
		name: /^(Sign in|Create account)$/,
	})
	await expect(submit).toBeEnabled()
	await expect(submit).toHaveCSS('opacity', '1')
}

export const uiVerifyTargets: UiVerifyTarget[] = [
	{
		id: 'gallery',
		path: '/dev/ui',
		session: 'anonymous',
		visual: { kind: 'sections' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: 'UI gallery', level: 1 }),
			).toBeVisible()
		},
	},
	{
		id: 'home',
		path: '/',
		session: 'anonymous',
		// The loader shuffles the agent marquee and walkthrough hosts per request.
		visual: { kind: 'page', mask: ['.landing-agents-row', '.landing-proof'] },
		ready: async (page) => {
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		},
	},
	{
		id: 'login',
		path: '/login',
		session: 'anonymous',
		visual: { kind: 'page' },
		// signup-gateway owns this invalid aria-pressed link.
		axeExclude: 'a[aria-pressed]',
		ready: async (page) => {
			await expect(page.getByLabel('Email')).toBeVisible()
			await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
			await expectSubmitSettled(page)
		},
	},
	{
		id: 'signup',
		path: '/signup',
		session: 'anonymous',
		visual: { kind: 'page' },
		axeExclude: 'a[aria-pressed]',
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: 'Create your account' }),
			).toBeVisible()
			await expect(
				page.getByRole('textbox', { name: 'Username' }),
			).toBeVisible()
			await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
			await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
			await expectSubmitSettled(page)
		},
	},
	{
		id: 'not-found',
		path: '/this-page-does-not-exist',
		session: 'anonymous',
		visual: { kind: 'page' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', {
					name: "This doesn't quite connect.",
					level: 1,
				}),
			).toBeVisible()
			await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible()
		},
	},
	{
		id: 'account',
		path: '/account',
		session: 'user',
		visual: { kind: 'page' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', {
					level: 1,
					name: 'Account settings',
					exact: true,
				}),
			).toBeVisible()
		},
	},
	{
		id: 'onboarding',
		path: '/onboarding',
		session: 'user',
		// The featured agent grid is shuffled per session.
		visual: { kind: 'page', mask: ['[data-testid="onboarding-agent-picker"]'] },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: /Get started with\s*Kody/i }),
			).toBeVisible()
		},
	},
	{
		id: 'admin-users',
		path: '/admin/users',
		session: 'admin',
		visual: { kind: 'none', reason: 'lists every seeded user' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: 'Admin users', exact: true }),
			).toBeVisible()
		},
	},
]
