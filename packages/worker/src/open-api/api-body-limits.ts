/** Largest JSON request body the API accepts, in bytes. */
export const maxApiRequestBodyBytes = 5 * 1024 * 1024

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
