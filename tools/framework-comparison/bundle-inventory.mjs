#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const [configPath, outputArg] = process.argv.slice(2)
if (!configPath || !outputArg)
	throw new Error(
		'Usage: bundle-inventory.mjs CONFIG_JSON NEW_OUTPUT_DIRECTORY',
	)
const targets = JSON.parse(readFileSync(configPath, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const walk = (directory) =>
	readdirSync(directory).flatMap((name) => {
		const file = join(directory, name)
		return statSync(file).isDirectory() ? walk(file) : [file]
	})
const inventories = targets.map((target) => {
	const assets = walk(join(target.root, target.dist))
		.filter((file) => /\.(js|css)$/.test(file))
		.map((file) => {
			const content = readFileSync(file)
			return {
				path: relative(join(target.root, target.dist), file),
				bytes: content.length,
				gzipBytes: gzipSync(content).length,
				sha256: createHash('sha256').update(content).digest('hex'),
			}
		})
		.sort((a, b) => a.path.localeCompare(b.path))
	const groups = Object.fromEntries(
		['client', 'server', 'ssr'].map((group) => {
			const files = assets.filter((asset) => asset.path.startsWith(group + '/'))
			return [
				group,
				{
					files: files.length,
					bytes: files.reduce((sum, asset) => sum + asset.bytes, 0),
					gzipBytes: files.reduce((sum, asset) => sum + asset.gzipBytes, 0),
				},
			]
		}),
	)
	return {
		...target,
		inventorySha256: createHash('sha256')
			.update(JSON.stringify(assets))
			.digest('hex'),
		groups,
		assets,
	}
})
writeFileSync(
	join(output, 'inventory.json'),
	JSON.stringify(
		{
			note: 'All emitted JS/CSS files, excluding source maps. Gzip uses Node zlib default compression per file. These totals are not initial-page transfer, preload traffic, deployment upload size or edge compression evidence.',
			nodeVersion: process.version,
			inventories,
		},
		null,
		2,
	) + '\n',
)
