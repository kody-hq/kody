import path from 'node:path'
import { waitForAnimationsToSettle } from '../page-settle.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import { findAxeViolations } from './checks.ts'
import { isolateGallerySection } from './gallery.ts'
import { uiVerifyPaths, uiVerifyUpdateCommand } from './paths.ts'
import { pinnedBrowserEndpoint } from './pinned-browser.ts'
import { themes } from './targets.ts'

// Keyboard and ARIA behavior of the shared controls, driven through the
// /dev/ui gallery so each component is tested the way pages render it.
test.describe('shared form controls', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/dev/ui#choice')
		await waitForClientHydration(page)
		await expect(
			page.getByRole('heading', { name: 'UI gallery', level: 1 }),
		).toBeVisible()
	})

	test('Field labels its control and announces description and error', async ({
		page,
	}) => {
		await expect(
			page.getByLabel('With description'),
		).toHaveAccessibleDescription('Help text, announced with the control.')
		const invalid = page.getByLabel('Invalid')
		await expect(invalid).toHaveAttribute('aria-invalid', 'true')
		await expect(invalid).toHaveAccessibleDescription(
			'Enter a valid email address.',
		)
		await page.getByText('Default', { exact: true }).click()
		await expect(page.getByLabel('Default')).toBeFocused()
	})

	test('Checkbox shows mixed state for a partly selected group', async ({
		page,
	}) => {
		const all = page.getByRole('checkbox', { name: 'Select all' })
		await expect(all).toHaveJSProperty('indeterminate', true)
		await all.focus()
		await page.keyboard.press('Space')
		await expect(all).toBeChecked()
		await expect(all).toHaveJSProperty('indeterminate', false)
		await expect(page.getByRole('checkbox', { name: 'Item 2' })).toBeChecked()
		await page.getByRole('checkbox', { name: 'Item 1' }).click()
		await expect(all).toHaveJSProperty('indeterminate', true)
	})

	test('Radio group moves selection with arrow keys and skips disabled', async ({
		page,
	}) => {
		const team = page.getByRole('radio', { name: 'Team' })
		await expect(team).toBeChecked()
		await team.focus()
		await page.keyboard.press('ArrowLeft')
		await expect(page.getByRole('radio', { name: 'Free' })).toBeChecked()
		await expect(page.getByRole('radio', { name: 'Free' })).toBeFocused()
		await expect(page.getByRole('radio', { name: 'Enterprise' })).toBeDisabled()
	})

	test('Switch toggles with Space, Enter, and its label', async ({ page }) => {
		const toggle = page.getByRole('switch', { name: 'Email notifications' })
		await expect(toggle).toHaveAttribute('aria-checked', 'true')
		await toggle.focus()
		await page.keyboard.press('Space')
		await expect(toggle).toHaveAttribute('aria-checked', 'false')
		await expect(toggle).toBeFocused()
		await page.keyboard.press('Enter')
		await expect(toggle).toHaveAttribute('aria-checked', 'true')
		await page.getByText('Email notifications', { exact: true }).click()
		await expect(toggle).toHaveAttribute('aria-checked', 'false')
		const disabled = page.getByRole('switch', { name: 'Disabled on' })
		await expect(disabled).toBeDisabled()
		await expect(disabled).toHaveAttribute('aria-checked', 'true')
	})
})

