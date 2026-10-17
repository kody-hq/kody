#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'dist')

function sources(directory) {
	const result = new Set()
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name)
		if (entry.isDirectory()) {
			for (const source of sources(file)) result.add(source)
		} else if (entry.name.endsWith('.map')) {
			for (const source of JSON.parse(readFileSync(file, 'utf8')).sources ?? [])
				result.add(source.replaceAll('\\', '/'))
		}
	}
	return result
}

for (const environment of ['client', 'server']) {
	const modules = [...sources(join(root, environment))]
	const redact = modules.filter((source) =>
		source.includes('/@tanstack/redact/'),
	)
	const upstream = modules.filter((source) =>
		/\/node_modules\/(?:react|react-dom|scheduler)\//.test(source),
	)
	if (redact.length === 0 || upstream.length > 0) {
		throw new Error(
			`${environment}: expected Redact source maps without upstream React runtime modules; found ${redact.length} Redact entries and ${JSON.stringify(upstream)}`,
		)
	}
	const retiredWebsiteRuntime = modules.filter((source) =>
		/(?:^|\/)packages\/worker\/(?:src\/app\/(?:ssr-render|ssr-document)\.tsx|client\/(?:client-router|app-root|app)\.tsx)$/.test(
			source,
		),
	)
	if (retiredWebsiteRuntime.length > 0) {
		throw new Error(
			`${environment}: retired website rendering runtime remains in the build: ${JSON.stringify(retiredWebsiteRuntime)}`,
		)
	}
	if (environment === 'client') {
		const serverOnly = modules.filter(
			(source) =>
				/\/@resvg\/resvg-wasm\//.test(source) ||
				/(?:^|\/)packages\/worker\/(?:start\/server\/package-app-oauth-protocol|src\/app\/package-app-oauth-authorize)\.ts$/.test(
					source,
				),
		)
		if (serverOnly.length > 0)
			throw new Error(
				`client: server-only OAuth or image rasterization modules remain in the build: ${JSON.stringify(serverOnly)}`,
			)
	}
	console.log(
		`${environment}: ${redact.length} Redact source entries, no upstream React or retired website runtime entries`,
	)
}
