import { parsePackageAppHostLabel } from '@kody-internal/shared/public-urls.ts'
import type {
	PackageCodemod,
	PackageCodemodContext,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'
import { locatePackage } from './0013-declare-credential-needs.ts'
import { readPackageAppManifest } from './0017-detect-package-app-visitor-authority.ts'

export const packageAppHostUrlsCodemodId = '0020-package-app-host-urls'

const rewriteMessage =
	'Names this app at its old address (https://{user}.kody.run/{leaf}); rewrite to https://{leaf}--{user}.kody.run.'

const manualOriginCheckMessage =
	'Names this app at its old address in a file that also compares origins or hostnames. A rewrite could break that check on the old address, so update the URL by hand.'

const manualOtherFormMessage =
	'Names this app at its old address in a form that is not rewritten (no https://, http://, or a path in another letter case). Update this mention by hand to {leaf}--{user}.kody.run.'

const textFilePattern =
	/\.(?:[cm]?[jt]s|[jt]sx|json|jsonc|md|mdx|txt|html|css|ya?ml|toml|vue|svelte|astro|webmanifest)$/
const ignoredFilePattern =
	/(?:^|\/)node_modules\/|(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/
// Broad on purpose: any file that talks about origins or hostnames may compare
// one against the URL, directly or through a variable.
const originCheckPattern =
	/origin|hostname|\blocation\s*\.\s*host\b|\.host\s*[!=]==?/i

type Target = {
	/** Full `https://` URLs of this app on the owner's host, either path form. */
	rewritable: RegExp
	/** Any mention of this app on the owner's host, with or without a scheme. */
	mention: RegExp
	host: string
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The app's own host, or null when the package has none to rewrite to: a
 * profile package (it keeps the owner's bare host) or a name with no valid
 * `{leaf}--{handle}` label.
 */
function readTarget(context: PackageCodemodContext): Target | null {
	const match = /^@([^/]+)\/([^/]+)$/.exec(context.packageName)
	if (!match) return null
	const [, owner, leaf] = match
	if (!owner || !leaf || owner === leaf) return null
	const label = `${leaf}--${owner}`
	const parsed = parsePackageAppHostLabel(label)
	if (!parsed || parsed.leaf !== leaf || parsed.handle !== owner) return null
	const oldHost = `${escapeRegExp(owner)}\\.kody\\.run`
	const oldPath = `/(?:packages/)?${escapeRegExp(leaf)}(?![A-Za-z0-9-])`
	return {
		// Scheme and host are case-insensitive; the path is not.
		rewritable: new RegExp(`(?:(?i:https://${oldHost}))${oldPath}`, 'g'),
		mention: new RegExp(`(?<![a-z0-9.-])${oldHost}${oldPath}`, 'i'),
		host: `https://${label}.kody.run`,
	}
}

function ownAppFiles(
	files: Record<string, string>,
	context: PackageCodemodContext,
) {
	const located = locatePackage(files, context)
	const manifestSource = Object.hasOwn(located.files, located.manifestKey)
		? located.files[located.manifestKey]
		: undefined
	if (!readPackageAppManifest(manifestSource)) return null
	return located
}

type FilePlan = {
	path: string
	rewritten: string | null
	manual: string | null
}

function planFile(path: string, source: string, target: Target): FilePlan {
	if (!target.mention.test(source)) {
		return { path, rewritten: null, manual: null }
	}
	if (originCheckPattern.test(source)) {
		return { path, rewritten: null, manual: manualOriginCheckMessage }
	}
	target.rewritable.lastIndex = 0
	const rewritten = source.replace(target.rewritable, target.host)
	return {
		path,
		rewritten: rewritten === source ? null : rewritten,
		manual: target.mention.test(rewritten) ? manualOtherFormMessage : null,
	}
}

function planPackage(
	files: Record<string, string>,
	context: PackageCodemodContext,
) {
	const located = ownAppFiles(files, context)
	const target = readTarget(context)
	if (!located || !target) return []
	const plans: Array<FilePlan & { key: string }> = []
	const paths = Object.keys(located.files).sort((left, right) =>
		left.localeCompare(right),
	)
	for (const path of paths) {
		const source = located.files[path]
		if (typeof source !== 'string') continue
		if (!textFilePattern.test(path) || ignoredFilePattern.test(path)) continue
		const plan = planFile(path, source, target)
		if (plan.rewritten === null && plan.manual === null) continue
		plans.push({ ...plan, key: path })
	}
	return plans
}

function detectPackageAppHostUrls(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	for (const plan of planPackage(files, context)) {
		if (plan.rewritten !== null) {
			findings.push({ path: plan.key, message: rewriteMessage })
		}
		if (plan.manual !== null) {
			findings.push({ path: plan.key, message: plan.manual })
		}
	}
	return findings
}

function transformPackageAppHostUrls(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const plan of planPackage(files, context)) {
		if (plan.rewritten !== null) {
			nextFiles[plan.key] = plan.rewritten
			changedPaths.push(plan.key)
		}
		if (plan.manual !== null) {
			needsManual.push({ path: plan.key, message: plan.manual })
		}
	}
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

/**
 * Apply step of the move from `https://{user}.kody.run/{leaf}` to
 * `https://{leaf}--{user}.kody.run`: rewrites full `https://` URLs of the
 * package's own app. An absolute URL on the new host is right wherever the
 * page that carries it was loaded from, so this is the one rewrite that is
 * safe on both addresses. Everything else 0019 reports (mount paths, bases,
 * storage, cookies, origin checks) stays with the owner.
 */
export const packageAppHostUrlsCodemod: PackageCodemod = {
	id: packageAppHostUrlsCodemodId,
	description:
		'Rewrite full https://{user}.kody.run/{leaf} (and /packages/{leaf}) URLs of the package’s own app to https://{leaf}--{user}.kody.run; flag files with origin checks and scheme-less mentions for manual review.',
	// The published tree is what the app serves, so drifted apps are updated too.
	applyMode: 'published-only',
	detect: detectPackageAppHostUrls,
	transform: transformPackageAppHostUrls,
}
