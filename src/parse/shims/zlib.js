// zlib for the browser bundle, backed by pako. Only gunzipSync is used, by
// the Level 2 reader when a whole archive file arrives gzipped.
import pako from 'pako';
export default { gunzipSync: (buf) => Buffer.from(pako.ungzip(buf)) };
export const gunzipSync = (buf) => Buffer.from(pako.ungzip(buf));
