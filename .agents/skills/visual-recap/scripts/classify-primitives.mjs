#!/usr/bin/env node
/**
 * Classify changed paths against the primitives taxonomy.
 *
 * Usage:
 *   node classify-primitives.mjs [--base <ref>] [--head <ref>]
 *   git diff --name-only main...HEAD | node classify-primitives.mjs --stdin
 *
 * Defaults: base=main, head=HEAD (git diff --name-only base...head).
 */
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { classifyPaths, loadPrimitivesMap } from './primitives-map.mjs'

const args = process.argv.slice(2)

function readFlag(name, fallback) {
	const index = args.indexOf(name)
	if (index === -1) return fallback
	const value = args[index + 1]
	if (!value || value.startsWith('--')) {
		console.error(`missing value for ${name}`)
		process.exit(1)
	}
	return value
}

async function readStdinPaths() {
	const paths = []
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
	for await (const line of rl) {
		const trimmed = line.trim()
		if (trimmed) paths.push(trimmed)
	}
	return paths
}

function readGitPaths(base, head) {
	const output = execFileSync(
		'git',
		['diff', '--name-only', `${base}...${head}`],
		{ encoding: 'utf8' },
	)
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
}

const useStdin = args.includes('--stdin')
const jsonOut = args.includes('--json')
const base = readFlag('--base', 'main')
const head = readFlag('--head', 'HEAD')

const paths = useStdin ? await readStdinPaths() : readGitPaths(base, head)
const map = loadPrimitivesMap()
const { matched, unmatched } = classifyPaths(paths, map)

if (jsonOut) {
	console.log(
		JSON.stringify(
			{
				base: useStdin ? null : base,
				head: useStdin ? null : head,
				pathCount: paths.length,
				matched: matched.map((entry) => ({
					id: entry.primitive.id,
					name: entry.primitive.name,
					group: entry.primitive.group ?? null,
					root: entry.root,
					adrs: entry.primitive.adrs ?? [],
					files: entry.files,
				})),
				unmatched,
			},
			null,
			2,
		),
	)
	process.exit(0)
}

if (paths.length === 0) {
	console.log('No changed paths.')
	process.exit(0)
}

console.log(
	useStdin
		? `Classified ${paths.length} path(s) from stdin:\n`
		: `Classified ${paths.length} path(s) from ${base}...${head}:\n`,
)

for (const entry of matched) {
	console.log(
		`- ${entry.primitive.id} (${entry.primitive.group ?? 'ungrouped'}) via ${entry.root}`,
	)
	for (const adr of entry.primitive.adrs ?? []) {
		console.log(`    adr: ${adr}`)
	}
	for (const file of entry.files.slice(0, 8)) {
		console.log(`    ${file}`)
	}
	if (entry.files.length > 8) {
		console.log(`    … +${entry.files.length - 8} more`)
	}
}

if (unmatched.length > 0) {
	console.log(`\nUnmatched (${unmatched.length}):`)
	for (const file of unmatched.slice(0, 20)) {
		console.log(`  ${file}`)
	}
	if (unmatched.length > 20) {
		console.log(`  … +${unmatched.length - 20} more`)
	}
}