test.describe('Dialog', () => {
	test.beforeEach(async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' })
		await page.goto('/dev/ui#dialog')
		await waitForClientHydration(page)
	})

	test('moves focus in, traps Tab, ignores outside clicks, and restores focus on Escape', async ({
		page,
	}) => {
		const trigger = page.getByRole('button', { name: 'Rename file' })
		await trigger.click()
		const dialog = page.getByRole('dialog', { name: 'Rename file' })
		await expect(dialog).toHaveAccessibleDescription(
			'Names must be unique in this folder.',
		)
		const name = dialog.getByRole('textbox', { name: 'Name' })
		const save = dialog.getByRole('button', { name: 'Save' })
		await expect(name).toBeFocused()
		await page.keyboard.press('Tab')
		await page.keyboard.press('Tab')
		await expect(save).toBeFocused()
		await page.keyboard.press('Tab')
		await expect(name).toBeFocused()
		await page.keyboard.press('Shift+Tab')
		await expect(save).toBeFocused()
		await page.mouse.click(5, 5)
		await expect(dialog).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(dialog).toBeHidden()
		await expect(trigger).toBeFocused()
	})

	test('dismissOnOutsideClick closes on an outside click and restores focus', async ({
		page,
	}) => {
		const trigger = page.getByRole('button', { name: 'Quick look' })
		await trigger.click()
		const dialog = page.getByRole('dialog', { name: 'Quick look' })
		await expect(dialog).toBeVisible()
		await page.mouse.click(5, 5)
		await expect(dialog).toBeHidden()
		await expect(trigger).toBeFocused()
	})

	test('alertdialog closes only from Escape or its buttons', async ({
		page,
	}) => {
		const trigger = page.getByRole('button', { name: 'Delete file' })
		await trigger.click()
		const dialog = page.getByRole('alertdialog', { name: 'Delete notes.md?' })
		await expect(dialog).toHaveAccessibleDescription("This can't be undone.")
		await page.mouse.click(5, 5)
		await expect(dialog).toBeVisible()
		await dialog.getByRole('button', { name: 'Cancel' }).click()
		await expect(dialog).toBeHidden()
		await expect(trigger).toBeFocused()
	})

	for (const theme of themes) {
		test(`open dialogs pass axe and match baselines (${theme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
			await isolateGallerySection(page, 'dialog')
			for (const [trigger, role] of [
				['Rename file', 'dialog'],
				['Delete file', 'alertdialog'],
				['Side panel', 'dialog'],
			] as const) {
				await page.getByRole('button', { name: trigger }).click()
				const dialog = page.getByRole(role)
				await expect(dialog).toBeVisible()
				await waitForAnimationsToSettle(page)
				const slug = trigger.toLowerCase().replaceAll(' ', '-')
				await page.screenshot({
					path: path.join(
						uiVerifyPaths.screenshots,
						`gallery-dialog-${slug}-${theme}.png`,
					),
					animations: 'disabled',
					caret: 'hide',
				})
				if (pinnedBrowserEndpoint()) {
					await expect
						.soft(
							page,
							`visual: open "${trigger}" dialog (${theme}) no longer matches its baseline. If the change is intended, run \`${uiVerifyUpdateCommand}\` and commit the files under ${uiVerifyPaths.baselines}/.`,
						)
						.toHaveScreenshot(`gallery-dialog-${slug}-${theme}.png`)
				}
				expect
					.soft(
						await findAxeViolations(page),
						`axe: open "${trigger}" dialog (${theme}) has blocking accessibility violations.`,
					)
					.toEqual([])
				await page.keyboard.press('Escape')
				await expect(dialog).toBeHidden()
			}
		})
	}
})

test.describe('Install package app dialog', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/dev/ui#install-app')
		await waitForClientHydration(page)
	})

	for (const theme of themes) {
		test(`confirms, installs, and passes axe (${theme})`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
			await isolateGallerySection(page, 'install-app')
			const trigger = page.getByRole('button', {
				name: 'Install Weather',
				exact: true,
			})
			await trigger.click()
			const dialog = page.getByRole('dialog', { name: 'Install Weather?' })
			await expect(dialog).toHaveAccessibleDescription(
				'It opens in its own window with a launcher on this computer and always runs the latest published version.',
			)
			for (const step of ['confirm', 'installed'] as const) {
				if (step === 'installed') {
					await dialog.getByRole('button', { name: 'Install' }).click()
					await expect(
						page.getByRole('dialog', { name: 'Weather is installed' }),
					).toBeVisible()
				}
				await waitForAnimationsToSettle(page)
				const name = `gallery-install-app-${step}-${theme}.png`
				await page.screenshot({
					path: path.join(uiVerifyPaths.screenshots, name),
					animations: 'disabled',
					caret: 'hide',
				})
				if (pinnedBrowserEndpoint()) {
					await expect
						.soft(
							page,
							`visual: install dialog ${step} (${theme}) no longer matches its baseline. If the change is intended, run \`${uiVerifyUpdateCommand}\` and commit the files under ${uiVerifyPaths.baselines}/.`,
						)
						.toHaveScreenshot(name)
				}
				expect
					.soft(
						await findAxeViolations(page),
						`axe: install dialog ${step} (${theme}) has blocking accessibility violations.`,
					)
					.toEqual([])
			}
			await page.getByRole('button', { name: 'Done' }).click()
			await expect(trigger).toBeFocused()
		})
	}
})

