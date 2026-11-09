import type {
	PackageInvokeInput,
	PackageInvokeNormalizedInput,
} from '#mcp/run-kody-registry.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'

const packageInvokeOptionKeys = [
	'exportName',
	'params',
	'idempotencyKey',
	'topic',
] as const
const packageInvokeEnvelopeKeys = ['specifier', 'options'] as const

function assertRecord(
	value: unknown,
	message: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(message)
	}
}

function assertKnownKeys(
	input: Record<string, unknown>,
	acceptedKeys: ReadonlyArray<string>,
	operationName: string,
) {
	const acceptedKeySet = new Set(acceptedKeys)
	const unknownKeys = Object.keys(input).filter(
		(key) => !acceptedKeySet.has(key),
	)
	if (unknownKeys.length === 0) return
	throw new Error(
		`${operationName} received unknown input ${unknownKeys.length === 1 ? 'key' : 'keys'} ${unknownKeys.map((key) => JSON.stringify(key)).join(', ')}. Accepted keys: ${acceptedKeys.join(', ')}.`,
	)
}

function readOptionalString(input: Record<string, unknown>, fieldName: string) {
	const value = input[fieldName]
	if (typeof value === 'string' && value.trim()) return value.trim()
	return null
}

function readPackageInvokeParams(
	input: Record<string, unknown>,
	operationName = 'packages.invoke',
) {
	const params = input['params']
	if (params === undefined || params === null) return undefined
	if (!params || typeof params !== 'object' || Array.isArray(params)) {
		throw new Error(
			`${operationName} params must be a JSON object when provided.`,
		)
	}
	return params as Record<string, unknown>
}

function parsePackageInvokeSpecifier(
	specifierValue: unknown,
	operationName: string,
) {
	if (typeof specifierValue !== 'string' || !specifierValue.trim()) {
		throw new Error(
			`${operationName} requires a kody:@owner/package[/export] or @owner/package[/export] specifier.`,
		)
	}
	const trimmed = specifierValue.trim()
	const specifier = trimmed.startsWith('@') ? `kody:${trimmed}` : trimmed
	if (!specifier.startsWith(packageSpecifierPrefix)) {
		throw new Error(
			`${operationName} requires a kody:@owner/package[/export] or @owner/package[/export] specifier.`,
		)
	}
	const parsed = parseKodyPackageSpecifier(specifier)
	const pathSegments = specifier.slice(packageSpecifierPrefix.length).split('/')
	const specifierExportName = pathSegments
		.slice(2)
		.some((segment) => segment.trim())
		? parsed.exportName
		: null
	const canonicalSpecifier = `${packageSpecifierPrefix}${parsed.packageName.slice(1)}${
		specifierExportName ? `/${specifierExportName}` : ''
	}`
	return {
		specifier: canonicalSpecifier,
		packageName: parsed.packageName,
		specifierExportName,
	}
}

export function parsePackageInvokeInput(
	input: PackageInvokeInput,
	operationName = 'packages.invoke',
) {
	assertRecord(
		input,
		`Object-only ${operationName} was removed. Use ${operationName}("kody:@owner/package/export", { params }) instead.`,
	)
	assertKnownKeys(input, packageInvokeEnvelopeKeys, operationName)
	const parsedSpecifier = parsePackageInvokeSpecifier(
		input['specifier'],
		operationName,
	)
	const rawOptions = input['options']
	if (rawOptions !== undefined && rawOptions !== null) {
		assertRecord(
			rawOptions,
			`${operationName} options must be an object when provided.`,
		)
	}
	const options = rawOptions ?? {}
	assertKnownKeys(options, packageInvokeOptionKeys, operationName)
	const exportName =
		parsedSpecifier.specifierExportName ??
		readOptionalString(options, 'exportName')
	if (!exportName) {
		throw new Error(
			`${operationName} requires exportName when the package specifier has no export subpath.`,
		)
	}
	return {
		specifier: parsedSpecifier.specifier,
		packageName: parsedSpecifier.packageName,
		exportName,
		params: readPackageInvokeParams(options, operationName),
		idempotencyKey: readOptionalString(options, 'idempotencyKey'),
		topic: readOptionalString(options, 'topic'),
	}
}

export type ParsedPackageInvokeInput = ReturnType<
	typeof parsePackageInvokeInput
>

export function buildNormalizedPackageInvokeInput(input: {
	request: ParsedPackageInvokeInput
	exportName: string
}): PackageInvokeNormalizedInput {
	return {
		specifier: input.request.specifier,
		exportName: input.exportName,
		...(input.request.params === undefined
			? {}
			: { params: input.request.params }),
		...(input.request.idempotencyKey
			? { idempotencyKey: input.request.idempotencyKey }
			: {}),
		...(input.request.topic ? { topic: input.request.topic } : {}),
	}
}
