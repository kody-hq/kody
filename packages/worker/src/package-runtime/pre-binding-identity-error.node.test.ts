import { expect, test } from 'vitest'
import {
	describePreBindingIdentityError,
	packageBindingRewriteVersion,
	preBindingRepublishHint,
} from './pre-binding-artifact-repair.ts'

const ownerOnlyMessage =
	'packageStorage() for package "pkg-dependency" is only available to that package\'s own code. Importer code and other packages in the same run cannot read or write it by naming its package id; call an export of that package so its own packageStorage() does the reading and writing.'

function bundle(
	input: {
		source?: string
		dependencies?: Array<{ packageId?: string }>
		packageBindingRewrite?: number
		packageContext?: { packageId: string } | null
	} = {},
) {
	return {
		modules: {
			'bundle.js':
				input.source ??
				'export default async () => { await fetch("https://example.com/") }',
		},
		dependencies: input.dependencies ?? [{ packageId: 'pkg-dependency' }],
		packageContext:
			input.packageContext === undefined
				? { packageId: 'pkg-workflow' }
				: input.packageContext,
		...(input.packageBindingRewrite === undefined
			? {}
			: { packageBindingRewrite: input.packageBindingRewrite }),
	}
}

test('an identity error from an unrebuildable pre-binding bundle gets the republish hint', () => {
	expect(
		describePreBindingIdentityError({
			message: ownerOnlyMessage,
			artifact: bundle(),
		}),
	).toBe(`${ownerOnlyMessage} ${preBindingRepublishHint}`)
	for (const message of [
		'fetch for package "pkg-dependency" has no package binding in this run, so it cannot act as that package.',
		'credential() for package "pkg-dependency" is only available to that package\'s own code.',
		'Secret "token" exists in package scope and is not visible from this runtime.',
	]) {
		expect(
			describePreBindingIdentityError({ message, artifact: bundle() }),
		).toBe(`${message} ${preBindingRepublishHint}`)
	}
})

test('current, single-package, and unrelated failures keep their message', () => {
	// Built with the lexical binding.
	expect(
		describePreBindingIdentityError({
			message: ownerOnlyMessage,
			artifact: bundle({
				source:
					'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-workflow");\nexport default async () => {}',
			}),
		}),
	).toBeNull()
	expect(
		describePreBindingIdentityError({
			message: ownerOnlyMessage,
			artifact: bundle({ packageBindingRewrite: packageBindingRewriteVersion }),
		}),
	).toBeNull()
	// Repairable in place: only the bundle's own package.
	expect(
		describePreBindingIdentityError({
			message: ownerOnlyMessage,
			artifact: bundle({ dependencies: [{ packageId: 'pkg-workflow' }] }),
		}),
	).toBeNull()
	// Ad hoc code with no package context.
	expect(
		describePreBindingIdentityError({
			message: ownerOnlyMessage,
			artifact: bundle({ packageContext: null }),
		}),
	).toBeNull()
	expect(
		describePreBindingIdentityError({
			message: 'Upstream returned 500',
			artifact: bundle(),
		}),
	).toBeNull()
	// Already hinted (nested runs) is not hinted twice.
	expect(
		describePreBindingIdentityError({
			message: `${ownerOnlyMessage} ${preBindingRepublishHint}`,
			artifact: bundle(),
		}),
	).toBeNull()
})
