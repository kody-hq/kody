import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	productionOriginScriptName,
	stripOriginDurableObjectMigrations,
} from './ci/origin-production-deploy-state.ts'
import { parseJsonc } from './ci/resource-utils.ts'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'
import {
	isOriginWorkerConfigPath,
	omitConfigFlag,
	readConfigFlag,
	readNameFlag,
} from './origin-worker-config.ts'
import { runWranglerDeployWithRetry } from './wrangler-deploy-retry.ts'

function run(
	command: string,
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv,
) {
	const result = spawnSync(command, [...args], {
		stdio: 'inherit',
		env,
	})
	const status = result.status ?? 1
	if (status !== 0) process.exit(status)
}

function resolveWranglerCommand() {
	const localWranglerPath = path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
	)
	return existsSync(localWranglerPath)
		? localWranglerPath
		: resolveLocalBinary('wrangler')
}

export const originViteWranglerConfigPath = 'dist/server/wrangler.json'

export function inferOriginDeployCloudflareEnv(configPath: string | undefined) {
	const fileName =
		(configPath ?? '').replaceAll('\\', '/').split('/').pop() ?? ''
	if (fileName.includes('preview')) return 'preview'
	if (fileName.includes('production')) return 'production'
	return undefined
}

export function inferOriginDeployWorkerName(input: {
	cloudflareEnv: string | undefined
	existingName?: string
}) {
	if (input.existingName) return input.existingName
	if (input.cloudflareEnv === 'production') return productionOriginScriptName
	return undefined
}

export function isSlimOriginEntry(main: unknown) {
	if (typeof main !== 'string') return false
	return main.replaceAll('\\', '/').split('/').pop() === 'production-worker.ts'
}

export function finalizeOriginViteWranglerConfig(
	config: Record<string, unknown>,
	input: { stripMigrations: boolean; envName: string },
) {
	if (input.stripMigrations) {
		stripOriginDurableObjectMigrations(config, input.envName)
	}
	return config
}

export function originViteDeployArgs(
	args: ReadonlyArray<string>,
	workerName?: string,
) {
	const next = [
		'deploy',
		'--config',
		originViteWranglerConfigPath,
		...omitConfigFlag(args),
	]
	if (workerName && !readNameFlag(args)) {
		next.push('--name', workerName)
	}
	return next
}

export async function deploy(args: ReadonlyArray<string>) {
	const configPath = readConfigFlag(args)
	if (!isOriginWorkerConfigPath(configPath)) {
		run(process.execPath, ['wrangler-env.ts', 'deploy', ...args], process.env)
		return
	}

	const wranglerConfigPath = configPath ?? 'packages/worker/wrangler.jsonc'
	const cloudflareEnv =
		process.env.CLOUDFLARE_ENV ??
		inferOriginDeployCloudflareEnv(wranglerConfigPath)
	const inputConfig = parseJsonc<Record<string, unknown>>(
		readFileSync(wranglerConfigPath, 'utf8'),
	)
	const workerName = inferOriginDeployWorkerName({
		cloudflareEnv,
		existingName: readNameFlag(args),
	})
	run(resolveLocalBinary('vite'), ['build'], {
		...process.env,
		KODY_WRANGLER_CONFIG: wranglerConfigPath,
		...(cloudflareEnv ? { CLOUDFLARE_ENV: cloudflareEnv } : {}),
	})
	run(
		process.execPath,
		['tools/framework-comparison/verify-redact-build.mjs', 'dist'],
		process.env,
	)
	if (!existsSync(originViteWranglerConfigPath)) {
		console.error(
			`Origin Vite build did not emit ${originViteWranglerConfigPath}; cannot deploy.`,
		)
		process.exit(1)
	}
	const emittedConfig = parseJsonc<Record<string, unknown>>(
		readFileSync(originViteWranglerConfigPath, 'utf8'),
	)
	finalizeOriginViteWranglerConfig(emittedConfig, {
		stripMigrations: isSlimOriginEntry(inputConfig.main),
		envName: cloudflareEnv ?? 'production',
	})
	writeFileSync(
		originViteWranglerConfigPath,
		`${JSON.stringify(emittedConfig, null, '\t')}\n`,
	)
	const result = await runWranglerDeployWithRetry({
		command: resolveWranglerCommand(),
		args: originViteDeployArgs(args, workerName),
		env: {
			...process.env,
			...(cloudflareEnv ? { CLOUDFLARE_ENV: cloudflareEnv } : {}),
		},
	})
	if (result.status !== 0) process.exitCode = result.status
}

if (isExecutedDirectly(import.meta.url)) {
	void deploy(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	})
}
