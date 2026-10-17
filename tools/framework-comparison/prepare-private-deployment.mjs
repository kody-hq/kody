#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'jsonc-parser'

// Local only. Provisioning and deployment commands are emitted, never executed.
const [manifestPath] = process.argv.slice(2)
if (!manifestPath)
	throw new Error('Usage: node prepare-private-deployment.mjs manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (!/^[a-f0-9]{32}$/.test(manifest.accountId))
	throw new Error('Expected explicit Cloudflare account ID')
if (!Array.isArray(manifest.fleets) || manifest.fleets.length !== 2)
	throw new Error('Supply baseline and candidate fleets')
const seenNames = new Set()
const plans = []
for (const fleet of manifest.fleets) {
	if (!['baseline', 'candidate'].includes(fleet.variant))
		throw new Error('Invalid variant')
	if (
		!/^kody-branch-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fleet.name) ||
		seenNames.has(fleet.name)
	)
		throw new Error('Use distinct kody-branch-* names')
	seenNames.add(fleet.name)
	const checkout = path.resolve(fleet.checkout)
	const allowedWorkers = new Set(
		[
			'',
			'-runtime',
			'-platform',
			'-jobs',
			'-highlight',
			'-api',
			'-mock-cloudflare',
		].map((suffix) => fleet.name + suffix),
	)
	const resources = fleet.resources ?? {}
	const kinds = {
		database_id: 'd1Ids',
		id: 'kvIds',
		bucket_name: 'buckets',
		queue: 'queues',
		dead_letter_queue: 'queues',
		index_name: 'vectorIndexes',
		dataset: 'datasets',
		namespace: 'artifactNamespaces',
		namespace_id: 'rateLimitIds',
	}
	function audit(value, location = '') {
		if (!value || typeof value !== 'object') return
		for (const [key, child] of Object.entries(value)) {
			const where = `${location}.${key}`
			if (
				['service', 'script_name', 'from_script'].includes(key) &&
				!allowedWorkers.has(child)
			)
				throw new Error(`Foreign worker reference at ${where}`)
			if (key === 'account_id' && child !== manifest.accountId)
				throw new Error(`Foreign account at ${where}`)
			if (key === 'routes' && Array.isArray(child) && child.length)
				throw new Error(`Custom routes prohibited at ${where}`)
			if (
				key in kinds &&
				typeof child === 'string' &&
				!(resources[kinds[key]] ?? []).includes(child)
			)
				throw new Error(`Unapproved ${kinds[key]} at ${where}`)
			if (key === 'CLOUDFLARE_ACCOUNT_ID' && child !== manifest.accountId)
				throw new Error(`Foreign account var at ${where}`)
			if (
				[
					'PACKAGE_APP_BASE_URL',
					'PACKAGE_APP_LEGACY_HOSTS',
					'APP_LEGACY_HOSTS',
				].includes(key) &&
				child
			)
				throw new Error(`External hostname prohibited at ${where}`)
			audit(child, where)
		}
	}
	const prepared = []
	for (const input of fleet.configs ?? []) {
		if (!allowedWorkers.has(input.worker))
			throw new Error('Config worker not in fleet')
		const source = path.resolve(checkout, input.path)
		const config = parse(await readFile(source, 'utf8'))
		// Remove inactive environments so their production IDs cannot be selected.
		if (config.env) {
			if (!config.env.preview)
				throw new Error(`Missing preview environment: ${source}`)
			config.env = { preview: config.env.preview }
		}
		const scopes = [config, ...(config.env ? [config.env.preview] : [])]
		for (const scope of scopes) {
			scope.account_id = manifest.accountId
			scope.name = input.worker
			scope.workers_dev = Boolean(
				manifest.privacyReady && input.worker === fleet.name,
			)
			scope.preview_urls = false
			if (scope.vars) {
				scope.vars.CLOUDFLARE_ACCOUNT_ID = manifest.accountId
				if (scope.vars.APP_BASE_URL && scope.vars.APP_BASE_URL !== fleet.origin)
					throw new Error('APP_BASE_URL does not match fleet origin')
			}
		}
		if (
			manifest.privacyReady &&
			!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(fleet.origin)
		)
			throw new Error('Expected protected workers.dev origin')
		audit(config)
		// Keep generated output beside input so relative main/assets paths remain valid.
		const output =
			source.replace(/\.(jsonc?|generated\.json)$/, '') +
			'.private.generated.json'
		if (output === source) throw new Error('Config must end in json or jsonc')
		await writeFile(output, `${JSON.stringify(config, null, '\t')}\n`)
		prepared.push({ worker: input.worker, config: output })
	}
	const originConfig = 'packages/worker/wrangler-preview.generated.json'
	plans.push({
		variant: fleet.variant,
		checkout,
		name: fleet.name,
		prepared,
		env: {
			CLOUDFLARE_ACCOUNT_ID: manifest.accountId,
			CLOUDFLARE_ENV: 'preview',
			NODE_ENV: 'production',
			KODY_WRANGLER_CONFIG: originConfig,
		},
		provision: [
			[
				'node',
				'tools/ci/preview-resources.ts',
				'ensure',
				'--worker-name',
				fleet.name,
				'--out-config',
				originConfig,
			],
			[
				'node',
				'tools/ci/jobs-worker-resources.ts',
				'ensure',
				'--env',
				'preview',
				'--worker-name',
				`${fleet.name}-jobs`,
				'--host-worker-name',
				fleet.name,
				'--out-config',
				'packages/jobs-worker/wrangler-preview.generated.json',
			],
		],
		build: ['npm', 'run', 'build'],
		buildOutput: path.resolve(
			checkout,
			fleet.buildOutput ??
				(fleet.variant === 'candidate'
					? 'dist/server/wrangler.json'
					: 'dist/ssr/wrangler.json'),
		),
	})
}
if (new Set(plans.map((plan) => plan.variant)).size !== 2)
	throw new Error('Supply one baseline and one candidate')
const output = path.resolve(
	manifest.outputDirectory ?? path.dirname(path.resolve(manifestPath)),
)
await mkdir(output, { recursive: true })
await writeFile(
	path.join(output, 'private-deployment-plan.json'),
	`${JSON.stringify({ privacyReady: Boolean(manifest.privacyReady), plans }, null, '\t')}\n`,
)
console.log('Prepared local configs and plan. No remote commands executed.')
