/**
 * Entry for the deferred codemode `normalizeCode` additional module. Bundled
 * by `tools/build-worker-bundler-modules.ts` into
 * `node_modules/.kody-generated/codemode-normalize.mjs`. `normalizeCode` is the
 * only codemode export that needs acorn (~123 KB), so loaders import that
 * generated specifier (see `codemode-normalize-load.ts`) and keep acorn off the
 * platform/runtime startup entries. Acorn's own `parse` rides along for
 * callers that only need a JavaScript syntax check.
 */
export { normalizeCode } from '@cloudflare/codemode'
export { parse as parseJavaScript } from 'acorn'
