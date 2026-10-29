#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [
	configFile,
	buildsArg,
	comparisonArg,
	startupFile,
	attributionFile,
	releaseFile,
	outputArg,
] = process.argv.slice(2)
if (!outputArg)
	throw new Error(
		'Usage: compact-evidence.mjs CONFIG BUILDS COMPARISON STARTUP_JSON ATTRIBUTION_JSON RELEASE_JSON NEW_OUTPUT',
	)
const load = (path) => JSON.parse(readFileSync(path, 'utf8'))
const config = load(configFile)
const builds = resolve(buildsArg)
const comparison = resolve(comparisonArg)
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
function clean(value) {
	if (typeof value === 'string') {
		for (const target of config.targets)
			value = value.replaceAll(target.root, `<${target.label}-checkout>`)
		return value
	}
	if (Array.isArray(value)) return value.map(clean)
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, clean(item)]),
		)
	return value
}
const write = (name, value) =>
	writeFileSync(
		join(output, name),
		JSON.stringify(clean(value), null, 2) + '\n',
	)
function stats(values) {
	const sorted = values
		.filter((value) => typeof value === 'number' && Number.isFinite(value))
		.sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return {
		count: sorted.length,
		median: sorted.length
			? sorted.length % 2
				? sorted[middle]
				: (sorted[middle - 1] + sorted[middle]) / 2
			: null,
		min: sorted[0] ?? null,
		max: sorted.at(-1) ?? null,
	}
}
const inventory = load(join(builds, 'inventory/inventory.json'))
write('inventory-summary.json', {
	...inventory,
	inventories: inventory.inventories.map(
		({ assets: _assets, ...rest }) => rest,
	),
})
write('build-runs.json', load(join(builds, 'runs.json')))
write(
	'artifact-fingerprints.json',
	load(join(comparison, 'artifact-fingerprints.json')),
)
write(
	'lighthouse-runs.json',
	load(join(comparison, 'lighthouse-targets/runs.json')),
)
write(
	'lighthouse-summary.json',
	load(join(comparison, 'lighthouse-targets/summary.json')),
)
writeFileSync(
	join(output, 'LIGHTHOUSE.md'),
	readFileSync(join(comparison, 'lighthouse-targets/SUMMARY.md')),
)
write('freshness-runs.json', load(join(comparison, 'freshness/runs.json')))
write('startup-runs.json', load(startupFile))
write('release-proof.json', load(releaseFile))
write('revisions.json', config)
write(
	'source-hashes.json',
	Object.fromEntries(
		config.targets.map((target) => [
			target.label,
			Object.fromEntries(
				['package.json', 'package-lock.json'].map((name) => [
					name,
					createHash('sha256')
						.update(readFileSync(join(target.root, name)))
						.digest('hex'),
				]),
			),
		]),
	),
)
const navigation = {},
	initial = {}
for (const kind of ['browser', 'private']) {
	const data = load(join(comparison, kind, 'runs.json'))
	const resourceInventories = {}
	const rows = data.runs.map((row) => {
		if (!row.initial) return row
		const resources = row.initial.resources
		const key = createHash('sha256')
			.update(JSON.stringify(resources))
			.digest('hex')
		resourceInventories[key] = resources
		const assets = inventory.inventories.find(
			(item) => item.label === row.label,
		).assets
		let cssBytes = 0
		for (const resource of resources.filter((resource) =>
			resource.path.endsWith('.css'),
		)) {
			const asset = assets.find(
				(asset) => asset.path === 'client' + resource.path,
			)
			if (!asset)
				throw new Error(`Missing CSS inventory: ${row.label}${resource.path}`)
			cssBytes += asset.bytes
		}
		const { resources: _resources, ...rest } = row.initial
		return {
			...row,
			initial: {
				...rest,
				resourceInventory: key,
				jsEncodedBytes: resources
					.filter((resource) => resource.path.endsWith('.js'))
					.reduce((total, resource) => total + resource.encodedBytes, 0),
				externalCssRawBytes: cssBytes,
				assetCssRawBytes: cssBytes + (rest.inlineStylesheetBytes ?? 0),
				allObservedCssRawBytes: cssBytes + (rest.inlineStyleBytes ?? 0),
			},
			steps: row.steps.map(({ resources: _resources, ...step }) => step),
		}
	})
	write(kind + '-runs.json', {
		...data,
		note: 'Identical initial resource inventories are shared by hash. Repeated cumulative step resource arrays are omitted, all per-sample metrics, step requests, errors and failures remain. Full raw arrays remain in the archive.',
		resourceInventories,
		runs: rows,
	})
	navigation[kind] = []
	initial[kind] = []
	for (const target of config.targets) {
		for (const latencyMs of config.latencyMs ?? [0, 100]) {
			const all = rows.filter(
				(row) => row.label === target.label && row.latencyMs === latencyMs,
			)
			const valid = all.filter((row) => row.initial)
			const first = valid[0]
			for (let index = 0; index < (first?.steps.length ?? 0); index++)
				navigation[kind].push({
					label: target.label,
					latencyMs,
					step: index + 1,
					path: first.steps[index].path,
					...stats(valid.map((row) => row.steps[index]?.elapsedMs)),
				})
			initial[kind].push({
				label: target.label,
				latencyMs,
				attempts: all.length,
				metrics: Object.fromEntries(
					[
						'jsEncodedBytes',
						'assetCssRawBytes',
						'allObservedCssRawBytes',
						'inlineStyleBytes',
						'hydratedMs',
						'observedFcpMs',
						'observedLcpMs',
					].map((key) => [key, stats(valid.map((row) => row.initial[key]))]),
				),
				document: Object.fromEntries(
					['encodedBytes', 'decodedBytes', 'transferBytes'].map((key) => [
						key,
						stats(valid.map((row) => row.initial.document?.[0]?.[key])),
					]),
				),
				pageErrors: all.reduce(
					(sum, row) => sum + (row.errors?.length ?? 0),
					0,
				),
				consoleErrors: all.reduce(
					(sum, row) => sum + (row.consoleErrorCount ?? 0),
					0,
				),
				failedRequests: all.reduce(
					(sum, row) => sum + (row.failedRequests?.length ?? 0),
					0,
				),
			})
		}
	}
}
write('navigation-summary.json', navigation)
write('initial-summary.json', initial)
const attribution = load(attributionFile)
write('attribution-summary.json', {
	note:
		attribution.note +
		' This summary retains the largest 40 sources per revision, the full raw attribution remains in the archive.',
	results: attribution.results.map((result) => ({
		label: result.label,
		commit: result.commit,
		jsRawBytes: result.assets.reduce((sum, asset) => sum + asset.bytes, 0),
		mappedBytes: result.assets.reduce(
			(sum, asset) => sum + asset.mappedBytes,
			0,
		),
		topSources: result.sources.slice(0, 40),
	})),
})
