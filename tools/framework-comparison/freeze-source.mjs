#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [sourceArg, destinationArg] = process.argv.slice(2)
if (!sourceArg || !destinationArg)
	throw new Error(
		'Usage: freeze-source.mjs SOURCE_REPOSITORY NEW_SNAPSHOT_DIRECTORY',
	)
const source = resolve(sourceArg)
const destination = resolve(destinationArg)
if (existsSync(destination)) throw new Error('Snapshot directory must be new')
const paths = [
	...new Set(
		execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
			cwd: source,
			encoding: 'utf8',
		})
			.split('\0')
			.filter(Boolean),
	),
]
	.filter(
		(path) =>
			existsSync(join(source, path)) &&
			!path.startsWith('tools/framework-comparison/reports/') &&
			!path.split('/').includes('node_modules') &&
			!/(^|\/)\.env($|\.)/.test(path),
	)
	.sort()
mkdirSync(destination, { recursive: true })
const files = paths.map((path) => {
	const content = readFileSync(join(source, path))
	const target = join(destination, path)
	mkdirSync(dirname(target), { recursive: true })
	copyFileSync(join(source, path), target)
	return { path, sha256: createHash('sha256').update(content).digest('hex') }
})
const manifest = {
	createdAt: new Date().toISOString(),
	gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: source,
		encoding: 'utf8',
	}).trim(),
	files,
}
const text = JSON.stringify(manifest, null, 2) + '\n'
writeFileSync(join(destination, 'snapshot-manifest.json'), text)
console.log(
	JSON.stringify({
		destination,
		files: files.length,
		manifestSha256: createHash('sha256').update(text).digest('hex'),
		note: 'Dependencies and private local environment are deliberately not copied by this source-only tool.',
	}),
)
