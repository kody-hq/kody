import { appendFileSync } from 'node:fs'

type StartupBundleOverageName = 'origin' | 'platform' | 'runtime'

export type StartupBundleOverage = {
	name: StartupBundleOverageName
	size: number
	maxEntryBytes: number
	overage: number
}

function formatStartupBundleBytes(bytes: number) {
	return bytes.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_')
}

function formatStartupBundleOverageWarning(overage: StartupBundleOverage) {
	return (
		`${overage.name} startup entry is ${formatStartupBundleBytes(overage.size)} bytes, ` +
		`${formatStartupBundleBytes(overage.overage)} over its ` +
		`${formatStartupBundleBytes(overage.maxEntryBytes)}-byte reviewed budget ` +
		`(warning only; does not fail CI).`
	)
}

function formatStartupBundleOverageSummary(
	overages: ReadonlyArray<StartupBundleOverage>,
) {
	const rows = overages.map(
		(o) =>
			`| ${o.name} | ${formatStartupBundleBytes(o.size)} | ${formatStartupBundleBytes(o.maxEntryBytes)} | ${formatStartupBundleBytes(o.overage)} |`,
	)
	return [
		'### 📦 Startup budget overage',
		'',
		'| Worker | Measured bytes | Reviewed budget | Overage |',
		'| --- | ---: | ---: | ---: |',
		...rows,
		'',
		'Warning only. Shrink the startup graph (preferred), or raise',
		'`tools/worker-startup-bundle-budget.json` and append a note in',
		'`tools/worker-startup-bundle-notes.md`.',
		'',
	].join('\n')
}

/**
 * Warns about startup byte overages as GitHub Actions check annotations and a
 * job summary section. Never fails the check.
 */
export function reportStartupBundleOverages(
	overages: ReadonlyArray<StartupBundleOverage>,
	options: {
		env?: NodeJS.ProcessEnv
		log?: (message: string) => void
	} = {},
) {
	if (overages.length === 0) return
	const env = options.env ?? process.env
	const log = options.log ?? console.warn
	const inActions = env.GITHUB_ACTIONS === 'true'
	for (const overage of overages) {
		const warning = formatStartupBundleOverageWarning(overage)
		log(
			inActions
				? `::warning title=Startup budget overage: ${overage.name}::${warning}`
				: warning,
		)
	}
	const summaryPath = env.GITHUB_STEP_SUMMARY?.trim()
	if (!summaryPath) return
	try {
		appendFileSync(
			summaryPath,
			`${formatStartupBundleOverageSummary(overages)}\n`,
			'utf8',
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		log(`Could not write startup budget overage job summary: ${message}`)
	}
}
