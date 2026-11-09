// workerd treats every named export of a main module as an entrypoint, so
// the served builder exports only its fetch handler.
export { default } from './builder-entry.ts'
