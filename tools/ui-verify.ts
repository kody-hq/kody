/**
 * `npm run ui:verify`: render the component gallery and key pages headlessly
 * in light and dark, desktop and mobile; run axe, a keyboard focus sweep, and
 * visual diffs against committed baselines. Writes screenshots and a report
 * under .tmp/ui-verify. See docs/contributing/ui-verify.md.
 *
 *   npm run ui:verify                 # verify
 *   npm run ui:verify -- --update     # accept current rendering as the baseline
 *   npm run ui:verify -- -g gallery   # only targets whose title matches
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { uiVerifyPaths } from '../e2e/ui-verify/paths.ts'

const args = process.argv.slice(2)
const update = args.includes('--update')
const passthrough = args.filter((arg) => arg !== '--update')

rmSync(uiVerifyPaths.output, { recursive: true, force: true })

for (const setup of [
	'tools/prepare-e2e-env.ts',
	'tools/ensure-playwright-browser.ts',
]) {
	const result = spawnSync('node', [setup], { stdio: 'inherit' })
	if (result.status !== 0) process.exit(result.status ?? 1)
}

const run = spawnSync(
	'npx',
	[
		'playwright',
		'test',
		'--config',
		'playwright.ui-verify.config.ts',
		...(update ? ['--update-snapshots=all'] : []),
		...passthrough,
	],
	// npx is npx.cmd on Windows, which Node only spawns through a shell.
	{ stdio: 'inherit', shell: process.platform === 'win32' },
)
if (run.status === 0 && update)
	console.log(
		`\nBaselines updated under ${uiVerifyPaths.baselines}/. Review them with git diff and commit them with the UI change.`,
	)
process.exit(run.status ?? 1)
