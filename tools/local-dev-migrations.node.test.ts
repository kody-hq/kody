import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { parseJsonc } from './ci/resource-utils.ts'
import { localizeMigrations } from './local-dev-migrations.ts'
import { writeLocalSiblingDevConfig } from './local-sibling-dev-config.ts'
import {
	writeRuntimeDryRunConfig,
	writeRuntimeStartupCheckConfig,
} from './local-runtime-dry-run-config.ts'

test('localizeMigrations turns transfers into sqlite creates and elides a later delete', () => {
	const localized = localizeMigrations([
		{
			tag: 'v1',
			transferred_classes: [
				{
					from: 'StorageRunner',
					from_script: 'kody',
					to: 'StorageRunner',
				},
				{
					from: 'PackageServiceInstance',
					from_script: 'kody',
					to: 'PackageServiceInstance',
				},
			],
		},
		{
			tag: 'v2',
			deleted_classes: ['PackageServiceInstance'],
		},
	])

	expect(localized).toEqual([
		{
			tag: 'v1',
			new_sqlite_classes: ['StorageRunner'],
		},
	])
	// The localized chain must pass wrangler’s local deleted_classes check.
	expect(sqliteMapAccepts(localized)).toBe(true)
})

test('the committed runtime production chain passes wrangler’s local sqlite map', async () => {
	const source = parseJsonc<{ migrations?: unknown }>(
		await readFile('packages/runtime-worker/wrangler.jsonc', 'utf8'),
	)
	expect(sqliteMapAccepts(source.migrations)).toBe(true)
	expect(sqliteMapAccepts(localizeMigrations(source.migrations))).toBe(true)
})

async function runtimeConfigCopy(prefix: string) {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix))
	const sourcePath = path.join(tempDir, 'wrangler.jsonc')
	await writeFile(
		sourcePath,
		await readFile('packages/runtime-worker/wrangler.jsonc', 'utf8'),
	)
	return {
		tempDir,
		sourcePath,
		[Symbol.asyncDispose]: () => rm(tempDir, { recursive: true, force: true }),
	}
}

async function readGenerated<T>(outputPath: string) {
	return parseJsonc<T>(await readFile(outputPath, 'utf8'))
}

test('writeRuntimeDryRunConfig localizes migrations without local-dev vars', async () => {
	await using copy = await runtimeConfigCopy('kody-runtime-dry-run-')
	const generated = await readGenerated<{
		migrations?: unknown
		env?: {
			production?: { migrations?: unknown; vars?: Record<string, unknown> }
			preview?: { migrations?: unknown }
		}
	}>(
		await writeRuntimeDryRunConfig({
			runtimeConfigPath: copy.sourcePath,
			envName: 'production',
		}),
	)
	expect(sqliteMapAccepts(generated.migrations)).toBe(true)
	expect(generated.migrations).toEqual(generated.env?.production?.migrations)
	expect(sqliteMapAccepts(generated.env?.preview?.migrations)).toBe(true)
	expect(JSON.stringify(generated)).not.toContain('PackageServiceInstance')
	expect(generated.env?.production?.vars?.WRANGLER_IS_LOCAL_DEV).toBe(undefined)
})

test('writeRuntimeStartupCheckConfig writes wrangler.jsonc with an absolute main', async () => {
	await using copy = await runtimeConfigCopy('kody-runtime-startup-')
	const snapshotDir = path.join(copy.tempDir, 'snapshot')
	await mkdir(snapshotDir, { recursive: true })
	const outputPath = await writeRuntimeStartupCheckConfig({
		runtimeConfigPath: copy.sourcePath,
		envName: 'production',
		outputDir: snapshotDir,
	})
	expect(path.basename(outputPath)).toBe('wrangler.jsonc')
	const generated = await readGenerated<{
		main?: string
		migrations?: unknown
	}>(outputPath)
	expect(path.isAbsolute(generated.main ?? '')).toBe(true)
	expect(sqliteMapAccepts(generated.migrations)).toBe(true)
	expect(JSON.stringify(generated.migrations)).not.toContain(
		'PackageServiceInstance',
	)
})

test('writeLocalSiblingDevConfig writes a top-level chain wrangler can apply', async () => {
	await using copy = await runtimeConfigCopy('kody-local-runtime-')
	const generated = await readGenerated<{
		migrations?: unknown
		env?: { production?: { migrations?: unknown } }
	}>(
		await writeLocalSiblingDevConfig({
			configPath: copy.sourcePath,
			envName: 'production',
			mainWorkerDevName: 'kody-production',
			port: '3742',
		}),
	)
	expect(sqliteMapAccepts(generated.migrations)).toBe(true)
	expect(generated.migrations).toEqual(generated.env?.production?.migrations)
	expect(JSON.stringify(generated.migrations)).not.toContain(
		'PackageServiceInstance',
	)
	expect(JSON.stringify(generated.migrations)).not.toContain(
		'transferred_classes',
	)
})

/**
 * Same order and rules as wrangler’s
 * `getDurableObjectClassNameToUseSQLiteMap` for deleted_classes /
 * new_sqlite_classes. transferred_classes are ignored.
 */
function sqliteMapAccepts(migrations: unknown) {
	if (!Array.isArray(migrations)) return false
	const present = new Set<string>()
	for (const migration of migrations) {
		if (!migration || typeof migration !== 'object') continue
		const record = migration as Record<string, unknown>
		if (Array.isArray(record.deleted_classes)) {
			for (const name of record.deleted_classes) {
				if (typeof name !== 'string' || !present.delete(name)) return false
			}
		}
		if (Array.isArray(record.new_sqlite_classes)) {
			for (const name of record.new_sqlite_classes) {
				if (typeof name !== 'string' || present.has(name)) return false
				present.add(name)
			}
		}
	}
	return true
}
