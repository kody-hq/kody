#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const [runsFile, inventoryFile, label] = process.argv.slice(2)
if (!runsFile || !inventoryFile || !label)
	throw new Error(
		'Usage: check-results.mjs BROWSER_RUNS_JSON INVENTORY_JSON LABEL',
	)
const report = JSON.parse(readFileSync(runsFile, 'utf8'))
const inventory = JSON.parse(
	readFileSync(inventoryFile, 'utf8'),
).inventories.find((target) => target.label === label)
const budget = JSON.parse(
	readFileSync(new URL('budget.json', import.meta.url), 'utf8'),
)
const runs = report.runs.filter((run) => run.label === label)
const failures = []
if (!inventory || runs.length < budget.minimumSamples)
	throw new Error('Missing target inventory or insufficient samples')
const sizes = runs.map((run) => {
	if (
		run.failure ||
		run.errors.length ||
		run.consoleErrorCount ||
		run.steps.some((step) => step.fullDocumentReload)
	)
		failures.push('Page error, failed navigation or document reload')
	if (!run.initial?.resources?.length)
		throw new Error('Initial resource evidence is missing')
	const scripts = run.initial.resources.filter((resource) =>
		resource.path.endsWith('.js'),
	)
	const styles = run.initial.resources.filter((resource) =>
		resource.path.endsWith('.css'),
	)
	if (!scripts.length || (!styles.length && !run.initial.inlineStylesheetBytes))
		throw new Error('Initial script or stylesheet evidence is missing')
	const jsBytes = scripts.reduce(
		(sum, resource) => sum + resource.encodedBytes,
		0,
	)
	const cssBytes =
		(run.initial.inlineStylesheetBytes ?? 0) +
		styles.reduce((sum, resource) => {
			const asset = inventory.assets.find(
				(asset) => asset.path === 'client' + resource.path,
			)
			if (!asset)
				throw new Error(`Stylesheet not found in inventory: ${resource.path}`)
			return sum + asset.bytes
		}, 0)
	if (jsBytes > budget.initialJsEncodedBytes)
		failures.push(`Initial JS ${jsBytes} > ${budget.initialJsEncodedBytes}`)
	if (cssBytes > budget.initialCssRawBytes)
		failures.push(`Initial CSS ${cssBytes} > ${budget.initialCssRawBytes}`)
	return { jsBytes, cssBytes }
})
console.log(
	JSON.stringify(
		{
			label,
			samples: runs.length,
			budget,
			sizes,
			failures: [...new Set(failures)],
		},
		null,
		2,
	),
)
process.exitCode = failures.length ? 1 : 0