test.describe('Menu', () => {
	test.beforeEach(async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' })
		await page.goto('/dev/ui#menu')
		await waitForClientHydration(page)
	})

	test('opens from the keyboard, announces disabled items, and restores focus', async ({
		page,
	}) => {
		const trigger = page.getByRole('button', { name: 'File actions' })
		await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
		await trigger.focus()
		await page.keyboard.press('ArrowDown')
		const menu = page.getByRole('menu', { name: 'File actions' })
		await expect(menu).toBeVisible()
		await expect(trigger).toHaveAttribute('aria-expanded', 'true')
		const rename = menu.getByRole('menuitem', { name: 'Rename' })
		await expect(rename).toBeFocused()
		await page.keyboard.press('ArrowDown')
		await page.keyboard.press('ArrowDown')
		const move = menu.getByRole('menuitem', { name: 'Move (no other folders)' })
		await expect(move).toBeFocused()
		await expect(move).toHaveAttribute('aria-disabled', 'true')
		await page.keyboard.press('Enter')
		await expect(menu).toBeVisible()
		await page.keyboard.press('ArrowDown')
		await expect(
			menu.getByRole('menuitemcheckbox', { name: 'Wrap lines' }),
		).toBeFocused()
		await page.keyboard.press('Space')
		await expect(
			menu.getByRole('menuitemcheckbox', { name: 'Wrap lines' }),
		).toHaveAttribute('aria-checked', 'false')
		await page.keyboard.press('Escape')
		await expect(menu).toBeHidden()
		await expect(trigger).toBeFocused()
	})

	test('Enter runs an item and closes the menu', async ({ page }) => {
		const trigger = page.getByRole('button', { name: 'File actions' })
		await trigger.focus()
		await page.keyboard.press('Enter')
		const menu = page.getByRole('menu', { name: 'File actions' })
		await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
		await page.keyboard.press('ArrowDown')
		await page.keyboard.press('Enter')
		await expect(menu).toBeHidden()
		await expect(
			page.getByRole('status').getByText('Duplicated.'),
		).toBeVisible()
		await expect(trigger).toBeFocused()
	})

	for (const theme of themes) {
		test(`open menu passes axe and matches its baseline (${theme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
			await isolateGallerySection(page, 'menu')
			const trigger = page.getByRole('button', { name: 'File actions' })
			await trigger.click()
			const menu = page.getByRole('menu', { name: 'File actions' })
			await expect(menu).toBeVisible()
			await waitForAnimationsToSettle(page)
			const shot = `gallery-menu-open-${theme}.png`
			await menu.screenshot({
				path: path.join(uiVerifyPaths.screenshots, shot),
				animations: 'disabled',
			})
			if (pinnedBrowserEndpoint()) {
				await expect
					.soft(
						menu,
						`visual: open menu (${theme}) no longer matches its baseline. If the change is intended, run \`${uiVerifyUpdateCommand}\` and commit the files under ${uiVerifyPaths.baselines}/.`,
					)
					.toHaveScreenshot(shot)
			}
			expect
				.soft(
					await findAxeViolations(page),
					`axe: open menu (${theme}) has blocking accessibility violations.`,
				)
				.toEqual([])
		})
	}
})

test.describe('Tooltip', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/dev/ui#tooltip')
		await waitForClientHydration(page)
	})

	test('describes its trigger, shows on focus and hover, and Escape hides it', async ({
		page,
	}) => {
		const trigger = page.getByRole('button', { name: 'Above' })
		const tip = page.getByText('Shows on hover and focus.')
		await expect(trigger).toHaveAccessibleDescription(
			'Shows on hover and focus.',
		)
		await expect(tip).toBeHidden()
		await trigger.focus()
		await page.keyboard.press('Shift+Tab')
		await page.keyboard.press('Tab')
		await expect(tip).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(tip).toBeHidden()
		await expect(trigger).toBeFocused()
		await page.keyboard.press('Tab')
		await page.mouse.move(0, 0)
		await trigger.hover()
		await expect(tip).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(tip).toBeHidden()
	})
})

test.describe('Tabs', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/dev/ui#tabs')
		await waitForClientHydration(page)
	})

	test('arrow keys, Home, and End select tabs and skip disabled ones', async ({
		page,
	}) => {
		const list = page.getByRole('tablist', { name: 'Email body' })
		const html = list.getByRole('tab', { name: 'HTML' })
		const text = list.getByRole('tab', { name: 'Text' })
		await expect(html).toHaveAttribute('aria-selected', 'true')
		await expect(page.getByRole('tabpanel', { name: 'HTML' })).toHaveText(
			'Rendered HTML body.',
		)
		await html.focus()
		await page.keyboard.press('ArrowRight')
		await expect(text).toBeFocused()
		await expect(text).toHaveAttribute('aria-selected', 'true')
		await expect(page.getByRole('tabpanel', { name: 'Text' })).toBeVisible()
		await expect(page.getByText('Rendered HTML body.')).toBeHidden()
		await page.keyboard.press('ArrowRight')
		await expect(html).toBeFocused()
		await page.keyboard.press('End')
		await expect(text).toBeFocused()
		await page.keyboard.press('Home')
		await expect(html).toBeFocused()
		await expect(list.getByRole('tab', { name: 'Source' })).toBeDisabled()
		await page.keyboard.press('Tab')
		await expect(page.getByRole('tabpanel', { name: 'HTML' })).toBeFocused()
	})

	test('underline tabs select on click', async ({ page }) => {
		const list = page.getByRole('tablist', { name: 'File settings' })
		await list.getByRole('tab', { name: 'Details' }).click()
		await expect(page.getByRole('tabpanel', { name: 'Details' })).toHaveText(
			'Type, modified date, and location.',
		)
	})
})
