import { z } from 'zod'

const relativePackagePathSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine(
		(path) =>
			!path.startsWith('/') &&
			!/^[a-z][a-z0-9+.-]*:/i.test(path) &&
			!path.split('/').includes('..'),
		{ message: 'Use a path relative to the package root.' },
	)

const starterLabelListSchema = z
	.array(z.string().trim().min(1).max(40))
	.min(1)
	.max(12)

/** `package.json#kody.starter`: what agents read when choosing a starter. */
export const appStarterManifestSchema = z.strictObject({
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().min(1).max(400),
	whenToUse: z.string().trim().min(1).max(400),
	tags: starterLabelListSchema,
	preview: relativePackagePathSchema,
	capabilities: starterLabelListSchema,
	customize: z.strictObject({
		themeTokens: relativePackagePathSchema,
		routes: relativePackagePathSchema,
		content: relativePackagePathSchema,
	}),
})

export type AppStarterManifest = z.infer<typeof appStarterManifestSchema>

export type AppStarterFieldError = { field: string; message: string }

export type AppStarterManifestResult =
	| { ok: true; starter: AppStarterManifest }
	| { ok: false; fieldErrors: Array<AppStarterFieldError> }

function readStarterValue(packageJson: unknown) {
	if (!packageJson || typeof packageJson !== 'object') return undefined
	const kody = (packageJson as Record<string, unknown>)['kody']
	if (!kody || typeof kody !== 'object') return undefined
	return (kody as Record<string, unknown>)['starter']
}

/** Validates `kody.starter` in a parsed package.json and names every failed field. */
export function validateAppStarterManifest(
	packageJson: unknown,
): AppStarterManifestResult {
	const starter = readStarterValue(packageJson)
	if (starter === undefined) {
		return {
			ok: false,
			fieldErrors: [
				{ field: 'kody.starter', message: 'Add a kody.starter object.' },
			],
		}
	}
	const result = appStarterManifestSchema.safeParse(starter)
	if (result.success) return { ok: true, starter: result.data }
	const fieldErrors = new Map<string, string>()
	for (const issue of result.error.issues) {
		const keys =
			issue.code === 'unrecognized_keys'
				? issue.keys.map((key) => [...issue.path, key])
				: [issue.path]
		for (const path of keys) {
			const field = ['kody', 'starter', ...path.map(String)].join('.')
			if (!fieldErrors.has(field)) fieldErrors.set(field, issue.message)
		}
	}
	return {
		ok: false,
		fieldErrors: [...fieldErrors].map(([field, message]) => ({
			field,
			message,
		})),
	}
}
