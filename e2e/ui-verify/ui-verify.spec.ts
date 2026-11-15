import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { ensurePrimaryUserExists } from '../auth-test-user.ts'
import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from '../playwright-utils.ts'
import {
	waitForAnimationsToSettle,
	waitForSettledColours,
} from '../page-settle.ts'
import {
	describeFocusProblems,
	findAxeViolations,
	sweepFocus,
} from './checks.ts'
import { uiVerifyPaths, uiVerifyUpdateCommand } from './paths.ts'
import {
	themes,
	uiVerifyTargets,
	viewports,
	type Theme,
	type UiVerifyTarget,
	type ViewportName,
} from './targets.ts'

const admin = {
	email: 'ui-verify-admin@example.com',
	username: 'ui-verify-admin',
	password: 'ui-verify-admin-password',
}

async function openTarget(
	page: Page,
	target: UiVerifyTarget,
	theme: Theme,
	viewport: ViewportName,
) {
	await page.setViewportSize(viewports[viewport])
	await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
	await page.goto(target.path)
	await waitForClientHydration(page)
	await target.ready(page)
	await waitForAnimationsToSettle(page)
	await waitForSettledColours(page)
	await page.evaluate(() => document.fonts.ready)
}

const baselineHint = `If the change is intended, run \`${uiVerifyUpdateCommand}\` and commit the files under ${uiVerifyPaths.baselines}/.`

for (const target of uiVerifyTargets) {
	test.describe(target.id, () => {
		test.beforeEach(async ({ page, login, seedE2eUser }) => {
			await page.context().clearCookies()
			if (target.session === 'user') {
				await ensurePrimaryUserExists()
				await login({ mode: 'login' })
			}
			if (target.session === 'admin') {
				await seedE2eUser({ ...admin, admin: true })
				await login({ ...admin, mode: 'login' })
			}
		})

		for (const theme of themes) {
			for (const viewport of Object.keys(viewports) as ViewportName[]) {
				const name = `${target.id}-${theme}-${viewport}`
				test(`${target.id} ${target.path} (${theme}, ${viewport})`, async ({
					page,
				}) => {
					await openTarget(page, target, theme, viewport)

					mkdirSync(uiVerifyPaths.screenshots, { recursive: true })
					await page.screenshot({
						path: path.join(uiVerifyPaths.screenshots, `${name}.png`),
						fullPage: true,
						animations: 'disabled',
						caret: 'hide',
					})

					// Visual first: the focus sweep scrolls and leaves focus behind.
					if (target.visual.kind === 'sections') {
						const sections = page.locator('[data-ui-gallery-section]')
						const ids = await sections.evaluateAll((nodes) =>
							nodes.map((node) =>
								node.getAttribute('data-ui-gallery-section')!,
							),
						)
						for (const id of ids) {
							await expect
								.soft(
									page.locator(`[data-ui-gallery-section="${id}"]`),
									`visual: gallery section "${id}" (${theme}, ${viewport}) no longer matches its baseline. ${baselineHint}`,
								)
								.toHaveScreenshot(`gallery-${id}-${theme}-${viewport}.png`)
						}
					} else if (target.visual.kind === 'page') {
						await expect
							.soft(
								page,
								`visual: ${target.path} (${theme}, ${viewport}) no longer matches its baseline. ${baselineHint}`,
							)
							.toHaveScreenshot(`${name}.png`, {
								fullPage: true,
								mask: (target.visual.mask ?? []).map((selector) =>
									page.locator(selector),
								),
							})
					}

					const violations = await findAxeViolations(page, {
						exclude: target.axeExclude,
					})
					expect
						.soft(
							violations,
							`axe: ${target.path} (${theme}, ${viewport}) has blocking accessibility violations. Fix the markup; each line names the rule, the elements, and a how-to link.`,
						)
						.toEqual([])

					const focusProblems = describeFocusProblems(await sweepFocus(page))
					expect
						.soft(
							focusProblems,
							`keyboard: tabbing through ${target.path} (${theme}, ${viewport}) found stops without a visible focus indicator. Keep the global :focus-visible outline (or draw a ring with box-shadow) on each listed element.`,
						)
						.toEqual([])
				})
			}
		}
	})
}
