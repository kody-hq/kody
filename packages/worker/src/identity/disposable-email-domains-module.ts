/**
 * Entry for the deferred disposable-email-domains additional module. Bundled
 * by `tools/build-worker-bundler-modules.ts` into
 * `node_modules/.kody-generated/disposable-email-domains.mjs`. Load it through
 * `#worker/disposable-email-domains-load.ts`; a static import puts the ~160 KB list on
 * the platform/runtime startup graph.
 */
export { disposableEmailDomainList } from './disposable-email-domains.ts'
