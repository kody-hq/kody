const { build } = require('esbuild')
const { mkdirSync, readFileSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const { resolve } = require('node:path')

/** Light/dark screenshots of the disabled org chooser when an org is required. */
async function smoke() {
	const root = resolve(__dirname, '../../..')
	mkdirSync(resolve(root, 'artifacts'), { recursive: true })
	const bundled = await build({
		stdin: {
			contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AuthorizeOrgField} from './packages/worker/start/pages/oauth-authorize-org-picker.tsx';
createRoot(document.getElementById('root')).render(
  <main style={{padding:24,fontFamily:'system-ui',maxWidth:480}}>
    <h1>Authorize connection</h1>
    <AuthorizeOrgField
      orgs={[
        {slug:'ada',displayName:'Ada',role:'owner'},
        {slug:'acme',displayName:'Acme',role:'member'},
      ]}
      selectedOrgSlug="ada"
      signedIn
      requiredOrgSlug="ada"
      onChange={() => {}}
    />
  </main>
);
`,
			resolveDir: root,
			loader: 'tsx',
		},
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: [
			{
				name: 'aliases',
				setup(build) {
					build.onResolve({ filter: /^#client\// }, (args) => ({
						path: resolve(
							root,
							'packages/worker/client',
							args.path.slice('#client/'.length),
						),
					}))
					build.onResolve({ filter: /^#universal\// }, (args) => ({
						path: resolve(
							root,
							'packages/worker/universal',
							args.path.slice('#universal/'.length),
						),
					}))
				},
			},
		],
	})
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage({
			viewport: { width: 720, height: 560 },
		})
		const styles = readFileSync(
			resolve(root, 'packages/worker/public/styles.css'),
			'utf8',
		)
		await page.setContent('<div id="root"></div>')
		await page.addStyleTag({ content: styles })
		await page.addScriptTag({ content: bundled.outputFiles[0].text })
		await expect(page.getByTestId('oauth-authorize-org-locked')).toBeVisible()
		await expect(
			page.getByTestId('oauth-authorize-org-disabled'),
		).toBeDisabled()
		await expect(
			page.getByTestId('oauth-authorize-org-locked-reason'),
		).toContainText('started for @ada')
		for (const colorScheme of ['light', 'dark']) {
			await page.emulateMedia({ colorScheme })
			await page.screenshot({
				path: resolve(
					root,
					`artifacts/oauth-authorize-org-locked-${colorScheme}.png`,
				),
			})
		}
		console.log('OAuth authorize locked org chooser smoke passed.')
	} finally {
		await browser.close()
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
