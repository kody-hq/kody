import { expect, test } from 'vitest'
import { productionOriginScriptName } from './ci/origin-production-deploy-state.ts'
import {
	finalizeOriginViteWranglerConfig,
	inferOriginDeployCloudflareEnv,
	inferOriginDeployWorkerName,
	isSlimOriginEntry,
	originViteDeployArgs,
	originViteWranglerConfigPath,
} from './deploy.ts'

test('origin Vite deploy always points Wrangler at the generated SSR config', () => {
	expect(originViteWranglerConfigPath).toBe('dist/server/wrangler.json')
	expect(
		originViteDeployArgs([
			'--config',
			'packages/worker/wrangler-production.generated.json',
			'--var',
			'APP_COMMIT_SHA:abc',
		]),
	).toEqual([
		'deploy',
		'--config',
		'dist/server/wrangler.json',
		'--var',
		'APP_COMMIT_SHA:abc',
	])
})

test('origin Vite deploy pins the production script name when callers omit --name', () => {
	expect(
		originViteDeployArgs(
			[
				'--config',
				'packages/worker/wrangler-production.generated.json',
				'--var',
				'APP_COMMIT_SHA:abc',
			],
			productionOriginScriptName,
		),
	).toEqual([
		'deploy',
		'--config',
		'dist/server/wrangler.json',
		'--var',
		'APP_COMMIT_SHA:abc',
		'--name',
		'kody-production',
	])
})

test('origin Vite deploy keeps an explicit --name (preview per-PR workers)', () => {
	expect(
		originViteDeployArgs(
			[
				'--name',
				'kody-pr-2055',
				'--config',
				'packages/worker/wrangler-preview.generated.json',
			],
			'kody-production',
		),
	).toEqual([
		'deploy',
		'--config',
		'dist/server/wrangler.json',
		'--name',
		'kody-pr-2055',
	])
})

test('infers CLOUDFLARE_ENV from generated origin config names', () => {
	expect(
		inferOriginDeployCloudflareEnv(
			'packages/worker/wrangler-production.generated.json',
		),
	).toBe('production')
	expect(
		inferOriginDeployCloudflareEnv(
			'packages/worker/wrangler-production-bootstrap.generated.json',
		),
	).toBe('production')
	expect(
		inferOriginDeployCloudflareEnv(
			'packages/worker/wrangler-preview.generated.json',
		),
	).toBe('preview')
	expect(
		inferOriginDeployCloudflareEnv('packages/worker/wrangler.jsonc'),
	).toBeUndefined()
})

test('infers the production origin script name and preserves explicit names', () => {
	expect(inferOriginDeployWorkerName({ cloudflareEnv: 'production' })).toBe(
		'kody-production',
	)
	expect(
		inferOriginDeployWorkerName({
			cloudflareEnv: 'production',
			existingName: 'kody-pr-9',
		}),
	).toBe('kody-pr-9')
	expect(
		inferOriginDeployWorkerName({ cloudflareEnv: 'preview' }),
	).toBeUndefined()
})

test('detects the slim origin entry used for Vite production/preview uploads', () => {
	expect(isSlimOriginEntry('./src/production-worker.ts')).toBe(true)
	expect(isSlimOriginEntry('src\\production-worker.ts')).toBe(true)
	expect(isSlimOriginEntry('./src/not-production-worker.ts')).toBe(false)
	expect(isSlimOriginEntry('./src/index.ts')).toBe(false)
	expect(isSlimOriginEntry(undefined)).toBe(false)
})

test('finalizeOriginViteWranglerConfig strips slim-entry Durable Object migrations', () => {
	const config: Record<string, unknown> = {
		name: 'kody',
		migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
		env: {
			production: {
				migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
			},
		},
	}
	expect(
		finalizeOriginViteWranglerConfig(config, {
			stripMigrations: true,
			envName: 'production',
		}),
	).toEqual({
		name: 'kody',
		env: { production: {} },
	})
	expect(
		finalizeOriginViteWranglerConfig(
			{
				name: 'kody',
				migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
			},
			{ stripMigrations: false, envName: 'production' },
		),
	).toEqual({
		name: 'kody',
		migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
	})
})
