/**
 * Latino Extension Entry Point
 */

export { LatinoBundleClass as default } from './core/bundle.js';

export {
  STREAM_PROVIDERS,
  MANGA_PROVIDERS,
} from './providers/registry.js';

export type {
  ProviderDiagnostic,
  ProviderChunk,
  DebugProviderResult,
} from './types/index.js';
