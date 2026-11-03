import {
	buildPackageSearchDocument,
	buildPackageSearchProjection,
} from './manifest.ts'
import type { AuthoredPackageJson } from './types.ts'

export function buildSavedPackageEmbedText(manifest: AuthoredPackageJson) {
	return buildPackageSearchDocument(buildPackageSearchProjection(manifest))
}
