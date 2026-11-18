import { expect, test, vi } from 'vitest'

vi.mock('#worker/module-source.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#worker/module-source.ts')>()),
	loadModuleSourceParser: async () => {
		throw new Error('No such module "module-source-parser.mjs".')
	},
}))

const { collectBundlerResolvedSpecifiers, collectModuleImportNodes } =
	await import('./import-specifiers.ts')

test('a parser that fails to load is an error, not a module with no imports', async () => {
	const source = 'import list from "kody:@them/notes/list"\nexport default list'
	await expect(collectModuleImportNodes(source)).rejects.toThrow(
		/module-source-parser/,
	)
	await expect(collectBundlerResolvedSpecifiers(source)).rejects.toThrow(
		/module-source-parser/,
	)
})
