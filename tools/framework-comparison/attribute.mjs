#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const [configFile, outputFile] = process.argv.slice(2)
if (!configFile || !outputFile)
	throw new Error('Usage: attribute.mjs TARGETS_JSON OUTPUT_JSON')
const alphabet =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function decode(segment) {
	const values = []
	let value = 0,
		shift = 0
	for (const char of segment) {
		const digit = alphabet.indexOf(char)
		if (digit < 0) throw new Error('Invalid source map')
		value += (digit & 31) * 2 ** shift
		if (digit & 32) shift += 5
		else {
			values.push(value & 1 ? -(value >> 1) : value >> 1)
			value = 0
			shift = 0
		}
	}
	return values
}
function owner(source) {
	const normalized = '/' + source.replaceAll('\\', '/')
	const npm = normalized.split('/node_modules/').at(-1)
	if (npm !== normalized)
		return npm.startsWith('@')
			? npm.split('/').slice(0, 2).join('/')
			: npm.split('/')[0]
	const index = source.indexOf('packages/')
	return index < 0 ? source : source.slice(index)
}
function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? walk(join(directory, entry.name))
			: [join(directory, entry.name)],
	)
}
const targets = JSON.parse(readFileSync(configFile, 'utf8'))
const results = targets.map((target) => {
	const totals = new Map(),
		assets = []
	for (const file of walk(join(target.root, 'dist/client')).filter((file) =>
		file.endsWith('.js'),
	)) {
		const code = readFileSync(file, 'utf8'),
			bytes = Buffer.byteLength(code)
		let map
		try {
			map = JSON.parse(readFileSync(file + '.map', 'utf8'))
		} catch {
			assets.push({ path: relative(target.root, file), bytes, mappedBytes: 0 })
			continue
		}
		const lines = code.split('\n')
		let source = 0,
			mappedBytes = 0
		for (const [lineIndex, mappings] of map.mappings.split(';').entries()) {
			const line = lines[lineIndex] ?? ''
			let column = 0
			const segments = mappings
				? mappings.split(',').map((encoded) => {
						const values = decode(encoded)
						column += values[0]
						if (values.length >= 4) source += values[1]
						return { column, source: values.length >= 4 ? source : null }
					})
				: []
			for (let index = 0; index < segments.length; index++) {
				const segment = segments[index]
				if (segment.source === null) continue
				const size = Buffer.byteLength(
					line.slice(
						segment.column,
						segments[index + 1]?.column ?? line.length,
					),
				)
				const name = owner(map.sources[segment.source])
				totals.set(name, (totals.get(name) ?? 0) + size)
				mappedBytes += size
			}
		}
		assets.push({ path: relative(target.root, file), bytes, mappedBytes })
	}
	return {
		label: target.label,
		commit: target.commit,
		assets,
		sources: [...totals]
			.map(([source, bytes]) => ({ source, bytes }))
			.sort((a, b) => b.bytes - a.bytes),
	}
})
writeFileSync(
	outputFile,
	JSON.stringify(
		{
			note: 'Generated UTF-8 JS spans attributed with source-map segments. Raw emitted bytes, not original source size or gzip attribution. Unmapped bytes remain explicit per asset. Shared modules can occur in multiple emitted assets.',
			results,
		},
		null,
		2,
	) + '\n',
)
