// Injected by the build so every bare Buffer in the vendored parsers is the
// SAME Buffer the worker imports. Two copies of the package in one bundle is
// how "instanceof Buffer" goes false against a Buffer, and every parse died
// with "Unknown data provided".
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
export { Buffer };
