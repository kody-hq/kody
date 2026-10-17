#!/usr/bin/env node
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	copyFileSync,
	chmodSync,
} from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [rootArg, artifactConfigArg, label, port] = process.argv.slice(2)
if (
	!rootArg ||
	!artifactConfigArg ||
	!/^[a-z0-9-]+$/.test(label ?? '') ||
	!/^\d+$/.test(port ?? '')
)
	throw new Error(
		'Usage: node prepare-local-production.mjs ROOT BUILT_WRANGLER_CONFIG LABEL PORT',
	)
const root = resolve(rootArg)
const { writeLocalAuxiliaryDevConfig } = await import(
	pathToFileURL(join(root, 'tools/local-auxiliary-dev-config.ts')).href
)
process.chdir(root)
const directory = join(root, '.tmp', `production-measurement-${label}`)
mkdirSync(directory, { recursive: true })
const originPath = resolve(root, artifactConfigArg)
const origin = JSON.parse(readFileSync(originPath, 'utf8'))
const origins = [{ config: origin, source: originPath, role: 'origin' }]
for (const role of ['jobs', 'highlight']) {
	const path = await writeLocalAuxiliaryDevConfig({
		configPath: `packages/${role}-worker/wrangler.jsonc`,
		envName: 'test',
		mainWorkerDevName: origin.name,
	})
	const raw = JSON.parse(readFileSync(path, 'utf8'))
	const config = { ...raw, ...raw.env.test }
	config.name ??= `${raw.name}-test`
	if (!raw.env.test.name) config.name = `${raw.name}-test`
	delete config.env
	origins.push({ config, source: resolve(root, path), role })
}
const names = new Map(
	origins.map(({ config, role }) => [
		config.name,
		`kody-measure-${label}-${role}`,
	]),
)
const configs = []
for (const { config, source, role } of origins) {
	config.name = names.get(config.name)
	config.main = resolve(dirname(source), config.main)
	if (config.tsconfig)
		config.tsconfig = resolve(dirname(source), config.tsconfig)
	if (config.assets?.directory)
		config.assets.directory = resolve(dirname(source), config.assets.directory)
	for (const database of config.d1_databases ?? [])
		if (database.migrations_dir)
			database.migrations_dir = resolve(
				dirname(source),
				database.migrations_dir,
			)
	for (const binding of config.services ?? [])
		binding.service = names.get(binding.service) ?? binding.service
	for (const binding of config.durable_objects?.bindings ?? [])
		if (binding.script_name)
			binding.script_name =
				names.get(binding.script_name) ?? binding.script_name
	config.vars = {
		...config.vars,
		APP_BASE_URL: `http://127.0.0.1:${port}`,
		WRANGLER_IS_LOCAL_DEV: 'true',
	}
	delete config.build
	delete config.triggers
	const path = join(directory, `${role}.json`)
	writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
	configs.push(path)
}
copyFileSync(join(root, 'packages/worker/.env'), join(directory, '.dev.vars'))
chmodSync(join(directory, '.dev.vars'), 0o600)
writeFileSync(
	join(directory, 'run.json'),
	JSON.stringify(
		{
			root,
			port: Number(port),
			configs,
			persistTo: join(root, '.wrangler/state'),
			note: 'Built production origin plus real local jobs/highlight workers. Local-only, unique names prevent cross-preview binding collisions.',
		},
		null,
		2,
	) + '\n',
)
console.log(join(directory, 'run.json'))
