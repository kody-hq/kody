/** Largest JSON request body the API accepts, in bytes. */
export const maxApiRequestBodyBytes = 5 * 1024 * 1024

/**
 * Largest `packageCheck` request body. The body carries a whole package tree,
 * binaries as base64, and the publish checks accept up to 15 MiB of source
 * (`repoChecksSourceMaxTotalBytes`), so the general cap would refuse trees
 * that publish itself accepts. 15 MiB * 4/3 (base64) plus JSON headroom.
 */
export const maxPackageCheckRequestBodyBytes = 24 * 1024 * 1024

/** The body cap for an operation: most use `maxApiRequestBodyBytes`. */
export function maxRequestBodyBytesForOperation(operationId: string) {
	return operationId === 'packageCheck'
		? maxPackageCheckRequestBodyBytes
		: maxApiRequestBodyBytes
}

/**
 * Room under `maxApiRequestBodyBytes` for the `kody.gatewayFetch` JSON
 * envelope around `bodyBase64`: call path, url, headers, package binding,
 * and the credential call map.
 */
export const gatewayFetchJsonEnvelopeHeadroomBytes = 1024 * 1024

/**
 * Largest raw request body the local-execute shim sends through the JSON
 * `kody.gatewayFetch` hop. Base64 is 4 bytes per 3, so this is
 * (5 MiB - 1 MiB) / 4 * 3 = 3 MiB. Larger bodies use the streaming hop.
 */
export const maxGatewayFetchJsonHopBodyBytes =
	Math.floor(
		(maxApiRequestBodyBytes - gatewayFetchJsonEnvelopeHeadroomBytes) / 4,
	) * 3
