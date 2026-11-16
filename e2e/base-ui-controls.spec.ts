import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

test('preview tooltips keep keyboard focus and alert dialogs require explicit dismissal', async ({
	page,
}) => {
	const bundle = await build({
		stdin: {
			loader: 'tsx',
			resolveDir: process.cwd(),
			contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CopyTextButton } from './packages/worker/start/components/copy-text-button.tsx'
import { Dialog } from './packages/worker/start/components/dialog.tsx'

function Fixture() {
	const [open, setOpen] = useState(false)
	return <>
		<CopyTextButton iconOnly title="" value="source" ariaLabel="Copy index.ts"
			tooltip={{ id: 'copy-source-tooltip', text: 'Copy source' }} />
		<button onClick={() => setOpen(true)}>Delete package</button>
		<Dialog open={open} aria-label="Delete example" role="alertdialog" onClose={() => setOpen(false)}>
			<button onClick={() => setOpen(false)}>Cancel</button>
		</Dialog>
	</>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`,
		},
		alias: {
			'#universal': resolve('packages/worker/universal'),
			'#client': resolve('packages/worker/client'),
		},
		bundle: true,
		write: false,
		jsx: 'automatic',
		platform: 'browser',
	})
	await page.route('https://overlays.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'text/javascript', body: bundle.outputFiles[0]!.text }
				: {
						contentType: 'text/html',
						body: '<!doctype html><div id="root"></div><script src="/app.js"></script>',
					},
		),
	)
	await page.goto('https://overlays.test/')
	const copy = page.getByRole('button', { name: 'Copy index.ts' })
	await page.keyboard.press('Tab')
	await expect(copy).toBeFocused()
	const tooltip = page.getByText('Copy source', { exact: true })
	await expect(tooltip).toBeVisible()
	await expect(copy).toHaveAccessibleDescription('Copy source')
	await copy.press('Escape')
	await expect(tooltip).toBeHidden()
	await expect(copy).toBeFocused()
	await page.mouse.move(400, 400)
	await copy.hover()
	await expect(tooltip).toBeVisible()

	const trigger = page.getByRole('button', { name: 'Delete package' })
	await trigger.click()
	const dialog = page.getByRole('alertdialog', { name: 'Delete example' })
	await expect(dialog).toBeVisible()
	await page.mouse.click(5, 5)
	await expect(dialog).toBeVisible()
	await dialog.getByRole('button', { name: 'Cancel' }).press('Escape')
	await expect(dialog).toBeHidden()
	await expect(trigger).toBeFocused()
})
