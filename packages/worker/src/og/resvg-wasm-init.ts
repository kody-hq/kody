import { initWasm } from '@resvg/resvg-wasm'
import { ogResvgWasm } from '#worker/og/og-resvg-wasm.ts'
import { isolateMemo } from '#worker/isolate-memo.ts'

/**
 * resvg wasm init, separate from `render.ts` on purpose: community icon
 * rendering only rasterizes SVG (no satori markup), and importing
 * `render.ts` for its init helper dragged satori + opentype into the static
 * module graph of every isolate. This module imports only `og-resvg-wasm`
 * (not `og-image-assets`) so yoga WASM and OG binary assets stay behind the
 * dynamic OG imports.
 */
export const ensureResvgWasmReady: () => Promise<void> = isolateMemo(() =>
	initWasm(ogResvgWasm).then(() => undefined),
)
