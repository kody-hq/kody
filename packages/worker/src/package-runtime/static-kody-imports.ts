import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
} from './package-import-resolution.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'

export type StaticKodyPackageImport = {
	filePath: string
	specifier: string
	packageName: string
	exportName: string
}

export function isTypeDeclarationFilePath(filePath: string) {
	return /\.d\.[cm]?ts$/.test(filePath)
}

async function collectStaticKodyPackageImportsFromSource(input: {
	filePath: string
	source: string
	includeTypeOnly?: boolean
}): Promise<Array<StaticKodyPackageImport>> {
	const imports: Array<StaticKodyPackageImport> = []
	for (const node of await collectLiteralImportNodes(input.source, {
		includeTypeOnly: input.includeTypeOnly,
		filePath: input.filePath,
	})) {
		if (node.kind !== 'static') continue
		if (!node.specifier.startsWith(packageSpecifierPrefix)) continue
		const parsedSpecifier = parseKodyPackageSpecifier(node.specifier)
		imports.push({
			filePath: input.filePath,
			specifier: node.specifier,
			packageName: parsedSpecifier.packageName,
			exportName: parsedSpecifier.exportName,
		})
	}
	return imports
}

export async function collectStaticKodyPackageImportsFromFiles(
	files: Record<string, string>,
	options?: {
		includeTypeDeclarations?: boolean
		includeTypeOnly?: boolean
	},
): Promise<Array<StaticKodyPackageImport>> {
	const perFile = await Promise.all(
		Object.entries(files)
			.filter(
				([filePath]) =>
					options?.includeTypeDeclarations === true ||
					!isTypeDeclarationFilePath(filePath),
			)
			.map(([filePath, source]) =>
				collectStaticKodyPackageImportsFromSource({
					filePath,
					source,
					includeTypeOnly: options?.includeTypeOnly,
				}),
			),
	)
	return perFile
		.flat()
		.sort(
			(left, right) =>
				left.packageName.localeCompare(right.packageName) ||
				left.exportName.localeCompare(right.exportName) ||
				left.filePath.localeCompare(right.filePath),
		)
}
