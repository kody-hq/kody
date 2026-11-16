import type {
	PackageCodemod,
	PackageCodemodContext,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'
import { locatePackage } from './0013-declare-credential-needs.ts'
import { readPackageAppManifest } from './0017-detect-package-app-visitor-authority.ts'

export const detectPackageAppHostMigrationCodemodId =
	'0019-detect-package-app-host-migration'

export const packageAppHostMigrationPatterns = [
	'old app url',
	'hardcoded mount path',
	'build-time base',
	'list-unsubscribe',
	'oauth form_post',
	'oauth redirect uri',
	'webhook receiver',
	'localStorage',
	'sessionStorage',
	'indexedDB',
	'cache storage',
	'service worker',
	'cookie path',
	'cookie domain',
	'origin check',
	'web app manifest',
] as const

export type PackageAppHostMigrationPattern =
	(typeof packageAppHostMigrationPatterns)[number]

/**
 * Fixed messages only: findings reach the fleet operator, so they never carry
 * a package name, handle, matched text, or file contents.
 */
export const packageAppHostMigrationPatternMessages: Record<
	PackageAppHostMigrationPattern,
	string
> = {
	'old app url':
		'old app url: contains an absolute https://{user}.kody.run/{leaf} or /packages/{leaf} URL for this app. The app is moving to https://{leaf}--{user}.kody.run/.',
	'hardcoded mount path':
		'hardcoded mount path: a string starts with this app’s /{leaf} mount path. The new host mounts the app at /, so read the base from packageContext.appBasePath instead.',
	'build-time base':
		'build-time base: a build config, base, or router basename is set to this app’s /{leaf} mount path. A baked base cannot be right on both hosts; read it at run time.',
	'list-unsubscribe':
		'list-unsubscribe: sets a List-Unsubscribe header. One-click unsubscribe POSTs in mail already sent keep the old address, which only redirects after cutover.',
	'oauth form_post':
		'oauth form_post: uses the form_post response mode. The provider POSTs to the registered redirect URI, so the owner must register the new address with the provider.',
	'oauth redirect uri':
		'oauth redirect uri: builds or names an OAuth redirect URI. If it is registered with an outside provider on the old address, the owner must register the new one.',
	'webhook receiver':
		'webhook receiver: appears to receive webhooks on one of the app’s own routes. Senders registered with the old address must be updated by the owner.',
	localStorage:
		'localStorage: uses localStorage. Data saved under the old origin does not move to the new host.',
	sessionStorage:
		'sessionStorage: uses sessionStorage. Data saved under the old origin does not move to the new host.',
	indexedDB:
		'indexedDB: uses IndexedDB. Databases saved under the old origin do not move to the new host.',
	'cache storage':
		'cache storage: uses Cache Storage. Caches saved under the old origin do not move to the new host.',
	'service worker':
		'service worker: registers a service worker. Its registration and scope belong to the old origin and path.',
	'cookie path':
		'cookie path: sets a cookie Path to this app’s /{leaf} mount path. The new host mounts the app at /, so the Path must follow the base.',
	'cookie domain':
		'cookie domain: sets a cookie Domain attribute. Package app cookies are host-only, and the host changes.',
	'origin check':
		'origin check: compares or allowlists an origin or hostname and names a kody.run host. The old origin stops matching on the new host.',
	'web app manifest':
		'web app manifest: declares a start_url or scope, or registers a service worker with a scope. Installed apps and offline caches are tied to the old address.',
}

export function packageAppHostMigrationPatternFromMessage(
	message: string,
): PackageAppHostMigrationPattern | null {
	for (const pattern of packageAppHostMigrationPatterns) {
		if (packageAppHostMigrationPatternMessages[pattern] === message) {
			return pattern
		}
	}
	return null
}

const textFilePattern =
	/\.(?:[cm]?[jt]s|[jt]sx|json|jsonc|md|mdx|txt|html|css|ya?ml|toml|vue|svelte|astro|webmanifest)$/
const codeFilePattern =
	/\.(?:[cm]?[jt]s|[jt]sx|html|vue|svelte|astro|json|webmanifest)$/
const testFilePattern =
	/(?:^|\/)(?:tests?|__tests__|__mocks__|e2e|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const ignoredFilePattern =
	/(?:^|\/)node_modules\/|(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/
const buildConfigFilePattern =
	/(?:^|\/)(?:vite|vitest|astro|next|nuxt|svelte|webpack|rollup|rsbuild|rspack|remix|react-router|parcel|esbuild)\.config\.[cm]?[jt]s$/
const manifestFilePattern = /(?:\.webmanifest|(?:^|\/)manifest\.json)$/
const packageLeafPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const handlePattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/

type Identity = { owner: string; leaf: string }

function readIdentity(context: PackageCodemodContext): Identity | null {
	const match = /^@([^/]+)\/([^/]+)$/.exec(context.packageName)
	if (!match) return null
	const [, owner, leaf] = match
	if (!owner || !leaf) return null
	if (!handlePattern.test(owner) || !packageLeafPattern.test(leaf)) return null
	return { owner, leaf }
}

type Matchers = Array<{
	pattern: PackageAppHostMigrationPattern
	test: (path: string, source: string) => boolean
}>

const quote = '["\'`]'
const leafEnd = '(?![a-z0-9-])'

function buildMatchers({ owner, leaf }: Identity): Matchers {
	const oldUrl = new RegExp(
		`(?<![a-z0-9.-])${owner}\\.kody\\.run/(?:packages/)?${leaf}${leafEnd}`,
		'i',
	)
	const mountLiteral = new RegExp(`${quote}/${leaf}${leafEnd}`)
	const baseAssignment = new RegExp(
		`\\b(?:base|basename|basepath|basePath|baseUrl|publicPath|assetPrefix)\\s*[:=]\\s*${quote}/${leaf}${leafEnd}`,
	)
	const baseAssignmentAll = new RegExp(baseAssignment.source, 'g')
	const cookiePath = new RegExp(
		`\\bpath\\s*(?:=|:\\s*${quote})\\s*/${leaf}${leafEnd}`,
		'i',
	)
	const isCode = (path: string) => codeFilePattern.test(path)
	const isScript = (path: string) =>
		isCode(path) && !/\.(?:json|webmanifest)$/.test(path)
	const isBuildConfig = (path: string) => buildConfigFilePattern.test(path)
	const isManifest = (path: string) => manifestFilePattern.test(path)
	return [
		{ pattern: 'old app url', test: (_path, source) => oldUrl.test(source) },
		{
			pattern: 'hardcoded mount path',
			test: (path, source) =>
				isScript(path) &&
				!isBuildConfig(path) &&
				mountLiteral.test(source.replace(baseAssignmentAll, '')),
		},
		{
			pattern: 'build-time base',
			test: (path, source) =>
				isScript(path) &&
				(baseAssignment.test(source) ||
					(isBuildConfig(path) && mountLiteral.test(source))),
		},
		{
			pattern: 'list-unsubscribe',
			test: (path, source) =>
				isScript(path) && /list-unsubscribe/i.test(source),
		},
		{
			pattern: 'oauth form_post',
			test: (path, source) => isScript(path) && /\bform_post\b/.test(source),
		},
		{
			pattern: 'oauth redirect uri',
			test: (path, source) =>
				isScript(path) && /\bredirect_uris?\b|\bredirectUris?\b/.test(source),
		},
		{
			pattern: 'webhook receiver',
			test: (path, source) =>
				isScript(path) &&
				(new RegExp(`${quote}/[^"'\`\\s]*webhook`, 'i').test(source) ||
					/stripe-signature|x-hub-signature|x-github-event|svix-signature|x-twilio-signature|x-slack-signature|x-shopify-hmac/i.test(
						source,
					)),
		},
		{
			pattern: 'localStorage',
			test: (path, source) => isScript(path) && /\blocalStorage\b/.test(source),
		},
		{
			pattern: 'sessionStorage',
			test: (path, source) =>
				isScript(path) && /\bsessionStorage\b/.test(source),
		},
		{
			pattern: 'indexedDB',
			test: (path, source) => isScript(path) && /\bindexedDB\b/.test(source),
		},
		{
			pattern: 'cache storage',
			test: (path, source) =>
				isScript(path) &&
				/\bcaches\s*\.\s*(?:open|match|keys|delete|has)\b/.test(source),
		},
		{
			pattern: 'service worker',
			test: (path, source) =>
				isScript(path) &&
				/\bserviceWorker\b[\s\S]{0,40}\bregister\b/.test(source),
		},
		{
			pattern: 'cookie path',
			test: (path, source) =>
				isScript(path) && /cookie/i.test(source) && cookiePath.test(source),
		},
		{
			pattern: 'cookie domain',
			test: (path, source) =>
				isScript(path) &&
				/cookie/i.test(source) &&
				(/;\s*domain\s*=/i.test(source) ||
					new RegExp(`\\bdomain\\s*:\\s*(?:${quote}|[A-Za-z_$])`).test(source)),
		},
		{
			pattern: 'origin check',
			test: (path, source) =>
				isScript(path) &&
				/\.kody\.run\b/i.test(source) &&
				/\blocation\s*\.\s*(?:origin|host|hostname)\b|\.get\(\s*["'`]origin["'`]\s*\)|access-control-allow-origin|\ballowedOrigins?\b|\bevent\.origin\b|\.hostname\b/i.test(
					source,
				),
		},
		{
			pattern: 'web app manifest',
			test: (path, source) =>
				(isManifest(path) && /"(?:start_url|scope)"\s*:/.test(source)) ||
				(isScript(path) &&
					(/\bstart_url\b/.test(source) ||
						/\bserviceWorker\b[\s\S]{0,40}\bregister\s*\([^)]*\bscope\b/.test(
							source,
						))),
		},
	]
}

function detectPackageAppHostMigration(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const located = locatePackage(files, context)
	const ownFiles = located.files
	const manifestSource = Object.hasOwn(ownFiles, located.manifestKey)
		? ownFiles[located.manifestKey]
		: undefined
	if (!readPackageAppManifest(manifestSource)) return []
	const identity = readIdentity(context)
	if (!identity) return []
	const matchers = buildMatchers(identity)
	const findings: Array<PackageCodemodFinding> = []
	const paths = Object.keys(ownFiles).sort((left, right) =>
		left.localeCompare(right),
	)
	for (const path of paths) {
		const source = ownFiles[path]
		if (typeof source !== 'string') continue
		if (!textFilePattern.test(path)) continue
		if (ignoredFilePattern.test(path) || testFilePattern.test(path)) continue
		for (const { pattern, test } of matchers) {
			if (test(path, source)) {
				findings.push({
					path,
					message: packageAppHostMigrationPatternMessages[pattern],
				})
			}
		}
	}
	return findings
}

function transformPackageAppHostMigration(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	return {
		files,
		changed: false,
		changedPaths: [],
		needsManual: detectPackageAppHostMigration(files, context),
	}
}

/**
 * Scan-only inventory for the move from `https://{user}.kody.run/{leaf}` to
 * `https://{leaf}--{user}.kody.run`: reports what in an app's published source
 * is tied to the old origin or mount path. Never rewrites.
 */
export const detectPackageAppHostMigrationCodemod: PackageCodemod = {
	id: detectPackageAppHostMigrationCodemodId,
	description:
		'Scan only: inventory package app source tied to the {user}.kody.run/{leaf} address (old URLs, hardcoded mount paths, build-time bases, external callbacks, browser storage, cookie scope, origin checks, PWA scope) before the move to {leaf}--{user}.kody.run.',
	// The published tree is what the app serves, so drifted apps are scanned too.
	applyMode: 'published-only',
	detect: detectPackageAppHostMigration,
	transform: transformPackageAppHostMigration,
}
