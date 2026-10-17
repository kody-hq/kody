/**
 * Meta tag carrying the canonical origin the server rendered head URLs with
 * (`getCanonicalAppBaseUrl`). SPA navigations read it so canonical/OG URLs
 * keep pointing at the canonical domain when the page is dual-served from a
 * legacy host, instead of reverting to `window.location.origin`.
 */
export const CANONICAL_ORIGIN_META_NAME = 'kody:canonical-origin'
