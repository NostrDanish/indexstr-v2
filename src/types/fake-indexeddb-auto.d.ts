/**
 * fake-indexeddb's `./auto` export has no `types` condition in its exports
 * map, so TS2882 rejects the side-effect import under moduleResolution:
 * bundler. The import only registers the fake IndexedDB globals — there is
 * no API surface to type.
 */
declare module 'fake-indexeddb/auto';
