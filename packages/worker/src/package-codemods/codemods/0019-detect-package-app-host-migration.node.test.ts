import { expect, test } from 'vitest'
import {
	detectPackageAppHostMigrationCodemod,
	packageAppHostMigrationPatternFromMessage,
	packageAppHostMigrationPatternMessages,
} from './0019-detect-package-app-host-migration.ts'

const packageContext = { packageName: '@acme/notes' }

function manifest(
	kody: Record<string, unknown> = { app: { entry: './app.ts' } },
) {
	return JSON.stringify({
		name: '@acme/notes',
		kody: { description: 'Notes.', ...kody },
	})
}

async function scan(
	files: Record<string, string>,
	context = packageContext,
	manifestSource = manifest(),
) {
	const findings = await detectPackageAppHostMigrationCodemod.detect(
		{ 'package.json': manifestSource, ...files },
		context,
	)
	return findings.map(
		(finding) =>
			`${finding.path}: ${packageAppHostMigrationPatternFromMessage(finding.message)}`,
	)
}

test('0019 ignores packages that are not apps', async () => {
	expect(
		await scan(
			{ 'app.ts': 'localStorage.setItem("a", "b")' },
			packageContext,
			manifest({}),
		),
	).toEqual([])
})

test('0019 reports old absolute URLs for this app, including in docs', async () => {
	expect(
		await scan({
			'README.md': 'Open https://acme.kody.run/notes/ to start.',
			'app.ts': 'const legacy = "https://acme.kody.run/packages/notes/admin"',
			'other.ts':
				'const a = "https://acme.kody.run/notes-archive"; const b = "https://other.kody.run/notes"; const c = "https://notacme.kody.run/notes"; const d = "https://notes--acme.kody.run/notes"',
		}),
	).toEqual(['app.ts: old app url', 'README.md: old app url'])
})

test('0019 separates hardcoded mount paths from build-time bases', async () => {
	expect(
		await scan({
			'app.ts': 'const href = `/notes/admin`; const other = "/notes-archive"',
			'router.ts': 'createRouter({ basename: "/notes" })',
			'vite.config.ts': 'export default { base: "/notes/" }',
			'clean.ts':
				'const href = `${appBasePath}/admin`; const api = "/api/notes"',
		}),
	).toEqual([
		'app.ts: hardcoded mount path',
		'router.ts: build-time base',
		'vite.config.ts: build-time base',
	])
})

test('0019 reports addresses outside services may hold', async () => {
	expect(
		await scan({
			'mail.ts':
				'headers["List-Unsubscribe"] = url; headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"',
			'oauth.ts':
				'params.set("response_mode", "form_post"); params.set("redirect_uri", callback)',
			'hooks.ts':
				'if (url.pathname === "/hooks/stripe-webhook") verify(request.headers.get("stripe-signature"))',
		}),
	).toEqual([
		'hooks.ts: webhook receiver',
		'mail.ts: list-unsubscribe',
		'oauth.ts: oauth form_post',
		'oauth.ts: oauth redirect uri',
	])
})

test('0019 reports browser storage and PWA scope', async () => {
	expect(
		await scan({
			'client.ts': [
				'localStorage.setItem("draft", text)',
				'sessionStorage.getItem("tab")',
				'indexedDB.open("notes")',
				'await caches.open("v1")',
				'navigator.serviceWorker.register("/notes/sw.js", { scope: "/notes/" })',
			].join('\n'),
			'public/app.webmanifest': '{"start_url": "/notes/", "scope": "/notes/"}',
		}),
	).toEqual([
		'client.ts: hardcoded mount path',
		'client.ts: localStorage',
		'client.ts: sessionStorage',
		'client.ts: indexedDB',
		'client.ts: cache storage',
		'client.ts: service worker',
		'client.ts: web app manifest',
		'public/app.webmanifest: web app manifest',
	])
})

test('0019 reports cookie scope and origin checks', async () => {
	expect(
		await scan({
			'cookies.ts':
				'headers.append("Set-Cookie", `${name}=1; Path=/notes; Domain=acme.kody.run`)',
			'options.ts': 'setCookie(name, value, { path: "/", domain: host })',
			'cors.ts':
				'if (request.headers.get("Origin") !== "https://acme.kody.run") return deny()',
			'plain.ts': 'if (location.origin === expected) go()',
		}),
	).toEqual([
		'cookies.ts: cookie path',
		'cookies.ts: cookie domain',
		'cors.ts: origin check',
		'options.ts: cookie domain',
	])
})

test('0019 skips tests, node_modules, and lockfiles', async () => {
	expect(
		await scan({
			'app.test.ts': 'localStorage.clear()',
			'tests/helper.ts': 'const href = "/notes/admin"',
			'node_modules/x/index.js': 'indexedDB.open("x")',
			'package-lock.json': '{"resolved": "https://acme.kody.run/notes"}',
		}),
	).toEqual([])
})

test('0019 scans only the files of a nested package', async () => {
	const findings = await detectPackageAppHostMigrationCodemod.detect(
		{
			'apps/notes/package.json': manifest(),
			'apps/notes/app.ts': 'localStorage.getItem("a")',
			'apps/other/app.ts': 'indexedDB.open("other")',
			'package.json': '{"name":"root"}',
		},
		{
			...packageContext,
			manifestPath: 'apps/notes/package.json',
			sourceRoot: 'apps/notes',
		},
	)
	expect(findings).toEqual([
		{
			path: 'apps/notes/app.ts',
			message: packageAppHostMigrationPatternMessages.localStorage,
		},
	])
})

test('0019 never rewrites and never leaks source into findings', async () => {
	const files = {
		'package.json': manifest(),
		'app.ts': 'const secret = "https://acme.kody.run/notes?token=hunter2"',
	}
	const result = await detectPackageAppHostMigrationCodemod.transform(
		files,
		packageContext,
	)
	expect(result.files).toBe(files)
	expect(result.changed).toBe(false)
	expect(result.changedPaths).toEqual([])
	expect(result.needsManual).toEqual([
		{
			path: 'app.ts',
			message: packageAppHostMigrationPatternMessages['old app url'],
		},
	])
	const fixedMessages = new Set(
		Object.values(packageAppHostMigrationPatternMessages),
	)
	for (const finding of result.needsManual) {
		expect(fixedMessages.has(finding.message)).toBe(true)
		expect(finding.message).not.toMatch(/acme|notes|hunter2/)
	}
})

test('0019 scans the published tree so drifted apps are inventoried', () => {
	expect(detectPackageAppHostMigrationCodemod.applyMode).toBe('published-only')
})

test('0019 reports declared kody.webhooks so receiver matches can be told apart', async () => {
	const receiver = { 'hook.ts': 'request.headers.get("x-github-event")' }
	expect(
		await scan(
			receiver,
			packageContext,
			manifest({
				app: { entry: './app.ts' },
				webhooks: [{ name: 'github', export: './hook' }],
			}),
		),
	).toEqual([
		'package.json: declared kody webhook',
		'hook.ts: webhook receiver',
	])
	expect(await scan(receiver)).toEqual(['hook.ts: webhook receiver'])
	expect(
		await scan(
			receiver,
			packageContext,
			manifest({ app: { entry: './app.ts' }, webhooks: [] }),
		),
	).toEqual(['hook.ts: webhook receiver'])
})
