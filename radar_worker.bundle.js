(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/base64-js/index.js
  var require_base64_js = __commonJS({
    "node_modules/base64-js/index.js"(exports) {
      "use strict";
      init_inject_buffer();
      exports.byteLength = byteLength;
      exports.toByteArray = toByteArray;
      exports.fromByteArray = fromByteArray;
      var lookup = [];
      var revLookup = [];
      var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
      var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      for (i = 0, len = code.length; i < len; ++i) {
        lookup[i] = code[i];
        revLookup[code.charCodeAt(i)] = i;
      }
      var i;
      var len;
      revLookup["-".charCodeAt(0)] = 62;
      revLookup["_".charCodeAt(0)] = 63;
      function getLens(b64) {
        var len2 = b64.length;
        if (len2 % 4 > 0) {
          throw new Error("Invalid string. Length must be a multiple of 4");
        }
        var validLen = b64.indexOf("=");
        if (validLen === -1) validLen = len2;
        var placeHoldersLen = validLen === len2 ? 0 : 4 - validLen % 4;
        return [validLen, placeHoldersLen];
      }
      function byteLength(b64) {
        var lens = getLens(b64);
        var validLen = lens[0];
        var placeHoldersLen = lens[1];
        return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
      }
      function _byteLength(b64, validLen, placeHoldersLen) {
        return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
      }
      function toByteArray(b64) {
        var tmp;
        var lens = getLens(b64);
        var validLen = lens[0];
        var placeHoldersLen = lens[1];
        var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
        var curByte = 0;
        var len2 = placeHoldersLen > 0 ? validLen - 4 : validLen;
        var i2;
        for (i2 = 0; i2 < len2; i2 += 4) {
          tmp = revLookup[b64.charCodeAt(i2)] << 18 | revLookup[b64.charCodeAt(i2 + 1)] << 12 | revLookup[b64.charCodeAt(i2 + 2)] << 6 | revLookup[b64.charCodeAt(i2 + 3)];
          arr[curByte++] = tmp >> 16 & 255;
          arr[curByte++] = tmp >> 8 & 255;
          arr[curByte++] = tmp & 255;
        }
        if (placeHoldersLen === 2) {
          tmp = revLookup[b64.charCodeAt(i2)] << 2 | revLookup[b64.charCodeAt(i2 + 1)] >> 4;
          arr[curByte++] = tmp & 255;
        }
        if (placeHoldersLen === 1) {
          tmp = revLookup[b64.charCodeAt(i2)] << 10 | revLookup[b64.charCodeAt(i2 + 1)] << 4 | revLookup[b64.charCodeAt(i2 + 2)] >> 2;
          arr[curByte++] = tmp >> 8 & 255;
          arr[curByte++] = tmp & 255;
        }
        return arr;
      }
      function tripletToBase64(num) {
        return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
      }
      function encodeChunk(uint8, start, end) {
        var tmp;
        var output = [];
        for (var i2 = start; i2 < end; i2 += 3) {
          tmp = (uint8[i2] << 16 & 16711680) + (uint8[i2 + 1] << 8 & 65280) + (uint8[i2 + 2] & 255);
          output.push(tripletToBase64(tmp));
        }
        return output.join("");
      }
      function fromByteArray(uint8) {
        var tmp;
        var len2 = uint8.length;
        var extraBytes = len2 % 3;
        var parts = [];
        var maxChunkLength = 16383;
        for (var i2 = 0, len22 = len2 - extraBytes; i2 < len22; i2 += maxChunkLength) {
          parts.push(encodeChunk(uint8, i2, i2 + maxChunkLength > len22 ? len22 : i2 + maxChunkLength));
        }
        if (extraBytes === 1) {
          tmp = uint8[len2 - 1];
          parts.push(
            lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "=="
          );
        } else if (extraBytes === 2) {
          tmp = (uint8[len2 - 2] << 8) + uint8[len2 - 1];
          parts.push(
            lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "="
          );
        }
        return parts.join("");
      }
    }
  });

  // node_modules/ieee754/index.js
  var require_ieee754 = __commonJS({
    "node_modules/ieee754/index.js"(exports) {
      init_inject_buffer();
      exports.read = function(buffer, offset, isLE, mLen, nBytes) {
        var e, m;
        var eLen = nBytes * 8 - mLen - 1;
        var eMax = (1 << eLen) - 1;
        var eBias = eMax >> 1;
        var nBits = -7;
        var i = isLE ? nBytes - 1 : 0;
        var d = isLE ? -1 : 1;
        var s = buffer[offset + i];
        i += d;
        e = s & (1 << -nBits) - 1;
        s >>= -nBits;
        nBits += eLen;
        for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {
        }
        m = e & (1 << -nBits) - 1;
        e >>= -nBits;
        nBits += mLen;
        for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {
        }
        if (e === 0) {
          e = 1 - eBias;
        } else if (e === eMax) {
          return m ? NaN : (s ? -1 : 1) * Infinity;
        } else {
          m = m + Math.pow(2, mLen);
          e = e - eBias;
        }
        return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
      };
      exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
        var e, m, c;
        var eLen = nBytes * 8 - mLen - 1;
        var eMax = (1 << eLen) - 1;
        var eBias = eMax >> 1;
        var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
        var i = isLE ? 0 : nBytes - 1;
        var d = isLE ? 1 : -1;
        var s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
        value = Math.abs(value);
        if (isNaN(value) || value === Infinity) {
          m = isNaN(value) ? 1 : 0;
          e = eMax;
        } else {
          e = Math.floor(Math.log(value) / Math.LN2);
          if (value * (c = Math.pow(2, -e)) < 1) {
            e--;
            c *= 2;
          }
          if (e + eBias >= 1) {
            value += rt / c;
          } else {
            value += rt * Math.pow(2, 1 - eBias);
          }
          if (value * c >= 2) {
            e++;
            c /= 2;
          }
          if (e + eBias >= eMax) {
            m = 0;
            e = eMax;
          } else if (e + eBias >= 1) {
            m = (value * c - 1) * Math.pow(2, mLen);
            e = e + eBias;
          } else {
            m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
            e = 0;
          }
        }
        for (; mLen >= 8; buffer[offset + i] = m & 255, i += d, m /= 256, mLen -= 8) {
        }
        e = e << mLen | m;
        eLen += mLen;
        for (; eLen > 0; buffer[offset + i] = e & 255, i += d, e /= 256, eLen -= 8) {
        }
        buffer[offset + i - d] |= s * 128;
      };
    }
  });

  // node_modules/buffer/index.js
  var require_buffer = __commonJS({
    "node_modules/buffer/index.js"(exports) {
      "use strict";
      init_inject_buffer();
      var base64 = require_base64_js();
      var ieee754 = require_ieee754();
      var customInspectSymbol = typeof Symbol === "function" && typeof Symbol["for"] === "function" ? Symbol["for"]("nodejs.util.inspect.custom") : null;
      exports.Buffer = Buffer4;
      exports.SlowBuffer = SlowBuffer;
      exports.INSPECT_MAX_BYTES = 50;
      var K_MAX_LENGTH = 2147483647;
      exports.kMaxLength = K_MAX_LENGTH;
      Buffer4.TYPED_ARRAY_SUPPORT = typedArraySupport();
      if (!Buffer4.TYPED_ARRAY_SUPPORT && typeof console !== "undefined" && typeof console.error === "function") {
        console.error(
          "This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support."
        );
      }
      function typedArraySupport() {
        try {
          const arr = new Uint8Array(1);
          const proto = { foo: function() {
            return 42;
          } };
          Object.setPrototypeOf(proto, Uint8Array.prototype);
          Object.setPrototypeOf(arr, proto);
          return arr.foo() === 42;
        } catch (e) {
          return false;
        }
      }
      Object.defineProperty(Buffer4.prototype, "parent", {
        enumerable: true,
        get: function() {
          if (!Buffer4.isBuffer(this)) return void 0;
          return this.buffer;
        }
      });
      Object.defineProperty(Buffer4.prototype, "offset", {
        enumerable: true,
        get: function() {
          if (!Buffer4.isBuffer(this)) return void 0;
          return this.byteOffset;
        }
      });
      function createBuffer(length) {
        if (length > K_MAX_LENGTH) {
          throw new RangeError('The value "' + length + '" is invalid for option "size"');
        }
        const buf = new Uint8Array(length);
        Object.setPrototypeOf(buf, Buffer4.prototype);
        return buf;
      }
      function Buffer4(arg, encodingOrOffset, length) {
        if (typeof arg === "number") {
          if (typeof encodingOrOffset === "string") {
            throw new TypeError(
              'The "string" argument must be of type string. Received type number'
            );
          }
          return allocUnsafe(arg);
        }
        return from(arg, encodingOrOffset, length);
      }
      Buffer4.poolSize = 8192;
      function from(value, encodingOrOffset, length) {
        if (typeof value === "string") {
          return fromString(value, encodingOrOffset);
        }
        if (ArrayBuffer.isView(value)) {
          return fromArrayView(value);
        }
        if (value == null) {
          throw new TypeError(
            "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
          );
        }
        if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer)) {
          return fromArrayBuffer(value, encodingOrOffset, length);
        }
        if (typeof SharedArrayBuffer !== "undefined" && (isInstance(value, SharedArrayBuffer) || value && isInstance(value.buffer, SharedArrayBuffer))) {
          return fromArrayBuffer(value, encodingOrOffset, length);
        }
        if (typeof value === "number") {
          throw new TypeError(
            'The "value" argument must not be of type number. Received type number'
          );
        }
        const valueOf = value.valueOf && value.valueOf();
        if (valueOf != null && valueOf !== value) {
          return Buffer4.from(valueOf, encodingOrOffset, length);
        }
        const b = fromObject(value);
        if (b) return b;
        if (typeof Symbol !== "undefined" && Symbol.toPrimitive != null && typeof value[Symbol.toPrimitive] === "function") {
          return Buffer4.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
        }
        throw new TypeError(
          "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
        );
      }
      Buffer4.from = function(value, encodingOrOffset, length) {
        return from(value, encodingOrOffset, length);
      };
      Object.setPrototypeOf(Buffer4.prototype, Uint8Array.prototype);
      Object.setPrototypeOf(Buffer4, Uint8Array);
      function assertSize(size) {
        if (typeof size !== "number") {
          throw new TypeError('"size" argument must be of type number');
        } else if (size < 0) {
          throw new RangeError('The value "' + size + '" is invalid for option "size"');
        }
      }
      function alloc(size, fill, encoding) {
        assertSize(size);
        if (size <= 0) {
          return createBuffer(size);
        }
        if (fill !== void 0) {
          return typeof encoding === "string" ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
        }
        return createBuffer(size);
      }
      Buffer4.alloc = function(size, fill, encoding) {
        return alloc(size, fill, encoding);
      };
      function allocUnsafe(size) {
        assertSize(size);
        return createBuffer(size < 0 ? 0 : checked(size) | 0);
      }
      Buffer4.allocUnsafe = function(size) {
        return allocUnsafe(size);
      };
      Buffer4.allocUnsafeSlow = function(size) {
        return allocUnsafe(size);
      };
      function fromString(string, encoding) {
        if (typeof encoding !== "string" || encoding === "") {
          encoding = "utf8";
        }
        if (!Buffer4.isEncoding(encoding)) {
          throw new TypeError("Unknown encoding: " + encoding);
        }
        const length = byteLength(string, encoding) | 0;
        let buf = createBuffer(length);
        const actual = buf.write(string, encoding);
        if (actual !== length) {
          buf = buf.slice(0, actual);
        }
        return buf;
      }
      function fromArrayLike(array) {
        const length = array.length < 0 ? 0 : checked(array.length) | 0;
        const buf = createBuffer(length);
        for (let i = 0; i < length; i += 1) {
          buf[i] = array[i] & 255;
        }
        return buf;
      }
      function fromArrayView(arrayView) {
        if (isInstance(arrayView, Uint8Array)) {
          const copy2 = new Uint8Array(arrayView);
          return fromArrayBuffer(copy2.buffer, copy2.byteOffset, copy2.byteLength);
        }
        return fromArrayLike(arrayView);
      }
      function fromArrayBuffer(array, byteOffset, length) {
        if (byteOffset < 0 || array.byteLength < byteOffset) {
          throw new RangeError('"offset" is outside of buffer bounds');
        }
        if (array.byteLength < byteOffset + (length || 0)) {
          throw new RangeError('"length" is outside of buffer bounds');
        }
        let buf;
        if (byteOffset === void 0 && length === void 0) {
          buf = new Uint8Array(array);
        } else if (length === void 0) {
          buf = new Uint8Array(array, byteOffset);
        } else {
          buf = new Uint8Array(array, byteOffset, length);
        }
        Object.setPrototypeOf(buf, Buffer4.prototype);
        return buf;
      }
      function fromObject(obj) {
        if (Buffer4.isBuffer(obj)) {
          const len = checked(obj.length) | 0;
          const buf = createBuffer(len);
          if (buf.length === 0) {
            return buf;
          }
          obj.copy(buf, 0, 0, len);
          return buf;
        }
        if (obj.length !== void 0) {
          if (typeof obj.length !== "number" || numberIsNaN(obj.length)) {
            return createBuffer(0);
          }
          return fromArrayLike(obj);
        }
        if (obj.type === "Buffer" && Array.isArray(obj.data)) {
          return fromArrayLike(obj.data);
        }
      }
      function checked(length) {
        if (length >= K_MAX_LENGTH) {
          throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + K_MAX_LENGTH.toString(16) + " bytes");
        }
        return length | 0;
      }
      function SlowBuffer(length) {
        if (+length != length) {
          length = 0;
        }
        return Buffer4.alloc(+length);
      }
      Buffer4.isBuffer = function isBuffer(b) {
        return b != null && b._isBuffer === true && b !== Buffer4.prototype;
      };
      Buffer4.compare = function compare(a, b) {
        if (isInstance(a, Uint8Array)) a = Buffer4.from(a, a.offset, a.byteLength);
        if (isInstance(b, Uint8Array)) b = Buffer4.from(b, b.offset, b.byteLength);
        if (!Buffer4.isBuffer(a) || !Buffer4.isBuffer(b)) {
          throw new TypeError(
            'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
          );
        }
        if (a === b) return 0;
        let x = a.length;
        let y = b.length;
        for (let i = 0, len = Math.min(x, y); i < len; ++i) {
          if (a[i] !== b[i]) {
            x = a[i];
            y = b[i];
            break;
          }
        }
        if (x < y) return -1;
        if (y < x) return 1;
        return 0;
      };
      Buffer4.isEncoding = function isEncoding(encoding) {
        switch (String(encoding).toLowerCase()) {
          case "hex":
          case "utf8":
          case "utf-8":
          case "ascii":
          case "latin1":
          case "binary":
          case "base64":
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return true;
          default:
            return false;
        }
      };
      Buffer4.concat = function concat(list, length) {
        if (!Array.isArray(list)) {
          throw new TypeError('"list" argument must be an Array of Buffers');
        }
        if (list.length === 0) {
          return Buffer4.alloc(0);
        }
        let i;
        if (length === void 0) {
          length = 0;
          for (i = 0; i < list.length; ++i) {
            length += list[i].length;
          }
        }
        const buffer = Buffer4.allocUnsafe(length);
        let pos = 0;
        for (i = 0; i < list.length; ++i) {
          let buf = list[i];
          if (isInstance(buf, Uint8Array)) {
            if (pos + buf.length > buffer.length) {
              if (!Buffer4.isBuffer(buf)) buf = Buffer4.from(buf);
              buf.copy(buffer, pos);
            } else {
              Uint8Array.prototype.set.call(
                buffer,
                buf,
                pos
              );
            }
          } else if (!Buffer4.isBuffer(buf)) {
            throw new TypeError('"list" argument must be an Array of Buffers');
          } else {
            buf.copy(buffer, pos);
          }
          pos += buf.length;
        }
        return buffer;
      };
      function byteLength(string, encoding) {
        if (Buffer4.isBuffer(string)) {
          return string.length;
        }
        if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
          return string.byteLength;
        }
        if (typeof string !== "string") {
          throw new TypeError(
            'The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type ' + typeof string
          );
        }
        const len = string.length;
        const mustMatch = arguments.length > 2 && arguments[2] === true;
        if (!mustMatch && len === 0) return 0;
        let loweredCase = false;
        for (; ; ) {
          switch (encoding) {
            case "ascii":
            case "latin1":
            case "binary":
              return len;
            case "utf8":
            case "utf-8":
              return utf8ToBytes(string).length;
            case "ucs2":
            case "ucs-2":
            case "utf16le":
            case "utf-16le":
              return len * 2;
            case "hex":
              return len >>> 1;
            case "base64":
              return base64ToBytes(string).length;
            default:
              if (loweredCase) {
                return mustMatch ? -1 : utf8ToBytes(string).length;
              }
              encoding = ("" + encoding).toLowerCase();
              loweredCase = true;
          }
        }
      }
      Buffer4.byteLength = byteLength;
      function slowToString(encoding, start, end) {
        let loweredCase = false;
        if (start === void 0 || start < 0) {
          start = 0;
        }
        if (start > this.length) {
          return "";
        }
        if (end === void 0 || end > this.length) {
          end = this.length;
        }
        if (end <= 0) {
          return "";
        }
        end >>>= 0;
        start >>>= 0;
        if (end <= start) {
          return "";
        }
        if (!encoding) encoding = "utf8";
        while (true) {
          switch (encoding) {
            case "hex":
              return hexSlice(this, start, end);
            case "utf8":
            case "utf-8":
              return utf8Slice(this, start, end);
            case "ascii":
              return asciiSlice(this, start, end);
            case "latin1":
            case "binary":
              return latin1Slice(this, start, end);
            case "base64":
              return base64Slice(this, start, end);
            case "ucs2":
            case "ucs-2":
            case "utf16le":
            case "utf-16le":
              return utf16leSlice(this, start, end);
            default:
              if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
              encoding = (encoding + "").toLowerCase();
              loweredCase = true;
          }
        }
      }
      Buffer4.prototype._isBuffer = true;
      function swap(b, n, m) {
        const i = b[n];
        b[n] = b[m];
        b[m] = i;
      }
      Buffer4.prototype.swap16 = function swap16() {
        const len = this.length;
        if (len % 2 !== 0) {
          throw new RangeError("Buffer size must be a multiple of 16-bits");
        }
        for (let i = 0; i < len; i += 2) {
          swap(this, i, i + 1);
        }
        return this;
      };
      Buffer4.prototype.swap32 = function swap32() {
        const len = this.length;
        if (len % 4 !== 0) {
          throw new RangeError("Buffer size must be a multiple of 32-bits");
        }
        for (let i = 0; i < len; i += 4) {
          swap(this, i, i + 3);
          swap(this, i + 1, i + 2);
        }
        return this;
      };
      Buffer4.prototype.swap64 = function swap64() {
        const len = this.length;
        if (len % 8 !== 0) {
          throw new RangeError("Buffer size must be a multiple of 64-bits");
        }
        for (let i = 0; i < len; i += 8) {
          swap(this, i, i + 7);
          swap(this, i + 1, i + 6);
          swap(this, i + 2, i + 5);
          swap(this, i + 3, i + 4);
        }
        return this;
      };
      Buffer4.prototype.toString = function toString() {
        const length = this.length;
        if (length === 0) return "";
        if (arguments.length === 0) return utf8Slice(this, 0, length);
        return slowToString.apply(this, arguments);
      };
      Buffer4.prototype.toLocaleString = Buffer4.prototype.toString;
      Buffer4.prototype.equals = function equals(b) {
        if (!Buffer4.isBuffer(b)) throw new TypeError("Argument must be a Buffer");
        if (this === b) return true;
        return Buffer4.compare(this, b) === 0;
      };
      Buffer4.prototype.inspect = function inspect() {
        let str = "";
        const max2 = exports.INSPECT_MAX_BYTES;
        str = this.toString("hex", 0, max2).replace(/(.{2})/g, "$1 ").trim();
        if (this.length > max2) str += " ... ";
        return "<Buffer " + str + ">";
      };
      if (customInspectSymbol) {
        Buffer4.prototype[customInspectSymbol] = Buffer4.prototype.inspect;
      }
      Buffer4.prototype.compare = function compare(target, start, end, thisStart, thisEnd) {
        if (isInstance(target, Uint8Array)) {
          target = Buffer4.from(target, target.offset, target.byteLength);
        }
        if (!Buffer4.isBuffer(target)) {
          throw new TypeError(
            'The "target" argument must be one of type Buffer or Uint8Array. Received type ' + typeof target
          );
        }
        if (start === void 0) {
          start = 0;
        }
        if (end === void 0) {
          end = target ? target.length : 0;
        }
        if (thisStart === void 0) {
          thisStart = 0;
        }
        if (thisEnd === void 0) {
          thisEnd = this.length;
        }
        if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
          throw new RangeError("out of range index");
        }
        if (thisStart >= thisEnd && start >= end) {
          return 0;
        }
        if (thisStart >= thisEnd) {
          return -1;
        }
        if (start >= end) {
          return 1;
        }
        start >>>= 0;
        end >>>= 0;
        thisStart >>>= 0;
        thisEnd >>>= 0;
        if (this === target) return 0;
        let x = thisEnd - thisStart;
        let y = end - start;
        const len = Math.min(x, y);
        const thisCopy = this.slice(thisStart, thisEnd);
        const targetCopy = target.slice(start, end);
        for (let i = 0; i < len; ++i) {
          if (thisCopy[i] !== targetCopy[i]) {
            x = thisCopy[i];
            y = targetCopy[i];
            break;
          }
        }
        if (x < y) return -1;
        if (y < x) return 1;
        return 0;
      };
      function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
        if (buffer.length === 0) return -1;
        if (typeof byteOffset === "string") {
          encoding = byteOffset;
          byteOffset = 0;
        } else if (byteOffset > 2147483647) {
          byteOffset = 2147483647;
        } else if (byteOffset < -2147483648) {
          byteOffset = -2147483648;
        }
        byteOffset = +byteOffset;
        if (numberIsNaN(byteOffset)) {
          byteOffset = dir ? 0 : buffer.length - 1;
        }
        if (byteOffset < 0) byteOffset = buffer.length + byteOffset;
        if (byteOffset >= buffer.length) {
          if (dir) return -1;
          else byteOffset = buffer.length - 1;
        } else if (byteOffset < 0) {
          if (dir) byteOffset = 0;
          else return -1;
        }
        if (typeof val === "string") {
          val = Buffer4.from(val, encoding);
        }
        if (Buffer4.isBuffer(val)) {
          if (val.length === 0) {
            return -1;
          }
          return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
        } else if (typeof val === "number") {
          val = val & 255;
          if (typeof Uint8Array.prototype.indexOf === "function") {
            if (dir) {
              return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
            } else {
              return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
            }
          }
          return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
        }
        throw new TypeError("val must be string, number or Buffer");
      }
      function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
        let indexSize = 1;
        let arrLength = arr.length;
        let valLength = val.length;
        if (encoding !== void 0) {
          encoding = String(encoding).toLowerCase();
          if (encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
            if (arr.length < 2 || val.length < 2) {
              return -1;
            }
            indexSize = 2;
            arrLength /= 2;
            valLength /= 2;
            byteOffset /= 2;
          }
        }
        function read(buf, i2) {
          if (indexSize === 1) {
            return buf[i2];
          } else {
            return buf.readUInt16BE(i2 * indexSize);
          }
        }
        let i;
        if (dir) {
          let foundIndex = -1;
          for (i = byteOffset; i < arrLength; i++) {
            if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
              if (foundIndex === -1) foundIndex = i;
              if (i - foundIndex + 1 === valLength) return foundIndex * indexSize;
            } else {
              if (foundIndex !== -1) i -= i - foundIndex;
              foundIndex = -1;
            }
          }
        } else {
          if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength;
          for (i = byteOffset; i >= 0; i--) {
            let found = true;
            for (let j = 0; j < valLength; j++) {
              if (read(arr, i + j) !== read(val, j)) {
                found = false;
                break;
              }
            }
            if (found) return i;
          }
        }
        return -1;
      }
      Buffer4.prototype.includes = function includes(val, byteOffset, encoding) {
        return this.indexOf(val, byteOffset, encoding) !== -1;
      };
      Buffer4.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
        return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
      };
      Buffer4.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
        return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
      };
      function hexWrite(buf, string, offset, length) {
        offset = Number(offset) || 0;
        const remaining = buf.length - offset;
        if (!length) {
          length = remaining;
        } else {
          length = Number(length);
          if (length > remaining) {
            length = remaining;
          }
        }
        const strLen = string.length;
        if (length > strLen / 2) {
          length = strLen / 2;
        }
        let i;
        for (i = 0; i < length; ++i) {
          const parsed = parseInt(string.substr(i * 2, 2), 16);
          if (numberIsNaN(parsed)) return i;
          buf[offset + i] = parsed;
        }
        return i;
      }
      function utf8Write(buf, string, offset, length) {
        return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
      }
      function asciiWrite(buf, string, offset, length) {
        return blitBuffer(asciiToBytes(string), buf, offset, length);
      }
      function base64Write(buf, string, offset, length) {
        return blitBuffer(base64ToBytes(string), buf, offset, length);
      }
      function ucs2Write(buf, string, offset, length) {
        return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
      }
      Buffer4.prototype.write = function write(string, offset, length, encoding) {
        if (offset === void 0) {
          encoding = "utf8";
          length = this.length;
          offset = 0;
        } else if (length === void 0 && typeof offset === "string") {
          encoding = offset;
          length = this.length;
          offset = 0;
        } else if (isFinite(offset)) {
          offset = offset >>> 0;
          if (isFinite(length)) {
            length = length >>> 0;
            if (encoding === void 0) encoding = "utf8";
          } else {
            encoding = length;
            length = void 0;
          }
        } else {
          throw new Error(
            "Buffer.write(string, encoding, offset[, length]) is no longer supported"
          );
        }
        const remaining = this.length - offset;
        if (length === void 0 || length > remaining) length = remaining;
        if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length) {
          throw new RangeError("Attempt to write outside buffer bounds");
        }
        if (!encoding) encoding = "utf8";
        let loweredCase = false;
        for (; ; ) {
          switch (encoding) {
            case "hex":
              return hexWrite(this, string, offset, length);
            case "utf8":
            case "utf-8":
              return utf8Write(this, string, offset, length);
            case "ascii":
            case "latin1":
            case "binary":
              return asciiWrite(this, string, offset, length);
            case "base64":
              return base64Write(this, string, offset, length);
            case "ucs2":
            case "ucs-2":
            case "utf16le":
            case "utf-16le":
              return ucs2Write(this, string, offset, length);
            default:
              if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
              encoding = ("" + encoding).toLowerCase();
              loweredCase = true;
          }
        }
      };
      Buffer4.prototype.toJSON = function toJSON() {
        return {
          type: "Buffer",
          data: Array.prototype.slice.call(this._arr || this, 0)
        };
      };
      function base64Slice(buf, start, end) {
        if (start === 0 && end === buf.length) {
          return base64.fromByteArray(buf);
        } else {
          return base64.fromByteArray(buf.slice(start, end));
        }
      }
      function utf8Slice(buf, start, end) {
        end = Math.min(buf.length, end);
        const res = [];
        let i = start;
        while (i < end) {
          const firstByte = buf[i];
          let codePoint = null;
          let bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
          if (i + bytesPerSequence <= end) {
            let secondByte, thirdByte, fourthByte, tempCodePoint;
            switch (bytesPerSequence) {
              case 1:
                if (firstByte < 128) {
                  codePoint = firstByte;
                }
                break;
              case 2:
                secondByte = buf[i + 1];
                if ((secondByte & 192) === 128) {
                  tempCodePoint = (firstByte & 31) << 6 | secondByte & 63;
                  if (tempCodePoint > 127) {
                    codePoint = tempCodePoint;
                  }
                }
                break;
              case 3:
                secondByte = buf[i + 1];
                thirdByte = buf[i + 2];
                if ((secondByte & 192) === 128 && (thirdByte & 192) === 128) {
                  tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63;
                  if (tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343)) {
                    codePoint = tempCodePoint;
                  }
                }
                break;
              case 4:
                secondByte = buf[i + 1];
                thirdByte = buf[i + 2];
                fourthByte = buf[i + 3];
                if ((secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
                  tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63;
                  if (tempCodePoint > 65535 && tempCodePoint < 1114112) {
                    codePoint = tempCodePoint;
                  }
                }
            }
          }
          if (codePoint === null) {
            codePoint = 65533;
            bytesPerSequence = 1;
          } else if (codePoint > 65535) {
            codePoint -= 65536;
            res.push(codePoint >>> 10 & 1023 | 55296);
            codePoint = 56320 | codePoint & 1023;
          }
          res.push(codePoint);
          i += bytesPerSequence;
        }
        return decodeCodePointsArray(res);
      }
      var MAX_ARGUMENTS_LENGTH = 4096;
      function decodeCodePointsArray(codePoints) {
        const len = codePoints.length;
        if (len <= MAX_ARGUMENTS_LENGTH) {
          return String.fromCharCode.apply(String, codePoints);
        }
        let res = "";
        let i = 0;
        while (i < len) {
          res += String.fromCharCode.apply(
            String,
            codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
          );
        }
        return res;
      }
      function asciiSlice(buf, start, end) {
        let ret = "";
        end = Math.min(buf.length, end);
        for (let i = start; i < end; ++i) {
          ret += String.fromCharCode(buf[i] & 127);
        }
        return ret;
      }
      function latin1Slice(buf, start, end) {
        let ret = "";
        end = Math.min(buf.length, end);
        for (let i = start; i < end; ++i) {
          ret += String.fromCharCode(buf[i]);
        }
        return ret;
      }
      function hexSlice(buf, start, end) {
        const len = buf.length;
        if (!start || start < 0) start = 0;
        if (!end || end < 0 || end > len) end = len;
        let out = "";
        for (let i = start; i < end; ++i) {
          out += hexSliceLookupTable[buf[i]];
        }
        return out;
      }
      function utf16leSlice(buf, start, end) {
        const bytes = buf.slice(start, end);
        let res = "";
        for (let i = 0; i < bytes.length - 1; i += 2) {
          res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
        }
        return res;
      }
      Buffer4.prototype.slice = function slice(start, end) {
        const len = this.length;
        start = ~~start;
        end = end === void 0 ? len : ~~end;
        if (start < 0) {
          start += len;
          if (start < 0) start = 0;
        } else if (start > len) {
          start = len;
        }
        if (end < 0) {
          end += len;
          if (end < 0) end = 0;
        } else if (end > len) {
          end = len;
        }
        if (end < start) end = start;
        const newBuf = this.subarray(start, end);
        Object.setPrototypeOf(newBuf, Buffer4.prototype);
        return newBuf;
      };
      function checkOffset(offset, ext, length) {
        if (offset % 1 !== 0 || offset < 0) throw new RangeError("offset is not uint");
        if (offset + ext > length) throw new RangeError("Trying to access beyond buffer length");
      }
      Buffer4.prototype.readUintLE = Buffer4.prototype.readUIntLE = function readUIntLE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) checkOffset(offset, byteLength2, this.length);
        let val = this[offset];
        let mul = 1;
        let i = 0;
        while (++i < byteLength2 && (mul *= 256)) {
          val += this[offset + i] * mul;
        }
        return val;
      };
      Buffer4.prototype.readUintBE = Buffer4.prototype.readUIntBE = function readUIntBE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) {
          checkOffset(offset, byteLength2, this.length);
        }
        let val = this[offset + --byteLength2];
        let mul = 1;
        while (byteLength2 > 0 && (mul *= 256)) {
          val += this[offset + --byteLength2] * mul;
        }
        return val;
      };
      Buffer4.prototype.readUint8 = Buffer4.prototype.readUInt8 = function readUInt8(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 1, this.length);
        return this[offset];
      };
      Buffer4.prototype.readUint16LE = Buffer4.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        return this[offset] | this[offset + 1] << 8;
      };
      Buffer4.prototype.readUint16BE = Buffer4.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        return this[offset] << 8 | this[offset + 1];
      };
      Buffer4.prototype.readUint32LE = Buffer4.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
      };
      Buffer4.prototype.readUint32BE = Buffer4.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
      };
      Buffer4.prototype.readBigUInt64LE = defineBigIntMethod(function readBigUInt64LE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const lo = first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24;
        const hi = this[++offset] + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + last * 2 ** 24;
        return BigInt(lo) + (BigInt(hi) << BigInt(32));
      });
      Buffer4.prototype.readBigUInt64BE = defineBigIntMethod(function readBigUInt64BE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const hi = first * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
        const lo = this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last;
        return (BigInt(hi) << BigInt(32)) + BigInt(lo);
      });
      Buffer4.prototype.readIntLE = function readIntLE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) checkOffset(offset, byteLength2, this.length);
        let val = this[offset];
        let mul = 1;
        let i = 0;
        while (++i < byteLength2 && (mul *= 256)) {
          val += this[offset + i] * mul;
        }
        mul *= 128;
        if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
        return val;
      };
      Buffer4.prototype.readIntBE = function readIntBE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) checkOffset(offset, byteLength2, this.length);
        let i = byteLength2;
        let mul = 1;
        let val = this[offset + --i];
        while (i > 0 && (mul *= 256)) {
          val += this[offset + --i] * mul;
        }
        mul *= 128;
        if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
        return val;
      };
      Buffer4.prototype.readInt8 = function readInt8(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 1, this.length);
        if (!(this[offset] & 128)) return this[offset];
        return (255 - this[offset] + 1) * -1;
      };
      Buffer4.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        const val = this[offset] | this[offset + 1] << 8;
        return val & 32768 ? val | 4294901760 : val;
      };
      Buffer4.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        const val = this[offset + 1] | this[offset] << 8;
        return val & 32768 ? val | 4294901760 : val;
      };
      Buffer4.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
      };
      Buffer4.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
      };
      Buffer4.prototype.readBigInt64LE = defineBigIntMethod(function readBigInt64LE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const val = this[offset + 4] + this[offset + 5] * 2 ** 8 + this[offset + 6] * 2 ** 16 + (last << 24);
        return (BigInt(val) << BigInt(32)) + BigInt(first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24);
      });
      Buffer4.prototype.readBigInt64BE = defineBigIntMethod(function readBigInt64BE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const val = (first << 24) + // Overflow
        this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
        return (BigInt(val) << BigInt(32)) + BigInt(this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last);
      });
      Buffer4.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return ieee754.read(this, offset, true, 23, 4);
      };
      Buffer4.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return ieee754.read(this, offset, false, 23, 4);
      };
      Buffer4.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 8, this.length);
        return ieee754.read(this, offset, true, 52, 8);
      };
      Buffer4.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 8, this.length);
        return ieee754.read(this, offset, false, 52, 8);
      };
      function checkInt(buf, value, offset, ext, max2, min) {
        if (!Buffer4.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance');
        if (value > max2 || value < min) throw new RangeError('"value" argument is out of bounds');
        if (offset + ext > buf.length) throw new RangeError("Index out of range");
      }
      Buffer4.prototype.writeUintLE = Buffer4.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) {
          const maxBytes = Math.pow(2, 8 * byteLength2) - 1;
          checkInt(this, value, offset, byteLength2, maxBytes, 0);
        }
        let mul = 1;
        let i = 0;
        this[offset] = value & 255;
        while (++i < byteLength2 && (mul *= 256)) {
          this[offset + i] = value / mul & 255;
        }
        return offset + byteLength2;
      };
      Buffer4.prototype.writeUintBE = Buffer4.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) {
          const maxBytes = Math.pow(2, 8 * byteLength2) - 1;
          checkInt(this, value, offset, byteLength2, maxBytes, 0);
        }
        let i = byteLength2 - 1;
        let mul = 1;
        this[offset + i] = value & 255;
        while (--i >= 0 && (mul *= 256)) {
          this[offset + i] = value / mul & 255;
        }
        return offset + byteLength2;
      };
      Buffer4.prototype.writeUint8 = Buffer4.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 1, 255, 0);
        this[offset] = value & 255;
        return offset + 1;
      };
      Buffer4.prototype.writeUint16LE = Buffer4.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
        this[offset] = value & 255;
        this[offset + 1] = value >>> 8;
        return offset + 2;
      };
      Buffer4.prototype.writeUint16BE = Buffer4.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
        this[offset] = value >>> 8;
        this[offset + 1] = value & 255;
        return offset + 2;
      };
      Buffer4.prototype.writeUint32LE = Buffer4.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
        this[offset + 3] = value >>> 24;
        this[offset + 2] = value >>> 16;
        this[offset + 1] = value >>> 8;
        this[offset] = value & 255;
        return offset + 4;
      };
      Buffer4.prototype.writeUint32BE = Buffer4.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
        this[offset] = value >>> 24;
        this[offset + 1] = value >>> 16;
        this[offset + 2] = value >>> 8;
        this[offset + 3] = value & 255;
        return offset + 4;
      };
      function wrtBigUInt64LE(buf, value, offset, min, max2) {
        checkIntBI(value, min, max2, buf, offset, 7);
        let lo = Number(value & BigInt(4294967295));
        buf[offset++] = lo;
        lo = lo >> 8;
        buf[offset++] = lo;
        lo = lo >> 8;
        buf[offset++] = lo;
        lo = lo >> 8;
        buf[offset++] = lo;
        let hi = Number(value >> BigInt(32) & BigInt(4294967295));
        buf[offset++] = hi;
        hi = hi >> 8;
        buf[offset++] = hi;
        hi = hi >> 8;
        buf[offset++] = hi;
        hi = hi >> 8;
        buf[offset++] = hi;
        return offset;
      }
      function wrtBigUInt64BE(buf, value, offset, min, max2) {
        checkIntBI(value, min, max2, buf, offset, 7);
        let lo = Number(value & BigInt(4294967295));
        buf[offset + 7] = lo;
        lo = lo >> 8;
        buf[offset + 6] = lo;
        lo = lo >> 8;
        buf[offset + 5] = lo;
        lo = lo >> 8;
        buf[offset + 4] = lo;
        let hi = Number(value >> BigInt(32) & BigInt(4294967295));
        buf[offset + 3] = hi;
        hi = hi >> 8;
        buf[offset + 2] = hi;
        hi = hi >> 8;
        buf[offset + 1] = hi;
        hi = hi >> 8;
        buf[offset] = hi;
        return offset + 8;
      }
      Buffer4.prototype.writeBigUInt64LE = defineBigIntMethod(function writeBigUInt64LE(value, offset = 0) {
        return wrtBigUInt64LE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
      });
      Buffer4.prototype.writeBigUInt64BE = defineBigIntMethod(function writeBigUInt64BE(value, offset = 0) {
        return wrtBigUInt64BE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
      });
      Buffer4.prototype.writeIntLE = function writeIntLE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          const limit = Math.pow(2, 8 * byteLength2 - 1);
          checkInt(this, value, offset, byteLength2, limit - 1, -limit);
        }
        let i = 0;
        let mul = 1;
        let sub = 0;
        this[offset] = value & 255;
        while (++i < byteLength2 && (mul *= 256)) {
          if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
            sub = 1;
          }
          this[offset + i] = (value / mul >> 0) - sub & 255;
        }
        return offset + byteLength2;
      };
      Buffer4.prototype.writeIntBE = function writeIntBE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          const limit = Math.pow(2, 8 * byteLength2 - 1);
          checkInt(this, value, offset, byteLength2, limit - 1, -limit);
        }
        let i = byteLength2 - 1;
        let mul = 1;
        let sub = 0;
        this[offset + i] = value & 255;
        while (--i >= 0 && (mul *= 256)) {
          if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
            sub = 1;
          }
          this[offset + i] = (value / mul >> 0) - sub & 255;
        }
        return offset + byteLength2;
      };
      Buffer4.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 1, 127, -128);
        if (value < 0) value = 255 + value + 1;
        this[offset] = value & 255;
        return offset + 1;
      };
      Buffer4.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
        this[offset] = value & 255;
        this[offset + 1] = value >>> 8;
        return offset + 2;
      };
      Buffer4.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
        this[offset] = value >>> 8;
        this[offset + 1] = value & 255;
        return offset + 2;
      };
      Buffer4.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
        this[offset] = value & 255;
        this[offset + 1] = value >>> 8;
        this[offset + 2] = value >>> 16;
        this[offset + 3] = value >>> 24;
        return offset + 4;
      };
      Buffer4.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
        if (value < 0) value = 4294967295 + value + 1;
        this[offset] = value >>> 24;
        this[offset + 1] = value >>> 16;
        this[offset + 2] = value >>> 8;
        this[offset + 3] = value & 255;
        return offset + 4;
      };
      Buffer4.prototype.writeBigInt64LE = defineBigIntMethod(function writeBigInt64LE(value, offset = 0) {
        return wrtBigUInt64LE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
      });
      Buffer4.prototype.writeBigInt64BE = defineBigIntMethod(function writeBigInt64BE(value, offset = 0) {
        return wrtBigUInt64BE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
      });
      function checkIEEE754(buf, value, offset, ext, max2, min) {
        if (offset + ext > buf.length) throw new RangeError("Index out of range");
        if (offset < 0) throw new RangeError("Index out of range");
      }
      function writeFloat(buf, value, offset, littleEndian, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          checkIEEE754(buf, value, offset, 4, 34028234663852886e22, -34028234663852886e22);
        }
        ieee754.write(buf, value, offset, littleEndian, 23, 4);
        return offset + 4;
      }
      Buffer4.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
        return writeFloat(this, value, offset, true, noAssert);
      };
      Buffer4.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
        return writeFloat(this, value, offset, false, noAssert);
      };
      function writeDouble(buf, value, offset, littleEndian, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          checkIEEE754(buf, value, offset, 8, 17976931348623157e292, -17976931348623157e292);
        }
        ieee754.write(buf, value, offset, littleEndian, 52, 8);
        return offset + 8;
      }
      Buffer4.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
        return writeDouble(this, value, offset, true, noAssert);
      };
      Buffer4.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
        return writeDouble(this, value, offset, false, noAssert);
      };
      Buffer4.prototype.copy = function copy2(target, targetStart, start, end) {
        if (!Buffer4.isBuffer(target)) throw new TypeError("argument should be a Buffer");
        if (!start) start = 0;
        if (!end && end !== 0) end = this.length;
        if (targetStart >= target.length) targetStart = target.length;
        if (!targetStart) targetStart = 0;
        if (end > 0 && end < start) end = start;
        if (end === start) return 0;
        if (target.length === 0 || this.length === 0) return 0;
        if (targetStart < 0) {
          throw new RangeError("targetStart out of bounds");
        }
        if (start < 0 || start >= this.length) throw new RangeError("Index out of range");
        if (end < 0) throw new RangeError("sourceEnd out of bounds");
        if (end > this.length) end = this.length;
        if (target.length - targetStart < end - start) {
          end = target.length - targetStart + start;
        }
        const len = end - start;
        if (this === target && typeof Uint8Array.prototype.copyWithin === "function") {
          this.copyWithin(targetStart, start, end);
        } else {
          Uint8Array.prototype.set.call(
            target,
            this.subarray(start, end),
            targetStart
          );
        }
        return len;
      };
      Buffer4.prototype.fill = function fill(val, start, end, encoding) {
        if (typeof val === "string") {
          if (typeof start === "string") {
            encoding = start;
            start = 0;
            end = this.length;
          } else if (typeof end === "string") {
            encoding = end;
            end = this.length;
          }
          if (encoding !== void 0 && typeof encoding !== "string") {
            throw new TypeError("encoding must be a string");
          }
          if (typeof encoding === "string" && !Buffer4.isEncoding(encoding)) {
            throw new TypeError("Unknown encoding: " + encoding);
          }
          if (val.length === 1) {
            const code = val.charCodeAt(0);
            if (encoding === "utf8" && code < 128 || encoding === "latin1") {
              val = code;
            }
          }
        } else if (typeof val === "number") {
          val = val & 255;
        } else if (typeof val === "boolean") {
          val = Number(val);
        }
        if (start < 0 || this.length < start || this.length < end) {
          throw new RangeError("Out of range index");
        }
        if (end <= start) {
          return this;
        }
        start = start >>> 0;
        end = end === void 0 ? this.length : end >>> 0;
        if (!val) val = 0;
        let i;
        if (typeof val === "number") {
          for (i = start; i < end; ++i) {
            this[i] = val;
          }
        } else {
          const bytes = Buffer4.isBuffer(val) ? val : Buffer4.from(val, encoding);
          const len = bytes.length;
          if (len === 0) {
            throw new TypeError('The value "' + val + '" is invalid for argument "value"');
          }
          for (i = 0; i < end - start; ++i) {
            this[i + start] = bytes[i % len];
          }
        }
        return this;
      };
      var errors = {};
      function E(sym, getMessage, Base) {
        errors[sym] = class NodeError extends Base {
          constructor() {
            super();
            Object.defineProperty(this, "message", {
              value: getMessage.apply(this, arguments),
              writable: true,
              configurable: true
            });
            this.name = `${this.name} [${sym}]`;
            this.stack;
            delete this.name;
          }
          get code() {
            return sym;
          }
          set code(value) {
            Object.defineProperty(this, "code", {
              configurable: true,
              enumerable: true,
              value,
              writable: true
            });
          }
          toString() {
            return `${this.name} [${sym}]: ${this.message}`;
          }
        };
      }
      E(
        "ERR_BUFFER_OUT_OF_BOUNDS",
        function(name) {
          if (name) {
            return `${name} is outside of buffer bounds`;
          }
          return "Attempt to access memory outside buffer bounds";
        },
        RangeError
      );
      E(
        "ERR_INVALID_ARG_TYPE",
        function(name, actual) {
          return `The "${name}" argument must be of type number. Received type ${typeof actual}`;
        },
        TypeError
      );
      E(
        "ERR_OUT_OF_RANGE",
        function(str, range, input) {
          let msg = `The value of "${str}" is out of range.`;
          let received = input;
          if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
            received = addNumericalSeparator(String(input));
          } else if (typeof input === "bigint") {
            received = String(input);
            if (input > BigInt(2) ** BigInt(32) || input < -(BigInt(2) ** BigInt(32))) {
              received = addNumericalSeparator(received);
            }
            received += "n";
          }
          msg += ` It must be ${range}. Received ${received}`;
          return msg;
        },
        RangeError
      );
      function addNumericalSeparator(val) {
        let res = "";
        let i = val.length;
        const start = val[0] === "-" ? 1 : 0;
        for (; i >= start + 4; i -= 3) {
          res = `_${val.slice(i - 3, i)}${res}`;
        }
        return `${val.slice(0, i)}${res}`;
      }
      function checkBounds(buf, offset, byteLength2) {
        validateNumber(offset, "offset");
        if (buf[offset] === void 0 || buf[offset + byteLength2] === void 0) {
          boundsError(offset, buf.length - (byteLength2 + 1));
        }
      }
      function checkIntBI(value, min, max2, buf, offset, byteLength2) {
        if (value > max2 || value < min) {
          const n = typeof min === "bigint" ? "n" : "";
          let range;
          if (byteLength2 > 3) {
            if (min === 0 || min === BigInt(0)) {
              range = `>= 0${n} and < 2${n} ** ${(byteLength2 + 1) * 8}${n}`;
            } else {
              range = `>= -(2${n} ** ${(byteLength2 + 1) * 8 - 1}${n}) and < 2 ** ${(byteLength2 + 1) * 8 - 1}${n}`;
            }
          } else {
            range = `>= ${min}${n} and <= ${max2}${n}`;
          }
          throw new errors.ERR_OUT_OF_RANGE("value", range, value);
        }
        checkBounds(buf, offset, byteLength2);
      }
      function validateNumber(value, name) {
        if (typeof value !== "number") {
          throw new errors.ERR_INVALID_ARG_TYPE(name, "number", value);
        }
      }
      function boundsError(value, length, type) {
        if (Math.floor(value) !== value) {
          validateNumber(value, type);
          throw new errors.ERR_OUT_OF_RANGE(type || "offset", "an integer", value);
        }
        if (length < 0) {
          throw new errors.ERR_BUFFER_OUT_OF_BOUNDS();
        }
        throw new errors.ERR_OUT_OF_RANGE(
          type || "offset",
          `>= ${type ? 1 : 0} and <= ${length}`,
          value
        );
      }
      var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
      function base64clean(str) {
        str = str.split("=")[0];
        str = str.trim().replace(INVALID_BASE64_RE, "");
        if (str.length < 2) return "";
        while (str.length % 4 !== 0) {
          str = str + "=";
        }
        return str;
      }
      function utf8ToBytes(string, units) {
        units = units || Infinity;
        let codePoint;
        const length = string.length;
        let leadSurrogate = null;
        const bytes = [];
        for (let i = 0; i < length; ++i) {
          codePoint = string.charCodeAt(i);
          if (codePoint > 55295 && codePoint < 57344) {
            if (!leadSurrogate) {
              if (codePoint > 56319) {
                if ((units -= 3) > -1) bytes.push(239, 191, 189);
                continue;
              } else if (i + 1 === length) {
                if ((units -= 3) > -1) bytes.push(239, 191, 189);
                continue;
              }
              leadSurrogate = codePoint;
              continue;
            }
            if (codePoint < 56320) {
              if ((units -= 3) > -1) bytes.push(239, 191, 189);
              leadSurrogate = codePoint;
              continue;
            }
            codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
          } else if (leadSurrogate) {
            if ((units -= 3) > -1) bytes.push(239, 191, 189);
          }
          leadSurrogate = null;
          if (codePoint < 128) {
            if ((units -= 1) < 0) break;
            bytes.push(codePoint);
          } else if (codePoint < 2048) {
            if ((units -= 2) < 0) break;
            bytes.push(
              codePoint >> 6 | 192,
              codePoint & 63 | 128
            );
          } else if (codePoint < 65536) {
            if ((units -= 3) < 0) break;
            bytes.push(
              codePoint >> 12 | 224,
              codePoint >> 6 & 63 | 128,
              codePoint & 63 | 128
            );
          } else if (codePoint < 1114112) {
            if ((units -= 4) < 0) break;
            bytes.push(
              codePoint >> 18 | 240,
              codePoint >> 12 & 63 | 128,
              codePoint >> 6 & 63 | 128,
              codePoint & 63 | 128
            );
          } else {
            throw new Error("Invalid code point");
          }
        }
        return bytes;
      }
      function asciiToBytes(str) {
        const byteArray = [];
        for (let i = 0; i < str.length; ++i) {
          byteArray.push(str.charCodeAt(i) & 255);
        }
        return byteArray;
      }
      function utf16leToBytes(str, units) {
        let c, hi, lo;
        const byteArray = [];
        for (let i = 0; i < str.length; ++i) {
          if ((units -= 2) < 0) break;
          c = str.charCodeAt(i);
          hi = c >> 8;
          lo = c % 256;
          byteArray.push(lo);
          byteArray.push(hi);
        }
        return byteArray;
      }
      function base64ToBytes(str) {
        return base64.toByteArray(base64clean(str));
      }
      function blitBuffer(src, dst, offset, length) {
        let i;
        for (i = 0; i < length; ++i) {
          if (i + offset >= dst.length || i >= src.length) break;
          dst[i + offset] = src[i];
        }
        return i;
      }
      function isInstance(obj, type) {
        return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
      }
      function numberIsNaN(obj) {
        return obj !== obj;
      }
      var hexSliceLookupTable = (function() {
        const alphabet = "0123456789abcdef";
        const table = new Array(256);
        for (let i = 0; i < 16; ++i) {
          const i16 = i * 16;
          for (let j = 0; j < 16; ++j) {
            table[i16 + j] = alphabet[i] + alphabet[j];
          }
        }
        return table;
      })();
      function defineBigIntMethod(fn) {
        return typeof BigInt === "undefined" ? BufferBigIntNotDefined : fn;
      }
      function BufferBigIntNotDefined() {
        throw new Error("BigInt not supported");
      }
    }
  });

  // inject-buffer.js
  var import_buffer;
  var init_inject_buffer = __esm({
    "inject-buffer.js"() {
      import_buffer = __toESM(require_buffer(), 1);
      globalThis.Buffer = import_buffer.Buffer;
    }
  });

  // node_modules/nexrad-level-2-data/src/classes/RandomAccessFile.js
  var require_RandomAccessFile = __commonJS({
    "node_modules/nexrad-level-2-data/src/classes/RandomAccessFile.js"(exports, module) {
      init_inject_buffer();
      var BIG_ENDIAN = 0;
      var LITTLE_ENDIAN = 1;
      var RandomAccessFile = class {
        /**
         * Store a buffer or string and add functionality for random access
         * Unless otherwise noted all read functions advance the file's pointer by the length of the data read
         *
         * @param {Buffer|string} file A file as a string or Buffer to load for random access
         * @param {number} endian Endianess of the file constants BIG_ENDIAN and LITTLE_ENDIAN are provided
         */
        constructor(file, endian = BIG_ENDIAN) {
          this.offset = 0;
          this.buffer = null;
          if (endian < 0) return;
          this.bigEndian = endian === BIG_ENDIAN;
          if (typeof file === "string") {
            this.buffer = Buffer.from(file, "binary");
          } else {
            this.buffer = file;
          }
          if (this.bigEndian) {
            this.readFloatLocal = this.buffer.readFloatBE.bind(this.buffer);
            this.readIntLocal = this.buffer.readUIntBE.bind(this.buffer);
            this.readSignedIntLocal = this.buffer.readIntBE.bind(this.buffer);
          } else {
            this.readFloatLocal = this.buffer.readFloatLE.bind(this.buffer);
            this.readIntLocal = this.buffer.readUIntLE.bind(this.buffer);
            this.readSignedIntLocal = this.buffer.readIntLE.bind(this.buffer);
          }
        }
        /**
         * Get buffer length
         *
         * @category Positioning
         * @returns {number}
         */
        getLength() {
          return this.buffer.length;
        }
        /**
         * Get current position in the file
         *
         * @category Positioning
         * @returns {number}
         */
        getPos() {
          return this.offset;
        }
        /**
         * Seek to a provided buffer offset
         *
         * @category Positioning
         * @param {number} position Byte offset
         */
        seek(position) {
          this.offset = position;
        }
        /**
         * Read a string of a specificed length from the buffer
         *
         * @category Data
         * @param {number} length Length of string to read
         * @returns {string}
         */
        readString(length) {
          const data = this.buffer.toString("utf-8", this.offset, this.offset += length);
          return data;
        }
        /**
         * Read a float from the buffer
         *
         * @category Data
         * @returns {number}
         */
        readFloat() {
          const float = this.readFloatLocal(this.offset);
          this.offset += 4;
          return float;
        }
        /**
         * Read a 4-byte unsigned integer from the buffer
         *
         * @category Data
         * @returns {number}
         */
        readInt() {
          const int = this.readIntLocal(this.offset, 4);
          this.offset += 4;
          return int;
        }
        /**
         * Read a 4-byte signed integer from the buffer
         *
         * @category Data
         * @returns {number}
         */
        readSInt4() {
          const int = this.readSignedIntLocal(this.offset, 4);
          this.offset += 4;
          return int;
        }
        /**
         * Read a 2-byte unsigned integer from the buffer
         *
         * @category Data
         * @returns {number}
         */
        readShort() {
          const short = this.readIntLocal(this.offset, 2);
          this.offset += 2;
          return short;
        }
        /**
         * Read a 2-byte signed integer from the buffer
         *
         * @category Data
         * @returns {number}
         */
        readSignedInt() {
          const short = this.readSignedIntLocal(this.offset, 2);
          this.offset += 2;
          return short;
        }
        /**
         * Read a single byte from the buffer
         *
         * @category Data
         * @returns {number}
         */
        readByte() {
          return this.read();
        }
        // read a set number of bytes from the buffer
        /**
         * Read a set number of bytes from the buffer
         *
         * @category Data
         * @param {number} length Number of bytes to read
         * @returns {number|number[]} number if length = 1, otherwise number[]
         */
        read(length = 1) {
          let data = null;
          if (length > 1) {
            data = this.buffer.slice(this.offset, this.offset + length);
            this.offset += length;
          } else {
            data = this.buffer[this.offset];
            this.offset += 1;
          }
          return data;
        }
        /**
         * Advance the pointer forward a set number of bytes
         *
         * @category Positioning
         * @param {number} length Number of bytes to skip
         */
        skip(length) {
          this.offset += length;
        }
      };
      module.exports.RandomAccessFile = RandomAccessFile;
      module.exports.BIG_ENDIAN = BIG_ENDIAN;
      module.exports.LITTLE_ENDIAN = LITTLE_ENDIAN;
    }
  });

  // node_modules/nexrad-level-2-data/src/constants.js
  var require_constants = __commonJS({
    "node_modules/nexrad-level-2-data/src/constants.js"(exports, module) {
      init_inject_buffer();
      var FILE_HEADER_SIZE = 24;
      var RADAR_DATA_SIZE = 2432;
      var CTM_HEADER_SIZE = 12;
      var MESSAGE_HEADER_SIZE = 28;
      module.exports = {
        FILE_HEADER_SIZE,
        RADAR_DATA_SIZE,
        CTM_HEADER_SIZE,
        MESSAGE_HEADER_SIZE
      };
    }
  });

  // node_modules/nexrad-level-2-data/src/classes/Level2Record-1.js
  var require_Level2Record_1 = __commonJS({
    "node_modules/nexrad-level-2-data/src/classes/Level2Record-1.js"(exports, module) {
      init_inject_buffer();
      module.exports = (raf, message, options) => {
        const startingOffset = raf.getPos();
        message.record = {
          mseconds: raf.readInt(),
          julian_date: raf.readShort(),
          unambiguous_range: raf.readShort() / 10,
          azimuth: raf.readShort() / 8 * 0.043945,
          azimuth_number: raf.readShort(),
          radial_status: raf.readShort(),
          elevation_angle: raf.readShort() / 8 * 0.043945,
          elevation_number: raf.readShort(),
          surveillance_range: raf.readSignedInt() / 1e3,
          doppler_range: raf.readSignedInt() / 1e3,
          surveillance_range_sample_interval: raf.readSignedInt() / 1e3,
          doppler_range_sample_interval: raf.readSignedInt() / 1e3,
          number_of_surveillance_bins: raf.readShort(),
          number_of_doppler_bins: raf.readShort(),
          cut_sector_number: raf.readShort(),
          calibration_constant: raf.readFloat(),
          surveillance_pointer: raf.readShort(),
          velocity_pointer: raf.readShort(),
          spectral_width_pointer: raf.readShort(),
          doppler_velocity_resolution: raf.readShort() * 0.25,
          vcp: raf.readShort(),
          spare1: raf.read(8),
          spare2: raf.readShort(),
          spare3: raf.readShort(),
          spare4: raf.readShort(),
          nyquist_velocity: raf.readShort() / 100,
          atoms: raf.readShort() / 1e3,
          tover: raf.readShort() / 10,
          radial_spot_blanking_status: raf.readShort(),
          spare5: raf.read(32)
        };
        if (message.record.surveillance_pointer > 0) {
          raf.seek(startingOffset + message.record.surveillance_pointer);
          try {
            if (raf.getPos() > raf.getLength()) throw new Error("Message Type 1: Invalid surveillance (reflectivity) offset");
            if (raf.getPos() + message.record.number_of_surveillance_bins >= raf.getLength()) throw new Error("Message Type 1: Invalid surveillance (reflectivity) length");
            const reflectivity = [];
            for (let i = 0; i < message.record.number_of_surveillance_bins; i += 1) {
              const bin = raf.read();
              if (bin >= 2) {
                reflectivity.push(bin / 2 - 33);
              } else {
                reflectivity.push(null);
              }
            }
            message.record.reflect = reflectivity;
          } catch (e) {
            options.logger.warn(e.message);
          }
        }
        if (message.record.velocity_pointer > 0) {
          raf.seek(startingOffset + message.record.velocity_pointer);
          try {
            if (raf.getPos() > raf.getLength()) throw new Error("Message Type 1: Invalid doppler (velocity) offset");
            if (raf.getPos() + message.record.number_of_doppler_bins >= raf.getLength()) throw new Error("Message Type 1: Invalid doppler (velocity) length");
            const velocity = [];
            for (let i = 0; i < message.record.number_of_doppler_bins; i += 1) {
              const bin = raf.read();
              if (bin >= 2) {
                velocity.push((bin - 127) * message.record.doppler_velocity_resolution);
              } else {
                velocity.push(null);
              }
            }
            message.record.velocity = velocity;
          } catch (e) {
            options.logger.warn(e.message);
          }
        }
        if (message.record.spectral_width_pointer > 0) {
          raf.skip(message.record.spare4);
        }
        return message;
      };
    }
  });

  // node_modules/nexrad-level-2-data/src/classes/Level2Record-2.js
  var require_Level2Record_2 = __commonJS({
    "node_modules/nexrad-level-2-data/src/classes/Level2Record-2.js"(exports, module) {
      init_inject_buffer();
      module.exports = (raf, message) => {
        message.record = {
          rdaStatus: raf.readShort(),
          operabilityStatus: raf.readShort(),
          controlStatus: raf.readShort(),
          auxiliaryPowerGeneratorState: raf.readShort(),
          averageTransmitterPower: raf.readShort(),
          horizontalReflectivityCalibrationCorrection: raf.readSignedInt() / 100,
          dataTransmissionEnabled: raf.readShort(),
          volumeCoveragePatternNumber: raf.readSignedInt(),
          rdaControlAuthorization: raf.readShort(),
          rdaBuildNumber: buildNumber(raf.readSignedInt()),
          operationalMode: raf.readShort(),
          superResolutionStatus: raf.readShort(),
          clutterMitigationDecisionStatus: raf.readShort(),
          avsetStatus: raf.readShort(),
          rdaAlarmSummary: raf.readShort(),
          commandAcknowledgement: raf.readShort(),
          channelControlStatus: raf.readShort(),
          spotBlankingStatus: raf.readShort(),
          bypassMapGenerationDate: raf.readInt(),
          bypassMapGenerationTime: raf.readInt(),
          clutterFilterMapGenerationDate: raf.readInt(),
          clutterFilterMapGenerationTime: raf.readInt(),
          verticalReflectivyCalibrationCorrection: raf.readSignedInt() / 100,
          transmitterPowerSourceStatus: raf.readShort(),
          rmsControlStatus: raf.readShort(),
          performanceCheckStatus: raf.readShort(),
          alarmCodes: alarmCodes(raf),
          signalProcessingOptions: raf.readShort(),
          spares: raf.read(36),
          statusVersion: raf.readInt()
        };
        return message;
      };
      var buildNumber = (raw) => {
        if (raw / 100 > 2) return raw / 100;
        return raw / 10;
      };
      var alarmCodes = (raf) => {
        const alarms = [];
        for (let i = 0; i < 14; i += 1) {
          alarms.push(raf.readShort());
        }
        return alarms;
      };
    }
  });

  // node_modules/nexrad-level-2-data/src/classes/Level2Record-31.js
  var require_Level2Record_31 = __commonJS({
    "node_modules/nexrad-level-2-data/src/classes/Level2Record-31.js"(exports, module) {
      init_inject_buffer();
      var { MESSAGE_HEADER_SIZE } = require_constants();
      module.exports = (raf, message, offset, options) => {
        const record = {
          id: raf.readString(4),
          mseconds: raf.readInt(),
          julian_date: raf.readShort(),
          radial_number: raf.readShort(),
          azimuth: raf.readFloat(),
          compress_idx: raf.readByte(),
          sp: raf.readByte(),
          radial_length: raf.readShort(),
          ars: raf.readByte(),
          rs: raf.readByte(),
          elevation_number: raf.readByte(),
          cut: raf.readByte(),
          elevation_angle: raf.readFloat(),
          rsbs: raf.readByte(),
          aim: raf.readByte(),
          dcount: raf.readShort()
        };
        try {
          if (!record.id.match(/[A-Z]{4}/)) throw new Error(`Invalid record id: ${record.id}`);
          if (record.mseconds > 86401e3) throw new Error(`Invalid timestamp (ms): ${record.mseconds}`);
        } catch (e) {
          options.logger.warn(e.message);
          return message;
        }
        message.record = record;
        const dbp = [];
        for (let i = 0; i < 9; i += 1) {
          const pointer = raf.readInt();
          if (i < message.record.dcount) dbp.push(pointer);
        }
        const blockTypesFriendly = {
          VOL: "volume",
          ELE: "elevation",
          RAD: "radial",
          REF: "reflect",
          VEL: "velocity",
          "SW ": "spectrum",
          // intentional space to fill 3-character requirement
          ZDR: "zdr",
          PHI: "phi",
          RHO: "rho"
        };
        const messageSizeBytes = message.message_size * 2;
        let prevRecord = false;
        let prevBlockStart = 0;
        for (let i = 0; i < dbp.length; i += 1) {
          const parserStartPos = dbp[i] + offset + MESSAGE_HEADER_SIZE;
          raf.seek(parserStartPos);
          try {
            const { name } = blockName(raf);
            if (prevRecord && blockTypesFriendly[prevRecord.name]) {
              message.record[blockTypesFriendly[prevRecord.name]] = prevRecord;
            }
            prevRecord = false;
            if (dbp[i] < messageSizeBytes) {
              let thisRecord = false;
              switch (name) {
                case "VOL":
                  thisRecord = parseVolumeData(raf);
                  break;
                case "ELV":
                  thisRecord = parseElevationData(raf);
                  break;
                case "RAD":
                  thisRecord = parseRadialData(raf);
                  break;
                default:
                  thisRecord = parseMomentData(raf);
              }
              prevRecord = thisRecord;
            } else {
              throw new Error(`Block overruns file at ${raf.getPos()}`);
            }
            prevBlockStart = parserStartPos;
          } catch (e) {
            options.logger.warn(e.message);
            prevRecord = false;
            message.endedEarly = prevBlockStart;
            break;
          }
        }
        if (prevRecord && blockTypesFriendly[prevRecord.name]) {
          message.record[blockTypesFriendly[prevRecord.name]] = prevRecord;
        }
        return message;
      };
      var parseVolumeData = (raf) => ({
        block_type: raf.readString(1),
        name: raf.readString(3),
        size: raf.readShort(),
        version_major: raf.read(),
        version_minor: raf.read(),
        latitude: raf.readFloat(),
        longitude: raf.readFloat(),
        elevation: raf.readShort(),
        feedhorn_height: raf.readShort(),
        calibration: raf.readFloat(),
        tx_horizontal: raf.readFloat(),
        tx_vertical: raf.readFloat(),
        differential_reflectivity: raf.readFloat(),
        differential_phase: raf.readFloat(),
        volume_coverage_pattern: raf.readShort(),
        processing_status: raf.readShort(),
        zdr_bias_estimate: raf.readShort()
      });
      var parseElevationData = (raf) => ({
        block_type: raf.readString(1),
        name: raf.readString(3),
        size: raf.readShort(),
        atmos: raf.readShort(),
        calibration: raf.readFloat()
      });
      var parseRadialData = (raf) => ({
        block_type: raf.readString(1),
        name: raf.readString(3),
        size: raf.readShort(),
        unambiguous_range: raf.readShort() / 10,
        horizontal_noise_level: raf.readFloat(),
        vertical_noise_level: raf.readFloat(),
        nyquist_velocity: raf.readShort(),
        radial_flags: raf.readShort(),
        horizontal_calibration: raf.readFloat(),
        vertical_calibration: raf.readFloat()
      });
      var parseMomentData = (raf) => {
        const data = {
          block_type: raf.readString(1),
          name: raf.readString(3),
          spare: raf.read(4),
          gate_count: raf.readShort(),
          first_gate: raf.readShort() / 1e3,
          // scale int to float 0.001 precision
          gate_size: raf.readShort() / 1e3,
          // scale int to float 0.001 precision
          rf_threshold: raf.readShort() / 10,
          // scale int to float 0.1 precision
          snr_threshold: raf.readShort() / 1e3,
          // scale int to float 0.001 precision
          control_flags: raf.read(),
          data_size: raf.read(),
          scale: raf.readFloat(),
          offset: raf.readFloat(),
          moment_data: []
        };
        let getDataBlock = raf.read.bind(raf);
        let inc = 1;
        if (data.data_size === 16) {
          getDataBlock = raf.readShort.bind(raf);
          inc = 2;
        }
        const endI = data.gate_count * inc;
        for (let i = 0; i < endI; i += inc) {
          const val = getDataBlock();
          if (val >= 2) {
            data.moment_data.push((val - data.offset) / data.scale);
          } else {
            data.moment_data.push(null);
          }
        }
        return data;
      };
      var blockName = (raf) => {
        const type = raf.readString(1);
        const name = raf.readString(3);
        raf.skip(-4);
        if (!(type === "D" || type === "R")) {
          throw new Error(`Invalid data block type: 0x${(type.charCodeAt(0) || 0).toString(16).padStart(2, "0")} at ${raf.getPos()}`);
        }
        return { name, type };
      };
    }
  });

  // node_modules/nexrad-level-2-data/src/classes/Level2Record-5-7.js
  var require_Level2Record_5_7 = __commonJS({
    "node_modules/nexrad-level-2-data/src/classes/Level2Record-5-7.js"(exports, module) {
      init_inject_buffer();
      module.exports = (raf, message) => {
        message.record = {
          message_size: raf.readShort(),
          pattern_type: raf.readShort(),
          pattern_number: raf.readShort(),
          num_elevations: raf.readShort(),
          version: raf.readByte(),
          clutter_number: raf.readByte(),
          velocity_resolution: velocityResolution(raf.readByte()),
          pulse_width: pulseWidth(raf.readByte()),
          reserved1: raf.readInt(),
          vcp_sequencing: vcpSequencing(raf.readShort()),
          vcp_supplemental: vcpSupplemental(raf.readShort()),
          reserved2: raf.readShort()
        };
        message.record.elevations = [];
        for (let i = 1; i <= message.record.num_elevations; i += 1) {
          const elev = {
            elevation_angle: parse360Angle(raf.readShort()),
            channel_config: raf.readByte(),
            waveform_type: raf.readByte(),
            super_res_control: superResControl(raf.readByte()),
            surv_prf_number: raf.readByte(),
            surv_prf_pulse: raf.readShort(),
            azimuth_rate: azimuthRate(raf.readShort()),
            ref_threshold: raf.readShort(),
            vel_threshold: raf.readShort(),
            sw_threshold: raf.readShort(),
            diff_ref_threshold: raf.readShort(),
            diff_ph_threshold: raf.readShort(),
            cor_coeff_threshold: raf.readShort(),
            edge_angle_s1: parse360Angle(raf.readShort()),
            prf_num_s1: raf.readShort(),
            prf_pulse_s1: raf.readShort(),
            supplemental_data: supplementalData(raf.readShort()),
            edge_angle_s2: parse360Angle(raf.readShort()),
            prf_num_s2: raf.readShort(),
            prf_pulse_s2: raf.readShort(),
            ebc_angle: parse360Angle(raf.readShort()),
            edge_angle_s3: parse360Angle(raf.readShort()),
            prf_num_s3: raf.readShort(),
            prf_pulse_s3: raf.readShort(),
            reserved: raf.readShort()
          };
          message.record.elevations[i] = elev;
        }
        return message;
      };
      var parseBits = (raw, start, end) => {
        if (end !== void 0) {
          let val = 0;
          for (let i = start; i <= end; i += 1) {
            if (raw & 2 ** i) val += 2 ** (i - start);
          }
          return val;
        }
        return (raw & 2 ** start) > 0;
      };
      var parse360Angle = (raw) => {
        let angle = 0;
        for (let i = 15; i >= 3; i -= 1) {
          if (parseBits(raw, i)) angle += 180 / 2 ** (15 - i);
        }
        return angle;
      };
      var velocityResolution = (raw) => {
        if (raw === 2) return 0.5;
        return 1;
      };
      var pulseWidth = (raw) => {
        if (raw === 2) return "short";
        return "Long";
      };
      var vcpSequencing = (raw) => ({
        elevations: parseBits(raw, 0, 4),
        max_sails_cuts: parseBits(raw, 5, 6),
        sequence_active: parseBits(raw, 13),
        truncated_vcp: parseBits(raw, 14)
      });
      var vcpSupplemental = (raw) => ({
        sails_vcp: parseBits(raw, 0),
        number_sails_cuts: parseBits(raw, 1, 3),
        mrle_vcp: parseBits(raw, 4),
        number_mrle_cuts: parseBits(raw, 5, 7),
        mpda_vcp: parseBits(raw, 11),
        base_tilt_vcp: parseBits(raw, 12),
        number_base_tilts: parseBits(raw, 13, 15)
      });
      var superResControl = (raw) => ({
        super_res: {
          halfDegreeAzimuth: parseBits(raw, 0),
          quarterKm: parseBits(raw, 1),
          "300km": parseBits(raw, 2)
        },
        dual_pol: {
          "300km": parseBits(raw, 3)
        }
      });
      var azimuthRate = (raw) => {
        let rate = 0;
        for (let i = 14; i >= 3; i -= 1) {
          if (parseBits(raw, i)) rate += 22.5 / 2 ** (14 - i);
        }
        if (parseBits(raw, 15)) rate = -rate;
        return rate;
      };
      var supplementalData = (raw) => ({
        sails_cut: parseBits(raw, 0),
        sails_sequence: parseBits(raw, 1, 3),
        mrle_cut: parseBits(raw, 4),
        mrle_sequence: parseBits(raw, 5, 7),
        mpda_cut: parseBits(raw, 9),
        base_tilt_cut: parseBits(raw, 10)
      });
    }
  });

  // node_modules/nexrad-level-2-data/src/classes/Level2RecordSearch.js
  var require_Level2RecordSearch = __commonJS({
    "node_modules/nexrad-level-2-data/src/classes/Level2RecordSearch.js"(exports, module) {
      init_inject_buffer();
      var level2RecordSearch = (raf, startPos, julianDate, options) => {
        if (julianDate === void 0) return false;
        raf.seek(startPos);
        const result = search(raf, julianDate, options);
        if (result) return result;
        raf.seek(startPos);
        return search(raf, julianDate + 1, options);
      };
      var search = (raf, date, options) => {
        const endOfFile = raf.buffer.length - 10;
        const found = false;
        while (!found && raf.getPos() < endOfFile) {
          let skipBack = 2;
          if (raf.readShort() === date) {
            raf.skip(4);
            skipBack += 8;
            if (raf.readShort() === 1 && raf.readShort() === 1) {
              const foundAt = raf.getPos() - skipBack - 6;
              options.logger.warn(`Found next block at ${foundAt}`);
              return foundAt;
            }
            raf.skip(-skipBack);
          }
        }
        return false;
      };
      module.exports = {
        level2RecordSearch
      };
    }
  });

  // node_modules/nexrad-level-2-data/src/classes/Level2Record.js
  var require_Level2Record = __commonJS({
    "node_modules/nexrad-level-2-data/src/classes/Level2Record.js"(exports, module) {
      init_inject_buffer();
      var {
        FILE_HEADER_SIZE,
        RADAR_DATA_SIZE,
        CTM_HEADER_SIZE
      } = require_constants();
      var parseMessage1 = require_Level2Record_1();
      var parseMessage2 = require_Level2Record_2();
      var parseMessage31 = require_Level2Record_31();
      var parseMessage5 = require_Level2Record_5_7();
      var { level2RecordSearch } = require_Level2RecordSearch();
      var Level2Record = (raf, record, message31Offset, header, options) => {
        let headerSize = 0;
        if (header?.ICAO) headerSize = FILE_HEADER_SIZE;
        const recordOffset = record * RADAR_DATA_SIZE + headerSize + message31Offset;
        if (recordOffset >= raf.getLength()) return { finished: true };
        const message = getRecord(raf, recordOffset, options);
        if (!message.endedEarly) return message;
        const nextRecordPos = level2RecordSearch(raf, message.endedEarly, header?.modified_julian_date, options);
        if (nextRecordPos === false) {
          throw new Error(`Unable to recover message at ${recordOffset}`);
        }
        message.actual_size = (nextRecordPos - recordOffset) / 2 - CTM_HEADER_SIZE;
        return message;
      };
      var getRecord = (raf, recordOffset, options) => {
        raf.seek(recordOffset);
        raf.skip(CTM_HEADER_SIZE);
        const message = {
          message_size: raf.readShort(),
          channel: raf.readByte(),
          message_type: raf.readByte(),
          id_sequence: raf.readShort(),
          message_julian_date: raf.readShort(),
          message_mseconds: raf.readInt(),
          segment_count: raf.readShort(),
          segment_number: raf.readShort()
        };
        switch (message.message_type) {
          case 31:
            return parseMessage31(raf, message, recordOffset, options);
          case 1:
            return parseMessage1(raf, message, options);
          case 2:
            return parseMessage2(raf, message);
          case 5:
          case 7:
            return parseMessage5(raf, message);
          default:
            return false;
        }
      };
      module.exports.Level2Record = Level2Record;
    }
  });

  // node_modules/seek-bzip/lib/bitreader.js
  var require_bitreader = __commonJS({
    "node_modules/seek-bzip/lib/bitreader.js"(exports, module) {
      init_inject_buffer();
      var BITMASK = [0, 1, 3, 7, 15, 31, 63, 127, 255];
      var BitReader = function(stream) {
        this.stream = stream;
        this.bitOffset = 0;
        this.curByte = 0;
        this.hasByte = false;
      };
      BitReader.prototype._ensureByte = function() {
        if (!this.hasByte) {
          this.curByte = this.stream.readByte();
          this.hasByte = true;
        }
      };
      BitReader.prototype.read = function(bits) {
        var result = 0;
        while (bits > 0) {
          this._ensureByte();
          var remaining = 8 - this.bitOffset;
          if (bits >= remaining) {
            result <<= remaining;
            result |= BITMASK[remaining] & this.curByte;
            this.hasByte = false;
            this.bitOffset = 0;
            bits -= remaining;
          } else {
            result <<= bits;
            var shift = remaining - bits;
            result |= (this.curByte & BITMASK[bits] << shift) >> shift;
            this.bitOffset += bits;
            bits = 0;
          }
        }
        return result;
      };
      BitReader.prototype.seek = function(pos) {
        var n_bit = pos % 8;
        var n_byte = (pos - n_bit) / 8;
        this.bitOffset = n_bit;
        this.stream.seek(n_byte);
        this.hasByte = false;
      };
      BitReader.prototype.pi = function() {
        var buf = new Buffer(6), i;
        for (i = 0; i < buf.length; i++) {
          buf[i] = this.read(8);
        }
        return buf.toString("hex");
      };
      module.exports = BitReader;
    }
  });

  // node_modules/seek-bzip/lib/stream.js
  var require_stream = __commonJS({
    "node_modules/seek-bzip/lib/stream.js"(exports, module) {
      init_inject_buffer();
      var Stream = function() {
      };
      Stream.prototype.readByte = function() {
        throw new Error("abstract method readByte() not implemented");
      };
      Stream.prototype.read = function(buffer, bufOffset, length) {
        var bytesRead = 0;
        while (bytesRead < length) {
          var c = this.readByte();
          if (c < 0) {
            return bytesRead === 0 ? -1 : bytesRead;
          }
          buffer[bufOffset++] = c;
          bytesRead++;
        }
        return bytesRead;
      };
      Stream.prototype.seek = function(new_pos) {
        throw new Error("abstract method seek() not implemented");
      };
      Stream.prototype.writeByte = function(_byte) {
        throw new Error("abstract method readByte() not implemented");
      };
      Stream.prototype.write = function(buffer, bufOffset, length) {
        var i;
        for (i = 0; i < length; i++) {
          this.writeByte(buffer[bufOffset++]);
        }
        return length;
      };
      Stream.prototype.flush = function() {
      };
      module.exports = Stream;
    }
  });

  // node_modules/seek-bzip/lib/crc32.js
  var require_crc32 = __commonJS({
    "node_modules/seek-bzip/lib/crc32.js"(exports, module) {
      init_inject_buffer();
      module.exports = (function() {
        var crc32Lookup = new Uint32Array([
          0,
          79764919,
          159529838,
          222504665,
          319059676,
          398814059,
          445009330,
          507990021,
          638119352,
          583659535,
          797628118,
          726387553,
          890018660,
          835552979,
          1015980042,
          944750013,
          1276238704,
          1221641927,
          1167319070,
          1095957929,
          1595256236,
          1540665371,
          1452775106,
          1381403509,
          1780037320,
          1859660671,
          1671105958,
          1733955601,
          2031960084,
          2111593891,
          1889500026,
          1952343757,
          2552477408,
          2632100695,
          2443283854,
          2506133561,
          2334638140,
          2414271883,
          2191915858,
          2254759653,
          3190512472,
          3135915759,
          3081330742,
          3009969537,
          2905550212,
          2850959411,
          2762807018,
          2691435357,
          3560074640,
          3505614887,
          3719321342,
          3648080713,
          3342211916,
          3287746299,
          3467911202,
          3396681109,
          4063920168,
          4143685023,
          4223187782,
          4286162673,
          3779000052,
          3858754371,
          3904687514,
          3967668269,
          881225847,
          809987520,
          1023691545,
          969234094,
          662832811,
          591600412,
          771767749,
          717299826,
          311336399,
          374308984,
          453813921,
          533576470,
          25881363,
          88864420,
          134795389,
          214552010,
          2023205639,
          2086057648,
          1897238633,
          1976864222,
          1804852699,
          1867694188,
          1645340341,
          1724971778,
          1587496639,
          1516133128,
          1461550545,
          1406951526,
          1302016099,
          1230646740,
          1142491917,
          1087903418,
          2896545431,
          2825181984,
          2770861561,
          2716262478,
          3215044683,
          3143675388,
          3055782693,
          3001194130,
          2326604591,
          2389456536,
          2200899649,
          2280525302,
          2578013683,
          2640855108,
          2418763421,
          2498394922,
          3769900519,
          3832873040,
          3912640137,
          3992402750,
          4088425275,
          4151408268,
          4197601365,
          4277358050,
          3334271071,
          3263032808,
          3476998961,
          3422541446,
          3585640067,
          3514407732,
          3694837229,
          3640369242,
          1762451694,
          1842216281,
          1619975040,
          1682949687,
          2047383090,
          2127137669,
          1938468188,
          2001449195,
          1325665622,
          1271206113,
          1183200824,
          1111960463,
          1543535498,
          1489069629,
          1434599652,
          1363369299,
          622672798,
          568075817,
          748617968,
          677256519,
          907627842,
          853037301,
          1067152940,
          995781531,
          51762726,
          131386257,
          177728840,
          240578815,
          269590778,
          349224269,
          429104020,
          491947555,
          4046411278,
          4126034873,
          4172115296,
          4234965207,
          3794477266,
          3874110821,
          3953728444,
          4016571915,
          3609705398,
          3555108353,
          3735388376,
          3664026991,
          3290680682,
          3236090077,
          3449943556,
          3378572211,
          3174993278,
          3120533705,
          3032266256,
          2961025959,
          2923101090,
          2868635157,
          2813903052,
          2742672763,
          2604032198,
          2683796849,
          2461293480,
          2524268063,
          2284983834,
          2364738477,
          2175806836,
          2238787779,
          1569362073,
          1498123566,
          1409854455,
          1355396672,
          1317987909,
          1246755826,
          1192025387,
          1137557660,
          2072149281,
          2135122070,
          1912620623,
          1992383480,
          1753615357,
          1816598090,
          1627664531,
          1707420964,
          295390185,
          358241886,
          404320391,
          483945776,
          43990325,
          106832002,
          186451547,
          266083308,
          932423249,
          861060070,
          1041341759,
          986742920,
          613929101,
          542559546,
          756411363,
          701822548,
          3316196985,
          3244833742,
          3425377559,
          3370778784,
          3601682597,
          3530312978,
          3744426955,
          3689838204,
          3819031489,
          3881883254,
          3928223919,
          4007849240,
          4037393693,
          4100235434,
          4180117107,
          4259748804,
          2310601993,
          2373574846,
          2151335527,
          2231098320,
          2596047829,
          2659030626,
          2470359227,
          2550115596,
          2947551409,
          2876312838,
          2788305887,
          2733848168,
          3165939309,
          3094707162,
          3040238851,
          2985771188
        ]);
        var CRC32 = function() {
          var crc = 4294967295;
          this.getCRC = function() {
            return ~crc >>> 0;
          };
          this.updateCRC = function(value) {
            crc = crc << 8 ^ crc32Lookup[(crc >>> 24 ^ value) & 255];
          };
          this.updateCRCRun = function(value, count) {
            while (count-- > 0) {
              crc = crc << 8 ^ crc32Lookup[(crc >>> 24 ^ value) & 255];
            }
          };
        };
        return CRC32;
      })();
    }
  });

  // node_modules/seek-bzip/package.json
  var require_package = __commonJS({
    "node_modules/seek-bzip/package.json"(exports, module) {
      module.exports = {
        name: "seek-bzip",
        version: "2.0.0",
        contributors: [
          "C. Scott Ananian (http://cscott.net)",
          "Eli Skeggs",
          "Kevin Kwok",
          "Rob Landley (http://landley.net)"
        ],
        description: "a pure-JavaScript Node.JS module for random-access decoding bzip2 data",
        main: "./lib/index.js",
        repository: {
          type: "git",
          url: "https://github.com/cscott/seek-bzip.git"
        },
        license: "MIT",
        bin: {
          "seek-bunzip": "./bin/seek-bunzip",
          "seek-table": "./bin/seek-bzip-table"
        },
        directories: {
          test: "test"
        },
        dependencies: {
          commander: "^6.0.0"
        },
        devDependencies: {
          fibers: "^5.0.0",
          mocha: "^8.1.0"
        },
        scripts: {
          test: "mocha"
        }
      };
    }
  });

  // node_modules/seek-bzip/lib/index.js
  var require_lib = __commonJS({
    "node_modules/seek-bzip/lib/index.js"(exports, module) {
      init_inject_buffer();
      var BitReader = require_bitreader();
      var Stream = require_stream();
      var CRC32 = require_crc32();
      var pjson = require_package();
      var MAX_HUFCODE_BITS = 20;
      var MAX_SYMBOLS = 258;
      var SYMBOL_RUNA = 0;
      var SYMBOL_RUNB = 1;
      var MIN_GROUPS = 2;
      var MAX_GROUPS = 6;
      var GROUP_SIZE = 50;
      var WHOLEPI = "314159265359";
      var SQRTPI = "177245385090";
      var mtf = function(array, index) {
        var src = array[index], i;
        for (i = index; i > 0; i--) {
          array[i] = array[i - 1];
        }
        array[0] = src;
        return src;
      };
      var Err = {
        OK: 0,
        LAST_BLOCK: -1,
        NOT_BZIP_DATA: -2,
        UNEXPECTED_INPUT_EOF: -3,
        UNEXPECTED_OUTPUT_EOF: -4,
        DATA_ERROR: -5,
        OUT_OF_MEMORY: -6,
        OBSOLETE_INPUT: -7,
        END_OF_BLOCK: -8
      };
      var ErrorMessages = {};
      ErrorMessages[Err.LAST_BLOCK] = "Bad file checksum";
      ErrorMessages[Err.NOT_BZIP_DATA] = "Not bzip data";
      ErrorMessages[Err.UNEXPECTED_INPUT_EOF] = "Unexpected input EOF";
      ErrorMessages[Err.UNEXPECTED_OUTPUT_EOF] = "Unexpected output EOF";
      ErrorMessages[Err.DATA_ERROR] = "Data error";
      ErrorMessages[Err.OUT_OF_MEMORY] = "Out of memory";
      ErrorMessages[Err.OBSOLETE_INPUT] = "Obsolete (pre 0.9.5) bzip format not supported.";
      var _throw = function(status, optDetail) {
        var msg = ErrorMessages[status] || "unknown error";
        if (optDetail) {
          msg += ": " + optDetail;
        }
        var e = new TypeError(msg);
        e.errorCode = status;
        throw e;
      };
      var Bunzip = function(inputStream, outputStream) {
        this.writePos = this.writeCurrent = this.writeCount = 0;
        this._start_bunzip(inputStream, outputStream);
      };
      Bunzip.prototype._init_block = function() {
        var moreBlocks = this._get_next_block();
        if (!moreBlocks) {
          this.writeCount = -1;
          return false;
        }
        this.blockCRC = new CRC32();
        return true;
      };
      Bunzip.prototype._start_bunzip = function(inputStream, outputStream) {
        var buf = new Buffer(4);
        if (inputStream.read(buf, 0, 4) !== 4 || String.fromCharCode(buf[0], buf[1], buf[2]) !== "BZh")
          _throw(Err.NOT_BZIP_DATA, "bad magic");
        var level = buf[3] - 48;
        if (level < 1 || level > 9)
          _throw(Err.NOT_BZIP_DATA, "level out of range");
        this.reader = new BitReader(inputStream);
        this.dbufSize = 1e5 * level;
        this.nextoutput = 0;
        this.outputStream = outputStream;
        this.streamCRC = 0;
      };
      Bunzip.prototype._get_next_block = function() {
        var i, j, k;
        var reader = this.reader;
        var h = reader.pi();
        if (h === SQRTPI) {
          return false;
        }
        if (h !== WHOLEPI)
          _throw(Err.NOT_BZIP_DATA);
        this.targetBlockCRC = reader.read(32) >>> 0;
        this.streamCRC = (this.targetBlockCRC ^ (this.streamCRC << 1 | this.streamCRC >>> 31)) >>> 0;
        if (reader.read(1))
          _throw(Err.OBSOLETE_INPUT);
        var origPointer = reader.read(24);
        if (origPointer > this.dbufSize)
          _throw(Err.DATA_ERROR, "initial position out of bounds");
        var t = reader.read(16);
        var symToByte = new Buffer(256), symTotal = 0;
        for (i = 0; i < 16; i++) {
          if (t & 1 << 15 - i) {
            var o = i * 16;
            k = reader.read(16);
            for (j = 0; j < 16; j++)
              if (k & 1 << 15 - j)
                symToByte[symTotal++] = o + j;
          }
        }
        var groupCount = reader.read(3);
        if (groupCount < MIN_GROUPS || groupCount > MAX_GROUPS)
          _throw(Err.DATA_ERROR);
        var nSelectors = reader.read(15);
        if (nSelectors === 0)
          _throw(Err.DATA_ERROR);
        var mtfSymbol = new Buffer(256);
        for (i = 0; i < groupCount; i++)
          mtfSymbol[i] = i;
        var selectors = new Buffer(nSelectors);
        for (i = 0; i < nSelectors; i++) {
          for (j = 0; reader.read(1); j++)
            if (j >= groupCount) _throw(Err.DATA_ERROR);
          selectors[i] = mtf(mtfSymbol, j);
        }
        var symCount = symTotal + 2;
        var groups = [], hufGroup;
        for (j = 0; j < groupCount; j++) {
          var length = new Buffer(symCount), temp = new Uint16Array(MAX_HUFCODE_BITS + 1);
          t = reader.read(5);
          for (i = 0; i < symCount; i++) {
            for (; ; ) {
              if (t < 1 || t > MAX_HUFCODE_BITS) _throw(Err.DATA_ERROR);
              if (!reader.read(1))
                break;
              if (!reader.read(1))
                t++;
              else
                t--;
            }
            length[i] = t;
          }
          var minLen, maxLen;
          minLen = maxLen = length[0];
          for (i = 1; i < symCount; i++) {
            if (length[i] > maxLen)
              maxLen = length[i];
            else if (length[i] < minLen)
              minLen = length[i];
          }
          hufGroup = {};
          groups.push(hufGroup);
          hufGroup.permute = new Uint16Array(MAX_SYMBOLS);
          hufGroup.limit = new Uint32Array(MAX_HUFCODE_BITS + 2);
          hufGroup.base = new Uint32Array(MAX_HUFCODE_BITS + 1);
          hufGroup.minLen = minLen;
          hufGroup.maxLen = maxLen;
          var pp = 0;
          for (i = minLen; i <= maxLen; i++) {
            temp[i] = hufGroup.limit[i] = 0;
            for (t = 0; t < symCount; t++)
              if (length[t] === i)
                hufGroup.permute[pp++] = t;
          }
          for (i = 0; i < symCount; i++)
            temp[length[i]]++;
          pp = t = 0;
          for (i = minLen; i < maxLen; i++) {
            pp += temp[i];
            hufGroup.limit[i] = pp - 1;
            pp <<= 1;
            t += temp[i];
            hufGroup.base[i + 1] = pp - t;
          }
          hufGroup.limit[maxLen + 1] = Number.MAX_VALUE;
          hufGroup.limit[maxLen] = pp + temp[maxLen] - 1;
          hufGroup.base[minLen] = 0;
        }
        var byteCount = new Uint32Array(256);
        for (i = 0; i < 256; i++)
          mtfSymbol[i] = i;
        var runPos = 0, dbufCount = 0, selector = 0, uc;
        var dbuf = this.dbuf = new Uint32Array(this.dbufSize);
        symCount = 0;
        for (; ; ) {
          if (!symCount--) {
            symCount = GROUP_SIZE - 1;
            if (selector >= nSelectors) {
              _throw(Err.DATA_ERROR);
            }
            hufGroup = groups[selectors[selector++]];
          }
          i = hufGroup.minLen;
          j = reader.read(i);
          for (; ; i++) {
            if (i > hufGroup.maxLen) {
              _throw(Err.DATA_ERROR);
            }
            if (j <= hufGroup.limit[i])
              break;
            j = j << 1 | reader.read(1);
          }
          j -= hufGroup.base[i];
          if (j < 0 || j >= MAX_SYMBOLS) {
            _throw(Err.DATA_ERROR);
          }
          var nextSym = hufGroup.permute[j];
          if (nextSym === SYMBOL_RUNA || nextSym === SYMBOL_RUNB) {
            if (!runPos) {
              runPos = 1;
              t = 0;
            }
            if (nextSym === SYMBOL_RUNA)
              t += runPos;
            else
              t += 2 * runPos;
            runPos <<= 1;
            continue;
          }
          if (runPos) {
            runPos = 0;
            if (dbufCount + t > this.dbufSize) {
              _throw(Err.DATA_ERROR);
            }
            uc = symToByte[mtfSymbol[0]];
            byteCount[uc] += t;
            while (t--)
              dbuf[dbufCount++] = uc;
          }
          if (nextSym > symTotal)
            break;
          if (dbufCount >= this.dbufSize) {
            _throw(Err.DATA_ERROR);
          }
          i = nextSym - 1;
          uc = mtf(mtfSymbol, i);
          uc = symToByte[uc];
          byteCount[uc]++;
          dbuf[dbufCount++] = uc;
        }
        if (origPointer < 0 || origPointer >= dbufCount) {
          _throw(Err.DATA_ERROR);
        }
        j = 0;
        for (i = 0; i < 256; i++) {
          k = j + byteCount[i];
          byteCount[i] = j;
          j = k;
        }
        for (i = 0; i < dbufCount; i++) {
          uc = dbuf[i] & 255;
          dbuf[byteCount[uc]] |= i << 8;
          byteCount[uc]++;
        }
        var pos = 0, current = 0, run = 0;
        if (dbufCount) {
          pos = dbuf[origPointer];
          current = pos & 255;
          pos >>= 8;
          run = -1;
        }
        this.writePos = pos;
        this.writeCurrent = current;
        this.writeCount = dbufCount;
        this.writeRun = run;
        return true;
      };
      Bunzip.prototype._read_bunzip = function(outputBuffer, len) {
        var copies, previous, outbyte;
        if (this.writeCount < 0) {
          return 0;
        }
        var gotcount = 0;
        var dbuf = this.dbuf, pos = this.writePos, current = this.writeCurrent;
        var dbufCount = this.writeCount, outputsize = this.outputsize;
        var run = this.writeRun;
        while (dbufCount) {
          dbufCount--;
          previous = current;
          pos = dbuf[pos];
          current = pos & 255;
          pos >>= 8;
          if (run++ === 3) {
            copies = current;
            outbyte = previous;
            current = -1;
          } else {
            copies = 1;
            outbyte = current;
          }
          this.blockCRC.updateCRCRun(outbyte, copies);
          while (copies--) {
            this.outputStream.writeByte(outbyte);
            this.nextoutput++;
          }
          if (current != previous)
            run = 0;
        }
        this.writeCount = dbufCount;
        if (this.blockCRC.getCRC() !== this.targetBlockCRC) {
          _throw(Err.DATA_ERROR, "Bad block CRC (got " + this.blockCRC.getCRC().toString(16) + " expected " + this.targetBlockCRC.toString(16) + ")");
        }
        return this.nextoutput;
      };
      var coerceInputStream = function(input) {
        if ("readByte" in input) {
          return input;
        }
        var inputStream = new Stream();
        inputStream.pos = 0;
        inputStream.readByte = function() {
          return input[this.pos++];
        };
        inputStream.seek = function(pos) {
          this.pos = pos;
        };
        inputStream.eof = function() {
          return this.pos >= input.length;
        };
        return inputStream;
      };
      var coerceOutputStream = function(output) {
        var outputStream = new Stream();
        var resizeOk = true;
        if (output) {
          if (typeof output === "number") {
            outputStream.buffer = new Buffer(output);
            resizeOk = false;
          } else if ("writeByte" in output) {
            return output;
          } else {
            outputStream.buffer = output;
            resizeOk = false;
          }
        } else {
          outputStream.buffer = new Buffer(16384);
        }
        outputStream.pos = 0;
        outputStream.writeByte = function(_byte) {
          if (resizeOk && this.pos >= this.buffer.length) {
            var newBuffer = new Buffer(this.buffer.length * 2);
            this.buffer.copy(newBuffer);
            this.buffer = newBuffer;
          }
          this.buffer[this.pos++] = _byte;
        };
        outputStream.getBuffer = function() {
          if (this.pos !== this.buffer.length) {
            if (!resizeOk)
              throw new TypeError("outputsize does not match decoded input");
            var newBuffer = new Buffer(this.pos);
            this.buffer.copy(newBuffer, 0, 0, this.pos);
            this.buffer = newBuffer;
          }
          return this.buffer;
        };
        outputStream._coerced = true;
        return outputStream;
      };
      Bunzip.Err = Err;
      Bunzip.decode = function(input, output, multistream) {
        var inputStream = coerceInputStream(input);
        var outputStream = coerceOutputStream(output);
        var bz = new Bunzip(inputStream, outputStream);
        while (true) {
          if ("eof" in inputStream && inputStream.eof()) break;
          if (bz._init_block()) {
            bz._read_bunzip();
          } else {
            var targetStreamCRC = bz.reader.read(32) >>> 0;
            if (targetStreamCRC !== bz.streamCRC) {
              _throw(Err.DATA_ERROR, "Bad stream CRC (got " + bz.streamCRC.toString(16) + " expected " + targetStreamCRC.toString(16) + ")");
            }
            if (multistream && "eof" in inputStream && !inputStream.eof()) {
              bz._start_bunzip(inputStream, outputStream);
            } else break;
          }
        }
        if ("getBuffer" in outputStream)
          return outputStream.getBuffer();
      };
      Bunzip.decodeBlock = function(input, pos, output) {
        var inputStream = coerceInputStream(input);
        var outputStream = coerceOutputStream(output);
        var bz = new Bunzip(inputStream, outputStream);
        bz.reader.seek(pos);
        var moreBlocks = bz._get_next_block();
        if (moreBlocks) {
          bz.blockCRC = new CRC32();
          bz.writeCopies = 0;
          bz._read_bunzip();
        }
        if ("getBuffer" in outputStream)
          return outputStream.getBuffer();
      };
      Bunzip.table = function(input, callback, multistream) {
        var inputStream = new Stream();
        inputStream.delegate = coerceInputStream(input);
        inputStream.pos = 0;
        inputStream.readByte = function() {
          this.pos++;
          return this.delegate.readByte();
        };
        if (inputStream.delegate.eof) {
          inputStream.eof = inputStream.delegate.eof.bind(inputStream.delegate);
        }
        var outputStream = new Stream();
        outputStream.pos = 0;
        outputStream.writeByte = function() {
          this.pos++;
        };
        var bz = new Bunzip(inputStream, outputStream);
        var blockSize = bz.dbufSize;
        while (true) {
          if ("eof" in inputStream && inputStream.eof()) break;
          var position = inputStream.pos * 8 + bz.reader.bitOffset;
          if (bz.reader.hasByte) {
            position -= 8;
          }
          if (bz._init_block()) {
            var start = outputStream.pos;
            bz._read_bunzip();
            callback(position, outputStream.pos - start);
          } else {
            var crc = bz.reader.read(32);
            if (multistream && "eof" in inputStream && !inputStream.eof()) {
              bz._start_bunzip(inputStream, outputStream);
              console.assert(
                bz.dbufSize === blockSize,
                "shouldn't change block size within multistream file"
              );
            } else break;
          }
        }
      };
      Bunzip.Stream = Stream;
      Bunzip.version = pjson.version;
      Bunzip.license = pjson.license;
      module.exports = Bunzip;
    }
  });

  // node_modules/pako/lib/zlib/trees.js
  var require_trees = __commonJS({
    "node_modules/pako/lib/zlib/trees.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var Z_FIXED = 4;
      var Z_BINARY = 0;
      var Z_TEXT = 1;
      var Z_UNKNOWN = 2;
      function zero(buf) {
        let len = buf.length;
        while (--len >= 0) {
          buf[len] = 0;
        }
      }
      var STORED_BLOCK = 0;
      var STATIC_TREES = 1;
      var DYN_TREES = 2;
      var MIN_MATCH = 3;
      var MAX_MATCH = 258;
      var LENGTH_CODES = 29;
      var LITERALS = 256;
      var L_CODES = LITERALS + 1 + LENGTH_CODES;
      var D_CODES = 30;
      var BL_CODES = 19;
      var HEAP_SIZE = 2 * L_CODES + 1;
      var MAX_BITS = 15;
      var Buf_size = 16;
      var MAX_BL_BITS = 7;
      var END_BLOCK = 256;
      var REP_3_6 = 16;
      var REPZ_3_10 = 17;
      var REPZ_11_138 = 18;
      var extra_lbits = (
        /* extra bits for each length code */
        new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0])
      );
      var extra_dbits = (
        /* extra bits for each distance code */
        new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13])
      );
      var extra_blbits = (
        /* extra bits for each bit length code */
        new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7])
      );
      var bl_order = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
      var DIST_CODE_LEN = 512;
      var static_ltree = new Array((L_CODES + 2) * 2);
      zero(static_ltree);
      var static_dtree = new Array(D_CODES * 2);
      zero(static_dtree);
      var _dist_code = new Array(DIST_CODE_LEN);
      zero(_dist_code);
      var _length_code = new Array(MAX_MATCH - MIN_MATCH + 1);
      zero(_length_code);
      var base_length = new Array(LENGTH_CODES);
      zero(base_length);
      var base_dist = new Array(D_CODES);
      zero(base_dist);
      function StaticTreeDesc(static_tree, extra_bits, extra_base, elems, max_length) {
        this.static_tree = static_tree;
        this.extra_bits = extra_bits;
        this.extra_base = extra_base;
        this.elems = elems;
        this.max_length = max_length;
        this.has_stree = static_tree && static_tree.length;
      }
      var static_l_desc;
      var static_d_desc;
      var static_bl_desc;
      function TreeDesc(dyn_tree, stat_desc) {
        this.dyn_tree = dyn_tree;
        this.max_code = 0;
        this.stat_desc = stat_desc;
      }
      var d_code = (dist) => {
        return dist < 256 ? _dist_code[dist] : _dist_code[256 + (dist >>> 7)];
      };
      var put_short = (s, w) => {
        s.pending_buf[s.pending++] = w & 255;
        s.pending_buf[s.pending++] = w >>> 8 & 255;
      };
      var send_bits = (s, value, length) => {
        if (s.bi_valid > Buf_size - length) {
          s.bi_buf |= value << s.bi_valid & 65535;
          put_short(s, s.bi_buf);
          s.bi_buf = value >> Buf_size - s.bi_valid;
          s.bi_valid += length - Buf_size;
        } else {
          s.bi_buf |= value << s.bi_valid & 65535;
          s.bi_valid += length;
        }
      };
      var send_code = (s, c, tree) => {
        send_bits(
          s,
          tree[c * 2],
          tree[c * 2 + 1]
          /*.Len*/
        );
      };
      var bi_reverse = (code, len) => {
        let res = 0;
        do {
          res |= code & 1;
          code >>>= 1;
          res <<= 1;
        } while (--len > 0);
        return res >>> 1;
      };
      var bi_flush = (s) => {
        if (s.bi_valid === 16) {
          put_short(s, s.bi_buf);
          s.bi_buf = 0;
          s.bi_valid = 0;
        } else if (s.bi_valid >= 8) {
          s.pending_buf[s.pending++] = s.bi_buf & 255;
          s.bi_buf >>= 8;
          s.bi_valid -= 8;
        }
      };
      var gen_bitlen = (s, desc) => {
        const tree = desc.dyn_tree;
        const max_code = desc.max_code;
        const stree = desc.stat_desc.static_tree;
        const has_stree = desc.stat_desc.has_stree;
        const extra = desc.stat_desc.extra_bits;
        const base = desc.stat_desc.extra_base;
        const max_length = desc.stat_desc.max_length;
        let h;
        let n, m;
        let bits;
        let xbits;
        let f;
        let overflow = 0;
        for (bits = 0; bits <= MAX_BITS; bits++) {
          s.bl_count[bits] = 0;
        }
        tree[s.heap[s.heap_max] * 2 + 1] = 0;
        for (h = s.heap_max + 1; h < HEAP_SIZE; h++) {
          n = s.heap[h];
          bits = tree[tree[n * 2 + 1] * 2 + 1] + 1;
          if (bits > max_length) {
            bits = max_length;
            overflow++;
          }
          tree[n * 2 + 1] = bits;
          if (n > max_code) {
            continue;
          }
          s.bl_count[bits]++;
          xbits = 0;
          if (n >= base) {
            xbits = extra[n - base];
          }
          f = tree[n * 2];
          s.opt_len += f * (bits + xbits);
          if (has_stree) {
            s.static_len += f * (stree[n * 2 + 1] + xbits);
          }
        }
        if (overflow === 0) {
          return;
        }
        do {
          bits = max_length - 1;
          while (s.bl_count[bits] === 0) {
            bits--;
          }
          s.bl_count[bits]--;
          s.bl_count[bits + 1] += 2;
          s.bl_count[max_length]--;
          overflow -= 2;
        } while (overflow > 0);
        for (bits = max_length; bits !== 0; bits--) {
          n = s.bl_count[bits];
          while (n !== 0) {
            m = s.heap[--h];
            if (m > max_code) {
              continue;
            }
            if (tree[m * 2 + 1] !== bits) {
              s.opt_len += (bits - tree[m * 2 + 1]) * tree[m * 2];
              tree[m * 2 + 1] = bits;
            }
            n--;
          }
        }
      };
      var gen_codes = (tree, max_code, bl_count) => {
        const next_code = new Array(MAX_BITS + 1);
        let code = 0;
        let bits;
        let n;
        for (bits = 1; bits <= MAX_BITS; bits++) {
          code = code + bl_count[bits - 1] << 1;
          next_code[bits] = code;
        }
        for (n = 0; n <= max_code; n++) {
          let len = tree[n * 2 + 1];
          if (len === 0) {
            continue;
          }
          tree[n * 2] = bi_reverse(next_code[len]++, len);
        }
      };
      var tr_static_init = () => {
        let n;
        let bits;
        let length;
        let code;
        let dist;
        const bl_count = new Array(MAX_BITS + 1);
        length = 0;
        for (code = 0; code < LENGTH_CODES - 1; code++) {
          base_length[code] = length;
          for (n = 0; n < 1 << extra_lbits[code]; n++) {
            _length_code[length++] = code;
          }
        }
        _length_code[length - 1] = code;
        dist = 0;
        for (code = 0; code < 16; code++) {
          base_dist[code] = dist;
          for (n = 0; n < 1 << extra_dbits[code]; n++) {
            _dist_code[dist++] = code;
          }
        }
        dist >>= 7;
        for (; code < D_CODES; code++) {
          base_dist[code] = dist << 7;
          for (n = 0; n < 1 << extra_dbits[code] - 7; n++) {
            _dist_code[256 + dist++] = code;
          }
        }
        for (bits = 0; bits <= MAX_BITS; bits++) {
          bl_count[bits] = 0;
        }
        n = 0;
        while (n <= 143) {
          static_ltree[n * 2 + 1] = 8;
          n++;
          bl_count[8]++;
        }
        while (n <= 255) {
          static_ltree[n * 2 + 1] = 9;
          n++;
          bl_count[9]++;
        }
        while (n <= 279) {
          static_ltree[n * 2 + 1] = 7;
          n++;
          bl_count[7]++;
        }
        while (n <= 287) {
          static_ltree[n * 2 + 1] = 8;
          n++;
          bl_count[8]++;
        }
        gen_codes(static_ltree, L_CODES + 1, bl_count);
        for (n = 0; n < D_CODES; n++) {
          static_dtree[n * 2 + 1] = 5;
          static_dtree[n * 2] = bi_reverse(n, 5);
        }
        static_l_desc = new StaticTreeDesc(static_ltree, extra_lbits, LITERALS + 1, L_CODES, MAX_BITS);
        static_d_desc = new StaticTreeDesc(static_dtree, extra_dbits, 0, D_CODES, MAX_BITS);
        static_bl_desc = new StaticTreeDesc(new Array(0), extra_blbits, 0, BL_CODES, MAX_BL_BITS);
      };
      var init_block = (s) => {
        let n;
        for (n = 0; n < L_CODES; n++) {
          s.dyn_ltree[n * 2] = 0;
        }
        for (n = 0; n < D_CODES; n++) {
          s.dyn_dtree[n * 2] = 0;
        }
        for (n = 0; n < BL_CODES; n++) {
          s.bl_tree[n * 2] = 0;
        }
        s.dyn_ltree[END_BLOCK * 2] = 1;
        s.opt_len = s.static_len = 0;
        s.sym_next = s.matches = 0;
      };
      var bi_windup = (s) => {
        if (s.bi_valid > 8) {
          put_short(s, s.bi_buf);
        } else if (s.bi_valid > 0) {
          s.pending_buf[s.pending++] = s.bi_buf;
        }
        s.bi_buf = 0;
        s.bi_valid = 0;
      };
      var smaller = (tree, n, m, depth) => {
        const _n2 = n * 2;
        const _m2 = m * 2;
        return tree[_n2] < tree[_m2] || tree[_n2] === tree[_m2] && depth[n] <= depth[m];
      };
      var pqdownheap = (s, tree, k) => {
        const v = s.heap[k];
        let j = k << 1;
        while (j <= s.heap_len) {
          if (j < s.heap_len && smaller(tree, s.heap[j + 1], s.heap[j], s.depth)) {
            j++;
          }
          if (smaller(tree, v, s.heap[j], s.depth)) {
            break;
          }
          s.heap[k] = s.heap[j];
          k = j;
          j <<= 1;
        }
        s.heap[k] = v;
      };
      var compress_block = (s, ltree, dtree) => {
        let dist;
        let lc;
        let sx = 0;
        let code;
        let extra;
        if (s.sym_next !== 0) {
          do {
            dist = s.pending_buf[s.sym_buf + sx++] & 255;
            dist += (s.pending_buf[s.sym_buf + sx++] & 255) << 8;
            lc = s.pending_buf[s.sym_buf + sx++];
            if (dist === 0) {
              send_code(s, lc, ltree);
            } else {
              code = _length_code[lc];
              send_code(s, code + LITERALS + 1, ltree);
              extra = extra_lbits[code];
              if (extra !== 0) {
                lc -= base_length[code];
                send_bits(s, lc, extra);
              }
              dist--;
              code = d_code(dist);
              send_code(s, code, dtree);
              extra = extra_dbits[code];
              if (extra !== 0) {
                dist -= base_dist[code];
                send_bits(s, dist, extra);
              }
            }
          } while (sx < s.sym_next);
        }
        send_code(s, END_BLOCK, ltree);
      };
      var build_tree = (s, desc) => {
        const tree = desc.dyn_tree;
        const stree = desc.stat_desc.static_tree;
        const has_stree = desc.stat_desc.has_stree;
        const elems = desc.stat_desc.elems;
        let n, m;
        let max_code = -1;
        let node;
        s.heap_len = 0;
        s.heap_max = HEAP_SIZE;
        for (n = 0; n < elems; n++) {
          if (tree[n * 2] !== 0) {
            s.heap[++s.heap_len] = max_code = n;
            s.depth[n] = 0;
          } else {
            tree[n * 2 + 1] = 0;
          }
        }
        while (s.heap_len < 2) {
          node = s.heap[++s.heap_len] = max_code < 2 ? ++max_code : 0;
          tree[node * 2] = 1;
          s.depth[node] = 0;
          s.opt_len--;
          if (has_stree) {
            s.static_len -= stree[node * 2 + 1];
          }
        }
        desc.max_code = max_code;
        for (n = s.heap_len >> 1; n >= 1; n--) {
          pqdownheap(s, tree, n);
        }
        node = elems;
        do {
          n = s.heap[
            1
            /*SMALLEST*/
          ];
          s.heap[
            1
            /*SMALLEST*/
          ] = s.heap[s.heap_len--];
          pqdownheap(
            s,
            tree,
            1
            /*SMALLEST*/
          );
          m = s.heap[
            1
            /*SMALLEST*/
          ];
          s.heap[--s.heap_max] = n;
          s.heap[--s.heap_max] = m;
          tree[node * 2] = tree[n * 2] + tree[m * 2];
          s.depth[node] = (s.depth[n] >= s.depth[m] ? s.depth[n] : s.depth[m]) + 1;
          tree[n * 2 + 1] = tree[m * 2 + 1] = node;
          s.heap[
            1
            /*SMALLEST*/
          ] = node++;
          pqdownheap(
            s,
            tree,
            1
            /*SMALLEST*/
          );
        } while (s.heap_len >= 2);
        s.heap[--s.heap_max] = s.heap[
          1
          /*SMALLEST*/
        ];
        gen_bitlen(s, desc);
        gen_codes(tree, max_code, s.bl_count);
      };
      var scan_tree = (s, tree, max_code) => {
        let n;
        let prevlen = -1;
        let curlen;
        let nextlen = tree[0 * 2 + 1];
        let count = 0;
        let max_count = 7;
        let min_count = 4;
        if (nextlen === 0) {
          max_count = 138;
          min_count = 3;
        }
        tree[(max_code + 1) * 2 + 1] = 65535;
        for (n = 0; n <= max_code; n++) {
          curlen = nextlen;
          nextlen = tree[(n + 1) * 2 + 1];
          if (++count < max_count && curlen === nextlen) {
            continue;
          } else if (count < min_count) {
            s.bl_tree[curlen * 2] += count;
          } else if (curlen !== 0) {
            if (curlen !== prevlen) {
              s.bl_tree[curlen * 2]++;
            }
            s.bl_tree[REP_3_6 * 2]++;
          } else if (count <= 10) {
            s.bl_tree[REPZ_3_10 * 2]++;
          } else {
            s.bl_tree[REPZ_11_138 * 2]++;
          }
          count = 0;
          prevlen = curlen;
          if (nextlen === 0) {
            max_count = 138;
            min_count = 3;
          } else if (curlen === nextlen) {
            max_count = 6;
            min_count = 3;
          } else {
            max_count = 7;
            min_count = 4;
          }
        }
      };
      var send_tree = (s, tree, max_code) => {
        let n;
        let prevlen = -1;
        let curlen;
        let nextlen = tree[0 * 2 + 1];
        let count = 0;
        let max_count = 7;
        let min_count = 4;
        if (nextlen === 0) {
          max_count = 138;
          min_count = 3;
        }
        for (n = 0; n <= max_code; n++) {
          curlen = nextlen;
          nextlen = tree[(n + 1) * 2 + 1];
          if (++count < max_count && curlen === nextlen) {
            continue;
          } else if (count < min_count) {
            do {
              send_code(s, curlen, s.bl_tree);
            } while (--count !== 0);
          } else if (curlen !== 0) {
            if (curlen !== prevlen) {
              send_code(s, curlen, s.bl_tree);
              count--;
            }
            send_code(s, REP_3_6, s.bl_tree);
            send_bits(s, count - 3, 2);
          } else if (count <= 10) {
            send_code(s, REPZ_3_10, s.bl_tree);
            send_bits(s, count - 3, 3);
          } else {
            send_code(s, REPZ_11_138, s.bl_tree);
            send_bits(s, count - 11, 7);
          }
          count = 0;
          prevlen = curlen;
          if (nextlen === 0) {
            max_count = 138;
            min_count = 3;
          } else if (curlen === nextlen) {
            max_count = 6;
            min_count = 3;
          } else {
            max_count = 7;
            min_count = 4;
          }
        }
      };
      var build_bl_tree = (s) => {
        let max_blindex;
        scan_tree(s, s.dyn_ltree, s.l_desc.max_code);
        scan_tree(s, s.dyn_dtree, s.d_desc.max_code);
        build_tree(s, s.bl_desc);
        for (max_blindex = BL_CODES - 1; max_blindex >= 3; max_blindex--) {
          if (s.bl_tree[bl_order[max_blindex] * 2 + 1] !== 0) {
            break;
          }
        }
        s.opt_len += 3 * (max_blindex + 1) + 5 + 5 + 4;
        return max_blindex;
      };
      var send_all_trees = (s, lcodes, dcodes, blcodes) => {
        let rank;
        send_bits(s, lcodes - 257, 5);
        send_bits(s, dcodes - 1, 5);
        send_bits(s, blcodes - 4, 4);
        for (rank = 0; rank < blcodes; rank++) {
          send_bits(s, s.bl_tree[bl_order[rank] * 2 + 1], 3);
        }
        send_tree(s, s.dyn_ltree, lcodes - 1);
        send_tree(s, s.dyn_dtree, dcodes - 1);
      };
      var detect_data_type = (s) => {
        let block_mask = 4093624447;
        let n;
        for (n = 0; n <= 31; n++, block_mask >>>= 1) {
          if (block_mask & 1 && s.dyn_ltree[n * 2] !== 0) {
            return Z_BINARY;
          }
        }
        if (s.dyn_ltree[9 * 2] !== 0 || s.dyn_ltree[10 * 2] !== 0 || s.dyn_ltree[13 * 2] !== 0) {
          return Z_TEXT;
        }
        for (n = 32; n < LITERALS; n++) {
          if (s.dyn_ltree[n * 2] !== 0) {
            return Z_TEXT;
          }
        }
        return Z_BINARY;
      };
      var static_init_done = false;
      var _tr_init = (s) => {
        if (!static_init_done) {
          tr_static_init();
          static_init_done = true;
        }
        s.l_desc = new TreeDesc(s.dyn_ltree, static_l_desc);
        s.d_desc = new TreeDesc(s.dyn_dtree, static_d_desc);
        s.bl_desc = new TreeDesc(s.bl_tree, static_bl_desc);
        s.bi_buf = 0;
        s.bi_valid = 0;
        init_block(s);
      };
      var _tr_stored_block = (s, buf, stored_len, last) => {
        send_bits(s, (STORED_BLOCK << 1) + (last ? 1 : 0), 3);
        bi_windup(s);
        put_short(s, stored_len);
        put_short(s, ~stored_len);
        if (stored_len) {
          s.pending_buf.set(s.window.subarray(buf, buf + stored_len), s.pending);
        }
        s.pending += stored_len;
      };
      var _tr_align = (s) => {
        send_bits(s, STATIC_TREES << 1, 3);
        send_code(s, END_BLOCK, static_ltree);
        bi_flush(s);
      };
      var _tr_flush_block = (s, buf, stored_len, last) => {
        let opt_lenb, static_lenb;
        let max_blindex = 0;
        if (s.level > 0) {
          if (s.strm.data_type === Z_UNKNOWN) {
            s.strm.data_type = detect_data_type(s);
          }
          build_tree(s, s.l_desc);
          build_tree(s, s.d_desc);
          max_blindex = build_bl_tree(s);
          opt_lenb = s.opt_len + 3 + 7 >>> 3;
          static_lenb = s.static_len + 3 + 7 >>> 3;
          if (static_lenb <= opt_lenb) {
            opt_lenb = static_lenb;
          }
        } else {
          opt_lenb = static_lenb = stored_len + 5;
        }
        if (stored_len + 4 <= opt_lenb && buf !== -1) {
          _tr_stored_block(s, buf, stored_len, last);
        } else if (s.strategy === Z_FIXED || static_lenb === opt_lenb) {
          send_bits(s, (STATIC_TREES << 1) + (last ? 1 : 0), 3);
          compress_block(s, static_ltree, static_dtree);
        } else {
          send_bits(s, (DYN_TREES << 1) + (last ? 1 : 0), 3);
          send_all_trees(s, s.l_desc.max_code + 1, s.d_desc.max_code + 1, max_blindex + 1);
          compress_block(s, s.dyn_ltree, s.dyn_dtree);
        }
        init_block(s);
        if (last) {
          bi_windup(s);
        }
      };
      var _tr_tally = (s, dist, lc) => {
        s.pending_buf[s.sym_buf + s.sym_next++] = dist;
        s.pending_buf[s.sym_buf + s.sym_next++] = dist >> 8;
        s.pending_buf[s.sym_buf + s.sym_next++] = lc;
        if (dist === 0) {
          s.dyn_ltree[lc * 2]++;
        } else {
          s.matches++;
          dist--;
          s.dyn_ltree[(_length_code[lc] + LITERALS + 1) * 2]++;
          s.dyn_dtree[d_code(dist) * 2]++;
        }
        return s.sym_next === s.sym_end;
      };
      module.exports._tr_init = _tr_init;
      module.exports._tr_stored_block = _tr_stored_block;
      module.exports._tr_flush_block = _tr_flush_block;
      module.exports._tr_tally = _tr_tally;
      module.exports._tr_align = _tr_align;
    }
  });

  // node_modules/pako/lib/zlib/adler32.js
  var require_adler32 = __commonJS({
    "node_modules/pako/lib/zlib/adler32.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var adler32 = (adler, buf, len, pos) => {
        let s1 = adler & 65535 | 0, s2 = adler >>> 16 & 65535 | 0, n = 0;
        while (len !== 0) {
          n = len > 2e3 ? 2e3 : len;
          len -= n;
          do {
            s1 = s1 + buf[pos++] | 0;
            s2 = s2 + s1 | 0;
          } while (--n);
          s1 %= 65521;
          s2 %= 65521;
        }
        return s1 | s2 << 16 | 0;
      };
      module.exports = adler32;
    }
  });

  // node_modules/pako/lib/zlib/crc32.js
  var require_crc322 = __commonJS({
    "node_modules/pako/lib/zlib/crc32.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var makeTable = () => {
        let c, table = [];
        for (var n = 0; n < 256; n++) {
          c = n;
          for (var k = 0; k < 8; k++) {
            c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
          }
          table[n] = c;
        }
        return table;
      };
      var crcTable = new Uint32Array(makeTable());
      var crc32 = (crc, buf, len, pos) => {
        const t = crcTable;
        const end = pos + len;
        crc ^= -1;
        for (let i = pos; i < end; i++) {
          crc = crc >>> 8 ^ t[(crc ^ buf[i]) & 255];
        }
        return crc ^ -1;
      };
      module.exports = crc32;
    }
  });

  // node_modules/pako/lib/zlib/messages.js
  var require_messages = __commonJS({
    "node_modules/pako/lib/zlib/messages.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      module.exports = {
        2: "need dictionary",
        /* Z_NEED_DICT       2  */
        1: "stream end",
        /* Z_STREAM_END      1  */
        0: "",
        /* Z_OK              0  */
        "-1": "file error",
        /* Z_ERRNO         (-1) */
        "-2": "stream error",
        /* Z_STREAM_ERROR  (-2) */
        "-3": "data error",
        /* Z_DATA_ERROR    (-3) */
        "-4": "insufficient memory",
        /* Z_MEM_ERROR     (-4) */
        "-5": "buffer error",
        /* Z_BUF_ERROR     (-5) */
        "-6": "incompatible version"
        /* Z_VERSION_ERROR (-6) */
      };
    }
  });

  // node_modules/pako/lib/zlib/constants.js
  var require_constants2 = __commonJS({
    "node_modules/pako/lib/zlib/constants.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      module.exports = {
        /* Allowed flush values; see deflate() and inflate() below for details */
        Z_NO_FLUSH: 0,
        Z_PARTIAL_FLUSH: 1,
        Z_SYNC_FLUSH: 2,
        Z_FULL_FLUSH: 3,
        Z_FINISH: 4,
        Z_BLOCK: 5,
        Z_TREES: 6,
        /* Return codes for the compression/decompression functions. Negative values
        * are errors, positive values are used for special but normal events.
        */
        Z_OK: 0,
        Z_STREAM_END: 1,
        Z_NEED_DICT: 2,
        Z_ERRNO: -1,
        Z_STREAM_ERROR: -2,
        Z_DATA_ERROR: -3,
        Z_MEM_ERROR: -4,
        Z_BUF_ERROR: -5,
        //Z_VERSION_ERROR: -6,
        /* compression levels */
        Z_NO_COMPRESSION: 0,
        Z_BEST_SPEED: 1,
        Z_BEST_COMPRESSION: 9,
        Z_DEFAULT_COMPRESSION: -1,
        Z_FILTERED: 1,
        Z_HUFFMAN_ONLY: 2,
        Z_RLE: 3,
        Z_FIXED: 4,
        Z_DEFAULT_STRATEGY: 0,
        /* Possible values of the data_type field (though see inflate()) */
        Z_BINARY: 0,
        Z_TEXT: 1,
        //Z_ASCII:                1, // = Z_TEXT (deprecated)
        Z_UNKNOWN: 2,
        /* The deflate compression method */
        Z_DEFLATED: 8
        //Z_NULL:                 null // Use -1 or null inline, depending on var type
      };
    }
  });

  // node_modules/pako/lib/zlib/deflate.js
  var require_deflate = __commonJS({
    "node_modules/pako/lib/zlib/deflate.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var { _tr_init, _tr_stored_block, _tr_flush_block, _tr_tally, _tr_align } = require_trees();
      var adler32 = require_adler32();
      var crc32 = require_crc322();
      var msg = require_messages();
      var {
        Z_NO_FLUSH,
        Z_PARTIAL_FLUSH,
        Z_FULL_FLUSH,
        Z_FINISH,
        Z_BLOCK,
        Z_OK,
        Z_STREAM_END,
        Z_STREAM_ERROR,
        Z_DATA_ERROR,
        Z_BUF_ERROR,
        Z_DEFAULT_COMPRESSION,
        Z_FILTERED,
        Z_HUFFMAN_ONLY,
        Z_RLE,
        Z_FIXED,
        Z_DEFAULT_STRATEGY,
        Z_UNKNOWN,
        Z_DEFLATED
      } = require_constants2();
      var MAX_MEM_LEVEL = 9;
      var MAX_WBITS = 15;
      var DEF_MEM_LEVEL = 8;
      var LENGTH_CODES = 29;
      var LITERALS = 256;
      var L_CODES = LITERALS + 1 + LENGTH_CODES;
      var D_CODES = 30;
      var BL_CODES = 19;
      var HEAP_SIZE = 2 * L_CODES + 1;
      var MAX_BITS = 15;
      var MIN_MATCH = 3;
      var MAX_MATCH = 258;
      var MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
      var PRESET_DICT = 32;
      var INIT_STATE = 42;
      var GZIP_STATE = 57;
      var EXTRA_STATE = 69;
      var NAME_STATE = 73;
      var COMMENT_STATE = 91;
      var HCRC_STATE = 103;
      var BUSY_STATE = 113;
      var FINISH_STATE = 666;
      var BS_NEED_MORE = 1;
      var BS_BLOCK_DONE = 2;
      var BS_FINISH_STARTED = 3;
      var BS_FINISH_DONE = 4;
      var OS_CODE = 3;
      var err = (strm, errorCode) => {
        strm.msg = msg[errorCode];
        return errorCode;
      };
      var rank = (f) => {
        return f * 2 - (f > 4 ? 9 : 0);
      };
      var zero = (buf) => {
        let len = buf.length;
        while (--len >= 0) {
          buf[len] = 0;
        }
      };
      var slide_hash = (s) => {
        let n, m;
        let p;
        let wsize = s.w_size;
        n = s.hash_size;
        p = n;
        do {
          m = s.head[--p];
          s.head[p] = m >= wsize ? m - wsize : 0;
        } while (--n);
        n = wsize;
        p = n;
        do {
          m = s.prev[--p];
          s.prev[p] = m >= wsize ? m - wsize : 0;
        } while (--n);
      };
      var HASH_ZLIB = (s, prev, data) => (prev << s.hash_shift ^ data) & s.hash_mask;
      var HASH = HASH_ZLIB;
      var flush_pending = (strm) => {
        const s = strm.state;
        let len = s.pending;
        if (len > strm.avail_out) {
          len = strm.avail_out;
        }
        if (len === 0) {
          return;
        }
        strm.output.set(s.pending_buf.subarray(s.pending_out, s.pending_out + len), strm.next_out);
        strm.next_out += len;
        s.pending_out += len;
        strm.total_out += len;
        strm.avail_out -= len;
        s.pending -= len;
        if (s.pending === 0) {
          s.pending_out = 0;
        }
      };
      var flush_block_only = (s, last) => {
        _tr_flush_block(s, s.block_start >= 0 ? s.block_start : -1, s.strstart - s.block_start, last);
        s.block_start = s.strstart;
        flush_pending(s.strm);
      };
      var put_byte = (s, b) => {
        s.pending_buf[s.pending++] = b;
      };
      var putShortMSB = (s, b) => {
        s.pending_buf[s.pending++] = b >>> 8 & 255;
        s.pending_buf[s.pending++] = b & 255;
      };
      var read_buf = (strm, buf, start, size) => {
        let len = strm.avail_in;
        if (len > size) {
          len = size;
        }
        if (len === 0) {
          return 0;
        }
        strm.avail_in -= len;
        buf.set(strm.input.subarray(strm.next_in, strm.next_in + len), start);
        if (strm.state.wrap === 1) {
          strm.adler = adler32(strm.adler, buf, len, start);
        } else if (strm.state.wrap === 2) {
          strm.adler = crc32(strm.adler, buf, len, start);
        }
        strm.next_in += len;
        strm.total_in += len;
        return len;
      };
      var longest_match = (s, cur_match) => {
        let chain_length = s.max_chain_length;
        let scan = s.strstart;
        let match;
        let len;
        let best_len = s.prev_length;
        let nice_match = s.nice_match;
        const limit = s.strstart > s.w_size - MIN_LOOKAHEAD ? s.strstart - (s.w_size - MIN_LOOKAHEAD) : 0;
        const _win = s.window;
        const wmask = s.w_mask;
        const prev = s.prev;
        const strend = s.strstart + MAX_MATCH;
        let scan_end1 = _win[scan + best_len - 1];
        let scan_end = _win[scan + best_len];
        if (s.prev_length >= s.good_match) {
          chain_length >>= 2;
        }
        if (nice_match > s.lookahead) {
          nice_match = s.lookahead;
        }
        do {
          match = cur_match;
          if (_win[match + best_len] !== scan_end || _win[match + best_len - 1] !== scan_end1 || _win[match] !== _win[scan] || _win[++match] !== _win[scan + 1]) {
            continue;
          }
          scan += 2;
          match++;
          do {
          } while (_win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && scan < strend);
          len = MAX_MATCH - (strend - scan);
          scan = strend - MAX_MATCH;
          if (len > best_len) {
            s.match_start = cur_match;
            best_len = len;
            if (len >= nice_match) {
              break;
            }
            scan_end1 = _win[scan + best_len - 1];
            scan_end = _win[scan + best_len];
          }
        } while ((cur_match = prev[cur_match & wmask]) > limit && --chain_length !== 0);
        if (best_len <= s.lookahead) {
          return best_len;
        }
        return s.lookahead;
      };
      var fill_window = (s) => {
        const _w_size = s.w_size;
        let n, more, str;
        do {
          more = s.window_size - s.lookahead - s.strstart;
          if (s.strstart >= _w_size + (_w_size - MIN_LOOKAHEAD)) {
            s.window.set(s.window.subarray(_w_size, _w_size + _w_size - more), 0);
            s.match_start -= _w_size;
            s.strstart -= _w_size;
            s.block_start -= _w_size;
            if (s.insert > s.strstart) {
              s.insert = s.strstart;
            }
            slide_hash(s);
            more += _w_size;
          }
          if (s.strm.avail_in === 0) {
            break;
          }
          n = read_buf(s.strm, s.window, s.strstart + s.lookahead, more);
          s.lookahead += n;
          if (s.lookahead + s.insert >= MIN_MATCH) {
            str = s.strstart - s.insert;
            s.ins_h = s.window[str];
            s.ins_h = HASH(s, s.ins_h, s.window[str + 1]);
            while (s.insert) {
              s.ins_h = HASH(s, s.ins_h, s.window[str + MIN_MATCH - 1]);
              s.prev[str & s.w_mask] = s.head[s.ins_h];
              s.head[s.ins_h] = str;
              str++;
              s.insert--;
              if (s.lookahead + s.insert < MIN_MATCH) {
                break;
              }
            }
          }
        } while (s.lookahead < MIN_LOOKAHEAD && s.strm.avail_in !== 0);
      };
      var deflate_stored = (s, flush) => {
        let min_block = s.pending_buf_size - 5 > s.w_size ? s.w_size : s.pending_buf_size - 5;
        let len, left, have, last = 0;
        let used = s.strm.avail_in;
        do {
          len = 65535;
          have = s.bi_valid + 42 >> 3;
          if (s.strm.avail_out < have) {
            break;
          }
          have = s.strm.avail_out - have;
          left = s.strstart - s.block_start;
          if (len > left + s.strm.avail_in) {
            len = left + s.strm.avail_in;
          }
          if (len > have) {
            len = have;
          }
          if (len < min_block && (len === 0 && flush !== Z_FINISH || flush === Z_NO_FLUSH || len !== left + s.strm.avail_in)) {
            break;
          }
          last = flush === Z_FINISH && len === left + s.strm.avail_in ? 1 : 0;
          _tr_stored_block(s, 0, 0, last);
          s.pending_buf[s.pending - 4] = len;
          s.pending_buf[s.pending - 3] = len >> 8;
          s.pending_buf[s.pending - 2] = ~len;
          s.pending_buf[s.pending - 1] = ~len >> 8;
          flush_pending(s.strm);
          if (left) {
            if (left > len) {
              left = len;
            }
            s.strm.output.set(s.window.subarray(s.block_start, s.block_start + left), s.strm.next_out);
            s.strm.next_out += left;
            s.strm.avail_out -= left;
            s.strm.total_out += left;
            s.block_start += left;
            len -= left;
          }
          if (len) {
            read_buf(s.strm, s.strm.output, s.strm.next_out, len);
            s.strm.next_out += len;
            s.strm.avail_out -= len;
            s.strm.total_out += len;
          }
        } while (last === 0);
        used -= s.strm.avail_in;
        if (used) {
          if (used >= s.w_size) {
            s.matches = 2;
            s.window.set(s.strm.input.subarray(s.strm.next_in - s.w_size, s.strm.next_in), 0);
            s.strstart = s.w_size;
            s.insert = s.strstart;
          } else {
            if (s.window_size - s.strstart <= used) {
              s.strstart -= s.w_size;
              s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
              if (s.matches < 2) {
                s.matches++;
              }
              if (s.insert > s.strstart) {
                s.insert = s.strstart;
              }
            }
            s.window.set(s.strm.input.subarray(s.strm.next_in - used, s.strm.next_in), s.strstart);
            s.strstart += used;
            s.insert += used > s.w_size - s.insert ? s.w_size - s.insert : used;
          }
          s.block_start = s.strstart;
        }
        if (s.high_water < s.strstart) {
          s.high_water = s.strstart;
        }
        if (last) {
          return BS_FINISH_DONE;
        }
        if (flush !== Z_NO_FLUSH && flush !== Z_FINISH && s.strm.avail_in === 0 && s.strstart === s.block_start) {
          return BS_BLOCK_DONE;
        }
        have = s.window_size - s.strstart;
        if (s.strm.avail_in > have && s.block_start >= s.w_size) {
          s.block_start -= s.w_size;
          s.strstart -= s.w_size;
          s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
          if (s.matches < 2) {
            s.matches++;
          }
          have += s.w_size;
          if (s.insert > s.strstart) {
            s.insert = s.strstart;
          }
        }
        if (have > s.strm.avail_in) {
          have = s.strm.avail_in;
        }
        if (have) {
          read_buf(s.strm, s.window, s.strstart, have);
          s.strstart += have;
          s.insert += have > s.w_size - s.insert ? s.w_size - s.insert : have;
        }
        if (s.high_water < s.strstart) {
          s.high_water = s.strstart;
        }
        have = s.bi_valid + 42 >> 3;
        have = s.pending_buf_size - have > 65535 ? 65535 : s.pending_buf_size - have;
        min_block = have > s.w_size ? s.w_size : have;
        left = s.strstart - s.block_start;
        if (left >= min_block || (left || flush === Z_FINISH) && flush !== Z_NO_FLUSH && s.strm.avail_in === 0 && left <= have) {
          len = left > have ? have : left;
          last = flush === Z_FINISH && s.strm.avail_in === 0 && len === left ? 1 : 0;
          _tr_stored_block(s, s.block_start, len, last);
          s.block_start += len;
          flush_pending(s.strm);
        }
        return last ? BS_FINISH_STARTED : BS_NEED_MORE;
      };
      var deflate_fast = (s, flush) => {
        let hash_head;
        let bflush;
        for (; ; ) {
          if (s.lookahead < MIN_LOOKAHEAD) {
            fill_window(s);
            if (s.lookahead < MIN_LOOKAHEAD && flush === Z_NO_FLUSH) {
              return BS_NEED_MORE;
            }
            if (s.lookahead === 0) {
              break;
            }
          }
          hash_head = 0;
          if (s.lookahead >= MIN_MATCH) {
            s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
            hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
            s.head[s.ins_h] = s.strstart;
          }
          if (hash_head !== 0 && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) {
            s.match_length = longest_match(s, hash_head);
          }
          if (s.match_length >= MIN_MATCH) {
            bflush = _tr_tally(s, s.strstart - s.match_start, s.match_length - MIN_MATCH);
            s.lookahead -= s.match_length;
            if (s.match_length <= s.max_lazy_match && s.lookahead >= MIN_MATCH) {
              s.match_length--;
              do {
                s.strstart++;
                s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
                hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
                s.head[s.ins_h] = s.strstart;
              } while (--s.match_length !== 0);
              s.strstart++;
            } else {
              s.strstart += s.match_length;
              s.match_length = 0;
              s.ins_h = s.window[s.strstart];
              s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + 1]);
            }
          } else {
            bflush = _tr_tally(s, 0, s.window[s.strstart]);
            s.lookahead--;
            s.strstart++;
          }
          if (bflush) {
            flush_block_only(s, false);
            if (s.strm.avail_out === 0) {
              return BS_NEED_MORE;
            }
          }
        }
        s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
        if (flush === Z_FINISH) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) {
            return BS_FINISH_STARTED;
          }
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        }
        return BS_BLOCK_DONE;
      };
      var deflate_slow = (s, flush) => {
        let hash_head;
        let bflush;
        let max_insert;
        for (; ; ) {
          if (s.lookahead < MIN_LOOKAHEAD) {
            fill_window(s);
            if (s.lookahead < MIN_LOOKAHEAD && flush === Z_NO_FLUSH) {
              return BS_NEED_MORE;
            }
            if (s.lookahead === 0) {
              break;
            }
          }
          hash_head = 0;
          if (s.lookahead >= MIN_MATCH) {
            s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
            hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
            s.head[s.ins_h] = s.strstart;
          }
          s.prev_length = s.match_length;
          s.prev_match = s.match_start;
          s.match_length = MIN_MATCH - 1;
          if (hash_head !== 0 && s.prev_length < s.max_lazy_match && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) {
            s.match_length = longest_match(s, hash_head);
            if (s.match_length <= 5 && (s.strategy === Z_FILTERED || s.match_length === MIN_MATCH && s.strstart - s.match_start > 4096)) {
              s.match_length = MIN_MATCH - 1;
            }
          }
          if (s.prev_length >= MIN_MATCH && s.match_length <= s.prev_length) {
            max_insert = s.strstart + s.lookahead - MIN_MATCH;
            bflush = _tr_tally(s, s.strstart - 1 - s.prev_match, s.prev_length - MIN_MATCH);
            s.lookahead -= s.prev_length - 1;
            s.prev_length -= 2;
            do {
              if (++s.strstart <= max_insert) {
                s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
                hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
                s.head[s.ins_h] = s.strstart;
              }
            } while (--s.prev_length !== 0);
            s.match_available = 0;
            s.match_length = MIN_MATCH - 1;
            s.strstart++;
            if (bflush) {
              flush_block_only(s, false);
              if (s.strm.avail_out === 0) {
                return BS_NEED_MORE;
              }
            }
          } else if (s.match_available) {
            bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
            if (bflush) {
              flush_block_only(s, false);
            }
            s.strstart++;
            s.lookahead--;
            if (s.strm.avail_out === 0) {
              return BS_NEED_MORE;
            }
          } else {
            s.match_available = 1;
            s.strstart++;
            s.lookahead--;
          }
        }
        if (s.match_available) {
          bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
          s.match_available = 0;
        }
        s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
        if (flush === Z_FINISH) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) {
            return BS_FINISH_STARTED;
          }
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        }
        return BS_BLOCK_DONE;
      };
      var deflate_rle = (s, flush) => {
        let bflush;
        let prev;
        let scan, strend;
        const _win = s.window;
        for (; ; ) {
          if (s.lookahead <= MAX_MATCH) {
            fill_window(s);
            if (s.lookahead <= MAX_MATCH && flush === Z_NO_FLUSH) {
              return BS_NEED_MORE;
            }
            if (s.lookahead === 0) {
              break;
            }
          }
          s.match_length = 0;
          if (s.lookahead >= MIN_MATCH && s.strstart > 0) {
            scan = s.strstart - 1;
            prev = _win[scan];
            if (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan]) {
              strend = s.strstart + MAX_MATCH;
              do {
              } while (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && scan < strend);
              s.match_length = MAX_MATCH - (strend - scan);
              if (s.match_length > s.lookahead) {
                s.match_length = s.lookahead;
              }
            }
          }
          if (s.match_length >= MIN_MATCH) {
            bflush = _tr_tally(s, 1, s.match_length - MIN_MATCH);
            s.lookahead -= s.match_length;
            s.strstart += s.match_length;
            s.match_length = 0;
          } else {
            bflush = _tr_tally(s, 0, s.window[s.strstart]);
            s.lookahead--;
            s.strstart++;
          }
          if (bflush) {
            flush_block_only(s, false);
            if (s.strm.avail_out === 0) {
              return BS_NEED_MORE;
            }
          }
        }
        s.insert = 0;
        if (flush === Z_FINISH) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) {
            return BS_FINISH_STARTED;
          }
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        }
        return BS_BLOCK_DONE;
      };
      var deflate_huff = (s, flush) => {
        let bflush;
        for (; ; ) {
          if (s.lookahead === 0) {
            fill_window(s);
            if (s.lookahead === 0) {
              if (flush === Z_NO_FLUSH) {
                return BS_NEED_MORE;
              }
              break;
            }
          }
          s.match_length = 0;
          bflush = _tr_tally(s, 0, s.window[s.strstart]);
          s.lookahead--;
          s.strstart++;
          if (bflush) {
            flush_block_only(s, false);
            if (s.strm.avail_out === 0) {
              return BS_NEED_MORE;
            }
          }
        }
        s.insert = 0;
        if (flush === Z_FINISH) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) {
            return BS_FINISH_STARTED;
          }
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        }
        return BS_BLOCK_DONE;
      };
      function Config(good_length, max_lazy, nice_length, max_chain, func) {
        this.good_length = good_length;
        this.max_lazy = max_lazy;
        this.nice_length = nice_length;
        this.max_chain = max_chain;
        this.func = func;
      }
      var configuration_table = [
        /*      good lazy nice chain */
        new Config(0, 0, 0, 0, deflate_stored),
        /* 0 store only */
        new Config(4, 4, 8, 4, deflate_fast),
        /* 1 max speed, no lazy matches */
        new Config(4, 5, 16, 8, deflate_fast),
        /* 2 */
        new Config(4, 6, 32, 32, deflate_fast),
        /* 3 */
        new Config(4, 4, 16, 16, deflate_slow),
        /* 4 lazy matches */
        new Config(8, 16, 32, 32, deflate_slow),
        /* 5 */
        new Config(8, 16, 128, 128, deflate_slow),
        /* 6 */
        new Config(8, 32, 128, 256, deflate_slow),
        /* 7 */
        new Config(32, 128, 258, 1024, deflate_slow),
        /* 8 */
        new Config(32, 258, 258, 4096, deflate_slow)
        /* 9 max compression */
      ];
      var lm_init = (s) => {
        s.window_size = 2 * s.w_size;
        zero(s.head);
        s.max_lazy_match = configuration_table[s.level].max_lazy;
        s.good_match = configuration_table[s.level].good_length;
        s.nice_match = configuration_table[s.level].nice_length;
        s.max_chain_length = configuration_table[s.level].max_chain;
        s.strstart = 0;
        s.block_start = 0;
        s.lookahead = 0;
        s.insert = 0;
        s.match_length = s.prev_length = MIN_MATCH - 1;
        s.match_available = 0;
        s.ins_h = 0;
      };
      function DeflateState() {
        this.strm = null;
        this.status = 0;
        this.pending_buf = null;
        this.pending_buf_size = 0;
        this.pending_out = 0;
        this.pending = 0;
        this.wrap = 0;
        this.gzhead = null;
        this.gzindex = 0;
        this.method = Z_DEFLATED;
        this.last_flush = -1;
        this.w_size = 0;
        this.w_bits = 0;
        this.w_mask = 0;
        this.window = null;
        this.window_size = 0;
        this.prev = null;
        this.head = null;
        this.ins_h = 0;
        this.hash_size = 0;
        this.hash_bits = 0;
        this.hash_mask = 0;
        this.hash_shift = 0;
        this.block_start = 0;
        this.match_length = 0;
        this.prev_match = 0;
        this.match_available = 0;
        this.strstart = 0;
        this.match_start = 0;
        this.lookahead = 0;
        this.prev_length = 0;
        this.max_chain_length = 0;
        this.max_lazy_match = 0;
        this.level = 0;
        this.strategy = 0;
        this.good_match = 0;
        this.nice_match = 0;
        this.dyn_ltree = new Uint16Array(HEAP_SIZE * 2);
        this.dyn_dtree = new Uint16Array((2 * D_CODES + 1) * 2);
        this.bl_tree = new Uint16Array((2 * BL_CODES + 1) * 2);
        zero(this.dyn_ltree);
        zero(this.dyn_dtree);
        zero(this.bl_tree);
        this.l_desc = null;
        this.d_desc = null;
        this.bl_desc = null;
        this.bl_count = new Uint16Array(MAX_BITS + 1);
        this.heap = new Uint16Array(2 * L_CODES + 1);
        zero(this.heap);
        this.heap_len = 0;
        this.heap_max = 0;
        this.depth = new Uint16Array(2 * L_CODES + 1);
        zero(this.depth);
        this.sym_buf = 0;
        this.lit_bufsize = 0;
        this.sym_next = 0;
        this.sym_end = 0;
        this.opt_len = 0;
        this.static_len = 0;
        this.matches = 0;
        this.insert = 0;
        this.bi_buf = 0;
        this.bi_valid = 0;
      }
      var deflateStateCheck = (strm) => {
        if (!strm) {
          return 1;
        }
        const s = strm.state;
        if (!s || s.strm !== strm || s.status !== INIT_STATE && //#ifdef GZIP
        s.status !== GZIP_STATE && //#endif
        s.status !== EXTRA_STATE && s.status !== NAME_STATE && s.status !== COMMENT_STATE && s.status !== HCRC_STATE && s.status !== BUSY_STATE && s.status !== FINISH_STATE) {
          return 1;
        }
        return 0;
      };
      var deflateResetKeep = (strm) => {
        if (deflateStateCheck(strm)) {
          return err(strm, Z_STREAM_ERROR);
        }
        strm.total_in = strm.total_out = 0;
        strm.data_type = Z_UNKNOWN;
        const s = strm.state;
        s.pending = 0;
        s.pending_out = 0;
        if (s.wrap < 0) {
          s.wrap = -s.wrap;
        }
        s.status = //#ifdef GZIP
        s.wrap === 2 ? GZIP_STATE : (
          //#endif
          s.wrap ? INIT_STATE : BUSY_STATE
        );
        strm.adler = s.wrap === 2 ? 0 : 1;
        s.last_flush = -2;
        _tr_init(s);
        return Z_OK;
      };
      var deflateReset = (strm) => {
        const ret = deflateResetKeep(strm);
        if (ret === Z_OK) {
          lm_init(strm.state);
        }
        return ret;
      };
      var deflateSetHeader = (strm, head) => {
        if (deflateStateCheck(strm) || strm.state.wrap !== 2) {
          return Z_STREAM_ERROR;
        }
        strm.state.gzhead = head;
        return Z_OK;
      };
      var deflateInit2 = (strm, level, method, windowBits, memLevel, strategy) => {
        if (!strm) {
          return Z_STREAM_ERROR;
        }
        let wrap = 1;
        if (level === Z_DEFAULT_COMPRESSION) {
          level = 6;
        }
        if (windowBits < 0) {
          wrap = 0;
          windowBits = -windowBits;
        } else if (windowBits > 15) {
          wrap = 2;
          windowBits -= 16;
        }
        if (memLevel < 1 || memLevel > MAX_MEM_LEVEL || method !== Z_DEFLATED || windowBits < 8 || windowBits > 15 || level < 0 || level > 9 || strategy < 0 || strategy > Z_FIXED || windowBits === 8 && wrap !== 1) {
          return err(strm, Z_STREAM_ERROR);
        }
        if (windowBits === 8) {
          windowBits = 9;
        }
        const s = new DeflateState();
        strm.state = s;
        s.strm = strm;
        s.status = INIT_STATE;
        s.wrap = wrap;
        s.gzhead = null;
        s.w_bits = windowBits;
        s.w_size = 1 << s.w_bits;
        s.w_mask = s.w_size - 1;
        s.hash_bits = memLevel + 7;
        s.hash_size = 1 << s.hash_bits;
        s.hash_mask = s.hash_size - 1;
        s.hash_shift = ~~((s.hash_bits + MIN_MATCH - 1) / MIN_MATCH);
        s.window = new Uint8Array(s.w_size * 2);
        s.head = new Uint16Array(s.hash_size);
        s.prev = new Uint16Array(s.w_size);
        s.lit_bufsize = 1 << memLevel + 6;
        s.pending_buf_size = s.lit_bufsize * 4;
        s.pending_buf = new Uint8Array(s.pending_buf_size);
        s.sym_buf = s.lit_bufsize;
        s.sym_end = (s.lit_bufsize - 1) * 3;
        s.level = level;
        s.strategy = strategy;
        s.method = method;
        return deflateReset(strm);
      };
      var deflateInit = (strm, level) => {
        return deflateInit2(strm, level, Z_DEFLATED, MAX_WBITS, DEF_MEM_LEVEL, Z_DEFAULT_STRATEGY);
      };
      var deflate = (strm, flush) => {
        if (deflateStateCheck(strm) || flush > Z_BLOCK || flush < 0) {
          return strm ? err(strm, Z_STREAM_ERROR) : Z_STREAM_ERROR;
        }
        const s = strm.state;
        if (!strm.output || strm.avail_in !== 0 && !strm.input || s.status === FINISH_STATE && flush !== Z_FINISH) {
          return err(strm, strm.avail_out === 0 ? Z_BUF_ERROR : Z_STREAM_ERROR);
        }
        const old_flush = s.last_flush;
        s.last_flush = flush;
        if (s.pending !== 0) {
          flush_pending(strm);
          if (strm.avail_out === 0) {
            s.last_flush = -1;
            return Z_OK;
          }
        } else if (strm.avail_in === 0 && rank(flush) <= rank(old_flush) && flush !== Z_FINISH) {
          return err(strm, Z_BUF_ERROR);
        }
        if (s.status === FINISH_STATE && strm.avail_in !== 0) {
          return err(strm, Z_BUF_ERROR);
        }
        if (s.status === INIT_STATE && s.wrap === 0) {
          s.status = BUSY_STATE;
        }
        if (s.status === INIT_STATE) {
          let header = Z_DEFLATED + (s.w_bits - 8 << 4) << 8;
          let level_flags = -1;
          if (s.strategy >= Z_HUFFMAN_ONLY || s.level < 2) {
            level_flags = 0;
          } else if (s.level < 6) {
            level_flags = 1;
          } else if (s.level === 6) {
            level_flags = 2;
          } else {
            level_flags = 3;
          }
          header |= level_flags << 6;
          if (s.strstart !== 0) {
            header |= PRESET_DICT;
          }
          header += 31 - header % 31;
          putShortMSB(s, header);
          if (s.strstart !== 0) {
            putShortMSB(s, strm.adler >>> 16);
            putShortMSB(s, strm.adler & 65535);
          }
          strm.adler = 1;
          s.status = BUSY_STATE;
          flush_pending(strm);
          if (s.pending !== 0) {
            s.last_flush = -1;
            return Z_OK;
          }
        }
        if (s.status === GZIP_STATE) {
          strm.adler = 0;
          put_byte(s, 31);
          put_byte(s, 139);
          put_byte(s, 8);
          if (!s.gzhead) {
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, s.level === 9 ? 2 : s.strategy >= Z_HUFFMAN_ONLY || s.level < 2 ? 4 : 0);
            put_byte(s, OS_CODE);
            s.status = BUSY_STATE;
            flush_pending(strm);
            if (s.pending !== 0) {
              s.last_flush = -1;
              return Z_OK;
            }
          } else {
            put_byte(
              s,
              (s.gzhead.text ? 1 : 0) + (s.gzhead.hcrc ? 2 : 0) + (!s.gzhead.extra ? 0 : 4) + (!s.gzhead.name ? 0 : 8) + (!s.gzhead.comment ? 0 : 16)
            );
            put_byte(s, s.gzhead.time & 255);
            put_byte(s, s.gzhead.time >> 8 & 255);
            put_byte(s, s.gzhead.time >> 16 & 255);
            put_byte(s, s.gzhead.time >> 24 & 255);
            put_byte(s, s.level === 9 ? 2 : s.strategy >= Z_HUFFMAN_ONLY || s.level < 2 ? 4 : 0);
            put_byte(s, s.gzhead.os & 255);
            if (s.gzhead.extra && s.gzhead.extra.length) {
              put_byte(s, s.gzhead.extra.length & 255);
              put_byte(s, s.gzhead.extra.length >> 8 & 255);
            }
            if (s.gzhead.hcrc) {
              strm.adler = crc32(strm.adler, s.pending_buf, s.pending, 0);
            }
            s.gzindex = 0;
            s.status = EXTRA_STATE;
          }
        }
        if (s.status === EXTRA_STATE) {
          if (s.gzhead.extra) {
            let beg = s.pending;
            let left = (s.gzhead.extra.length & 65535) - s.gzindex;
            while (s.pending + left > s.pending_buf_size) {
              let copy2 = s.pending_buf_size - s.pending;
              s.pending_buf.set(s.gzhead.extra.subarray(s.gzindex, s.gzindex + copy2), s.pending);
              s.pending = s.pending_buf_size;
              if (s.gzhead.hcrc && s.pending > beg) {
                strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
              }
              s.gzindex += copy2;
              flush_pending(strm);
              if (s.pending !== 0) {
                s.last_flush = -1;
                return Z_OK;
              }
              beg = 0;
              left -= copy2;
            }
            let gzhead_extra = new Uint8Array(s.gzhead.extra);
            s.pending_buf.set(gzhead_extra.subarray(s.gzindex, s.gzindex + left), s.pending);
            s.pending += left;
            if (s.gzhead.hcrc && s.pending > beg) {
              strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
            }
            s.gzindex = 0;
          }
          s.status = NAME_STATE;
        }
        if (s.status === NAME_STATE) {
          if (s.gzhead.name) {
            let beg = s.pending;
            let val;
            do {
              if (s.pending === s.pending_buf_size) {
                if (s.gzhead.hcrc && s.pending > beg) {
                  strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
                }
                flush_pending(strm);
                if (s.pending !== 0) {
                  s.last_flush = -1;
                  return Z_OK;
                }
                beg = 0;
              }
              if (s.gzindex < s.gzhead.name.length) {
                val = s.gzhead.name.charCodeAt(s.gzindex++) & 255;
              } else {
                val = 0;
              }
              put_byte(s, val);
            } while (val !== 0);
            if (s.gzhead.hcrc && s.pending > beg) {
              strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
            }
            s.gzindex = 0;
          }
          s.status = COMMENT_STATE;
        }
        if (s.status === COMMENT_STATE) {
          if (s.gzhead.comment) {
            let beg = s.pending;
            let val;
            do {
              if (s.pending === s.pending_buf_size) {
                if (s.gzhead.hcrc && s.pending > beg) {
                  strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
                }
                flush_pending(strm);
                if (s.pending !== 0) {
                  s.last_flush = -1;
                  return Z_OK;
                }
                beg = 0;
              }
              if (s.gzindex < s.gzhead.comment.length) {
                val = s.gzhead.comment.charCodeAt(s.gzindex++) & 255;
              } else {
                val = 0;
              }
              put_byte(s, val);
            } while (val !== 0);
            if (s.gzhead.hcrc && s.pending > beg) {
              strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
            }
          }
          s.status = HCRC_STATE;
        }
        if (s.status === HCRC_STATE) {
          if (s.gzhead.hcrc) {
            if (s.pending + 2 > s.pending_buf_size) {
              flush_pending(strm);
              if (s.pending !== 0) {
                s.last_flush = -1;
                return Z_OK;
              }
            }
            put_byte(s, strm.adler & 255);
            put_byte(s, strm.adler >> 8 & 255);
            strm.adler = 0;
          }
          s.status = BUSY_STATE;
          flush_pending(strm);
          if (s.pending !== 0) {
            s.last_flush = -1;
            return Z_OK;
          }
        }
        if (strm.avail_in !== 0 || s.lookahead !== 0 || flush !== Z_NO_FLUSH && s.status !== FINISH_STATE) {
          let bstate = s.level === 0 ? deflate_stored(s, flush) : s.strategy === Z_HUFFMAN_ONLY ? deflate_huff(s, flush) : s.strategy === Z_RLE ? deflate_rle(s, flush) : configuration_table[s.level].func(s, flush);
          if (bstate === BS_FINISH_STARTED || bstate === BS_FINISH_DONE) {
            s.status = FINISH_STATE;
          }
          if (bstate === BS_NEED_MORE || bstate === BS_FINISH_STARTED) {
            if (strm.avail_out === 0) {
              s.last_flush = -1;
            }
            return Z_OK;
          }
          if (bstate === BS_BLOCK_DONE) {
            if (flush === Z_PARTIAL_FLUSH) {
              _tr_align(s);
            } else if (flush !== Z_BLOCK) {
              _tr_stored_block(s, 0, 0, false);
              if (flush === Z_FULL_FLUSH) {
                zero(s.head);
                if (s.lookahead === 0) {
                  s.strstart = 0;
                  s.block_start = 0;
                  s.insert = 0;
                }
              }
            }
            flush_pending(strm);
            if (strm.avail_out === 0) {
              s.last_flush = -1;
              return Z_OK;
            }
          }
        }
        if (flush !== Z_FINISH) {
          return Z_OK;
        }
        if (s.wrap <= 0) {
          return Z_STREAM_END;
        }
        if (s.wrap === 2) {
          put_byte(s, strm.adler & 255);
          put_byte(s, strm.adler >> 8 & 255);
          put_byte(s, strm.adler >> 16 & 255);
          put_byte(s, strm.adler >> 24 & 255);
          put_byte(s, strm.total_in & 255);
          put_byte(s, strm.total_in >> 8 & 255);
          put_byte(s, strm.total_in >> 16 & 255);
          put_byte(s, strm.total_in >> 24 & 255);
        } else {
          putShortMSB(s, strm.adler >>> 16);
          putShortMSB(s, strm.adler & 65535);
        }
        flush_pending(strm);
        if (s.wrap > 0) {
          s.wrap = -s.wrap;
        }
        return s.pending !== 0 ? Z_OK : Z_STREAM_END;
      };
      var deflateEnd = (strm) => {
        if (deflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        const status = strm.state.status;
        strm.state = null;
        return status === BUSY_STATE ? err(strm, Z_DATA_ERROR) : Z_OK;
      };
      var deflateSetDictionary = (strm, dictionary) => {
        let dictLength = dictionary.length;
        if (deflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        const s = strm.state;
        const wrap = s.wrap;
        if (wrap === 2 || wrap === 1 && s.status !== INIT_STATE || s.lookahead) {
          return Z_STREAM_ERROR;
        }
        if (wrap === 1) {
          strm.adler = adler32(strm.adler, dictionary, dictLength, 0);
        }
        s.wrap = 0;
        if (dictLength >= s.w_size) {
          if (wrap === 0) {
            zero(s.head);
            s.strstart = 0;
            s.block_start = 0;
            s.insert = 0;
          }
          let tmpDict = new Uint8Array(s.w_size);
          tmpDict.set(dictionary.subarray(dictLength - s.w_size, dictLength), 0);
          dictionary = tmpDict;
          dictLength = s.w_size;
        }
        const avail = strm.avail_in;
        const next = strm.next_in;
        const input = strm.input;
        strm.avail_in = dictLength;
        strm.next_in = 0;
        strm.input = dictionary;
        fill_window(s);
        while (s.lookahead >= MIN_MATCH) {
          let str = s.strstart;
          let n = s.lookahead - (MIN_MATCH - 1);
          do {
            s.ins_h = HASH(s, s.ins_h, s.window[str + MIN_MATCH - 1]);
            s.prev[str & s.w_mask] = s.head[s.ins_h];
            s.head[s.ins_h] = str;
            str++;
          } while (--n);
          s.strstart = str;
          s.lookahead = MIN_MATCH - 1;
          fill_window(s);
        }
        s.strstart += s.lookahead;
        s.block_start = s.strstart;
        s.insert = s.lookahead;
        s.lookahead = 0;
        s.match_length = s.prev_length = MIN_MATCH - 1;
        s.match_available = 0;
        strm.next_in = next;
        strm.input = input;
        strm.avail_in = avail;
        s.wrap = wrap;
        return Z_OK;
      };
      module.exports.deflateInit = deflateInit;
      module.exports.deflateInit2 = deflateInit2;
      module.exports.deflateReset = deflateReset;
      module.exports.deflateResetKeep = deflateResetKeep;
      module.exports.deflateSetHeader = deflateSetHeader;
      module.exports.deflate = deflate;
      module.exports.deflateEnd = deflateEnd;
      module.exports.deflateSetDictionary = deflateSetDictionary;
      module.exports.deflateInfo = "pako deflate (from Nodeca project)";
    }
  });

  // node_modules/pako/lib/utils/common.js
  var require_common = __commonJS({
    "node_modules/pako/lib/utils/common.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var _has = (obj, key) => {
        return Object.prototype.hasOwnProperty.call(obj, key);
      };
      module.exports.assign = function(obj) {
        const sources = Array.prototype.slice.call(arguments, 1);
        while (sources.length) {
          const source = sources.shift();
          if (!source) {
            continue;
          }
          if (typeof source !== "object") {
            throw new TypeError(source + "must be non-object");
          }
          for (const p in source) {
            if (_has(source, p)) {
              obj[p] = source[p];
            }
          }
        }
        return obj;
      };
      module.exports.flattenChunks = (chunks) => {
        let len = 0;
        for (let i = 0, l = chunks.length; i < l; i++) {
          len += chunks[i].length;
        }
        const result = new Uint8Array(len);
        for (let i = 0, pos = 0, l = chunks.length; i < l; i++) {
          let chunk = chunks[i];
          result.set(chunk, pos);
          pos += chunk.length;
        }
        return result;
      };
    }
  });

  // node_modules/pako/lib/utils/strings.js
  var require_strings = __commonJS({
    "node_modules/pako/lib/utils/strings.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var STR_APPLY_UIA_OK = true;
      try {
        String.fromCharCode.apply(null, new Uint8Array(1));
      } catch (__) {
        STR_APPLY_UIA_OK = false;
      }
      var _utf8len = new Uint8Array(256);
      for (let q = 0; q < 256; q++) {
        _utf8len[q] = q >= 252 ? 6 : q >= 248 ? 5 : q >= 240 ? 4 : q >= 224 ? 3 : q >= 192 ? 2 : 1;
      }
      _utf8len[254] = _utf8len[254] = 1;
      module.exports.string2buf = (str) => {
        if (typeof TextEncoder === "function" && TextEncoder.prototype.encode) {
          return new TextEncoder().encode(str);
        }
        let buf, c, c2, m_pos, i, str_len = str.length, buf_len = 0;
        for (m_pos = 0; m_pos < str_len; m_pos++) {
          c = str.charCodeAt(m_pos);
          if ((c & 64512) === 55296 && m_pos + 1 < str_len) {
            c2 = str.charCodeAt(m_pos + 1);
            if ((c2 & 64512) === 56320) {
              c = 65536 + (c - 55296 << 10) + (c2 - 56320);
              m_pos++;
            }
          }
          buf_len += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4;
        }
        buf = new Uint8Array(buf_len);
        for (i = 0, m_pos = 0; i < buf_len; m_pos++) {
          c = str.charCodeAt(m_pos);
          if ((c & 64512) === 55296 && m_pos + 1 < str_len) {
            c2 = str.charCodeAt(m_pos + 1);
            if ((c2 & 64512) === 56320) {
              c = 65536 + (c - 55296 << 10) + (c2 - 56320);
              m_pos++;
            }
          }
          if (c < 128) {
            buf[i++] = c;
          } else if (c < 2048) {
            buf[i++] = 192 | c >>> 6;
            buf[i++] = 128 | c & 63;
          } else if (c < 65536) {
            buf[i++] = 224 | c >>> 12;
            buf[i++] = 128 | c >>> 6 & 63;
            buf[i++] = 128 | c & 63;
          } else {
            buf[i++] = 240 | c >>> 18;
            buf[i++] = 128 | c >>> 12 & 63;
            buf[i++] = 128 | c >>> 6 & 63;
            buf[i++] = 128 | c & 63;
          }
        }
        return buf;
      };
      var buf2binstring = (buf, len) => {
        if (len < 65534) {
          if (buf.subarray && STR_APPLY_UIA_OK) {
            return String.fromCharCode.apply(null, buf.length === len ? buf : buf.subarray(0, len));
          }
        }
        let result = "";
        for (let i = 0; i < len; i++) {
          result += String.fromCharCode(buf[i]);
        }
        return result;
      };
      module.exports.buf2string = (buf, max2) => {
        const len = max2 || buf.length;
        if (typeof TextDecoder === "function" && TextDecoder.prototype.decode) {
          return new TextDecoder().decode(buf.subarray(0, max2));
        }
        let i, out;
        const utf16buf = new Array(len * 2);
        for (out = 0, i = 0; i < len; ) {
          let c = buf[i++];
          if (c < 128) {
            utf16buf[out++] = c;
            continue;
          }
          let c_len = _utf8len[c];
          if (c_len > 4) {
            utf16buf[out++] = 65533;
            i += c_len - 1;
            continue;
          }
          c &= c_len === 2 ? 31 : c_len === 3 ? 15 : 7;
          while (c_len > 1 && i < len) {
            c = c << 6 | buf[i++] & 63;
            c_len--;
          }
          if (c_len > 1) {
            utf16buf[out++] = 65533;
            continue;
          }
          if (c < 65536) {
            utf16buf[out++] = c;
          } else {
            c -= 65536;
            utf16buf[out++] = 55296 | c >> 10 & 1023;
            utf16buf[out++] = 56320 | c & 1023;
          }
        }
        return buf2binstring(utf16buf, out);
      };
      module.exports.utf8border = (buf, max2) => {
        max2 = max2 || buf.length;
        if (max2 > buf.length) {
          max2 = buf.length;
        }
        let pos = max2 - 1;
        while (pos >= 0 && (buf[pos] & 192) === 128) {
          pos--;
        }
        if (pos < 0) {
          return max2;
        }
        if (pos === 0) {
          return max2;
        }
        return pos + _utf8len[buf[pos]] > max2 ? pos : max2;
      };
    }
  });

  // node_modules/pako/lib/zlib/zstream.js
  var require_zstream = __commonJS({
    "node_modules/pako/lib/zlib/zstream.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      function ZStream() {
        this.input = null;
        this.next_in = 0;
        this.avail_in = 0;
        this.total_in = 0;
        this.output = null;
        this.next_out = 0;
        this.avail_out = 0;
        this.total_out = 0;
        this.msg = "";
        this.state = null;
        this.data_type = 2;
        this.adler = 0;
      }
      module.exports = ZStream;
    }
  });

  // node_modules/pako/lib/deflate.js
  var require_deflate2 = __commonJS({
    "node_modules/pako/lib/deflate.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var zlib_deflate = require_deflate();
      var utils = require_common();
      var strings = require_strings();
      var msg = require_messages();
      var ZStream = require_zstream();
      var toString = Object.prototype.toString;
      var {
        Z_NO_FLUSH,
        Z_SYNC_FLUSH,
        Z_FULL_FLUSH,
        Z_FINISH,
        Z_OK,
        Z_STREAM_END,
        Z_DEFAULT_COMPRESSION,
        Z_DEFAULT_STRATEGY,
        Z_DEFLATED
      } = require_constants2();
      function Deflate(options) {
        this.options = utils.assign({
          level: Z_DEFAULT_COMPRESSION,
          method: Z_DEFLATED,
          chunkSize: 16384,
          windowBits: 15,
          memLevel: 8,
          strategy: Z_DEFAULT_STRATEGY
        }, options || {});
        let opt = this.options;
        if (opt.raw && opt.windowBits > 0) {
          opt.windowBits = -opt.windowBits;
        } else if (opt.gzip && opt.windowBits > 0 && opt.windowBits < 16) {
          opt.windowBits += 16;
        }
        this.err = 0;
        this.msg = "";
        this.ended = false;
        this.chunks = [];
        this.strm = new ZStream();
        this.strm.avail_out = 0;
        let status = zlib_deflate.deflateInit2(
          this.strm,
          opt.level,
          opt.method,
          opt.windowBits,
          opt.memLevel,
          opt.strategy
        );
        if (status !== Z_OK) {
          throw new Error(msg[status]);
        }
        if (opt.header) {
          zlib_deflate.deflateSetHeader(this.strm, opt.header);
        }
        if (opt.dictionary) {
          let dict;
          if (typeof opt.dictionary === "string") {
            dict = strings.string2buf(opt.dictionary);
          } else if (toString.call(opt.dictionary) === "[object ArrayBuffer]") {
            dict = new Uint8Array(opt.dictionary);
          } else {
            dict = opt.dictionary;
          }
          status = zlib_deflate.deflateSetDictionary(this.strm, dict);
          if (status !== Z_OK) {
            throw new Error(msg[status]);
          }
          this._dict_set = true;
        }
      }
      Deflate.prototype.push = function(data, flush_mode) {
        const strm = this.strm;
        const chunkSize = this.options.chunkSize;
        let status, _flush_mode;
        if (this.ended) {
          return false;
        }
        if (flush_mode === ~~flush_mode) _flush_mode = flush_mode;
        else _flush_mode = flush_mode === true ? Z_FINISH : Z_NO_FLUSH;
        if (typeof data === "string") {
          strm.input = strings.string2buf(data);
        } else if (toString.call(data) === "[object ArrayBuffer]") {
          strm.input = new Uint8Array(data);
        } else {
          strm.input = data;
        }
        strm.next_in = 0;
        strm.avail_in = strm.input.length;
        for (; ; ) {
          if (strm.avail_out === 0) {
            strm.output = new Uint8Array(chunkSize);
            strm.next_out = 0;
            strm.avail_out = chunkSize;
          }
          if ((_flush_mode === Z_SYNC_FLUSH || _flush_mode === Z_FULL_FLUSH) && strm.avail_out <= 6) {
            this.onData(strm.output.subarray(0, strm.next_out));
            strm.avail_out = 0;
            continue;
          }
          status = zlib_deflate.deflate(strm, _flush_mode);
          if (status === Z_STREAM_END) {
            if (strm.next_out > 0) {
              this.onData(strm.output.subarray(0, strm.next_out));
            }
            status = zlib_deflate.deflateEnd(this.strm);
            this.onEnd(status);
            this.ended = true;
            return status === Z_OK;
          }
          if (strm.avail_out === 0) {
            this.onData(strm.output);
            continue;
          }
          if (_flush_mode > 0 && strm.next_out > 0) {
            this.onData(strm.output.subarray(0, strm.next_out));
            strm.avail_out = 0;
            continue;
          }
          if (strm.avail_in === 0) break;
        }
        return true;
      };
      Deflate.prototype.onData = function(chunk) {
        this.chunks.push(chunk);
      };
      Deflate.prototype.onEnd = function(status) {
        if (status === Z_OK) {
          this.result = utils.flattenChunks(this.chunks);
        }
        this.chunks = [];
        this.err = status;
        this.msg = this.strm.msg;
      };
      function deflate(input, options) {
        const deflator = new Deflate(options);
        deflator.push(input, true);
        if (deflator.err) {
          throw deflator.msg || msg[deflator.err];
        }
        return deflator.result;
      }
      function deflateRaw(input, options) {
        options = options || {};
        options.raw = true;
        return deflate(input, options);
      }
      function gzip(input, options) {
        options = options || {};
        options.gzip = true;
        return deflate(input, options);
      }
      module.exports.Deflate = Deflate;
      module.exports.deflate = deflate;
      module.exports.deflateRaw = deflateRaw;
      module.exports.gzip = gzip;
      module.exports.constants = require_constants2();
    }
  });

  // node_modules/pako/lib/zlib/inffast.js
  var require_inffast = __commonJS({
    "node_modules/pako/lib/zlib/inffast.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var BAD = 16209;
      var TYPE = 16191;
      module.exports = function inflate_fast(strm, start) {
        let _in;
        let last;
        let _out;
        let beg;
        let end;
        let dmax;
        let wsize;
        let whave;
        let wnext;
        let s_window;
        let hold;
        let bits;
        let lcode;
        let dcode;
        let lmask;
        let dmask;
        let here;
        let op;
        let len;
        let dist;
        let from;
        let from_source;
        let input, output;
        const state = strm.state;
        _in = strm.next_in;
        input = strm.input;
        last = _in + (strm.avail_in - 5);
        _out = strm.next_out;
        output = strm.output;
        beg = _out - (start - strm.avail_out);
        end = _out + (strm.avail_out - 257);
        dmax = state.dmax;
        wsize = state.wsize;
        whave = state.whave;
        wnext = state.wnext;
        s_window = state.window;
        hold = state.hold;
        bits = state.bits;
        lcode = state.lencode;
        dcode = state.distcode;
        lmask = (1 << state.lenbits) - 1;
        dmask = (1 << state.distbits) - 1;
        top:
          do {
            if (bits < 15) {
              hold += input[_in++] << bits;
              bits += 8;
              hold += input[_in++] << bits;
              bits += 8;
            }
            here = lcode[hold & lmask];
            dolen:
              for (; ; ) {
                op = here >>> 24;
                hold >>>= op;
                bits -= op;
                op = here >>> 16 & 255;
                if (op === 0) {
                  output[_out++] = here & 65535;
                } else if (op & 16) {
                  len = here & 65535;
                  op &= 15;
                  if (op) {
                    if (bits < op) {
                      hold += input[_in++] << bits;
                      bits += 8;
                    }
                    len += hold & (1 << op) - 1;
                    hold >>>= op;
                    bits -= op;
                  }
                  if (bits < 15) {
                    hold += input[_in++] << bits;
                    bits += 8;
                    hold += input[_in++] << bits;
                    bits += 8;
                  }
                  here = dcode[hold & dmask];
                  dodist:
                    for (; ; ) {
                      op = here >>> 24;
                      hold >>>= op;
                      bits -= op;
                      op = here >>> 16 & 255;
                      if (op & 16) {
                        dist = here & 65535;
                        op &= 15;
                        if (bits < op) {
                          hold += input[_in++] << bits;
                          bits += 8;
                          if (bits < op) {
                            hold += input[_in++] << bits;
                            bits += 8;
                          }
                        }
                        dist += hold & (1 << op) - 1;
                        if (dist > dmax) {
                          strm.msg = "invalid distance too far back";
                          state.mode = BAD;
                          break top;
                        }
                        hold >>>= op;
                        bits -= op;
                        op = _out - beg;
                        if (dist > op) {
                          op = dist - op;
                          if (op > whave) {
                            if (state.sane) {
                              strm.msg = "invalid distance too far back";
                              state.mode = BAD;
                              break top;
                            }
                          }
                          from = 0;
                          from_source = s_window;
                          if (wnext === 0) {
                            from += wsize - op;
                            if (op < len) {
                              len -= op;
                              do {
                                output[_out++] = s_window[from++];
                              } while (--op);
                              from = _out - dist;
                              from_source = output;
                            }
                          } else if (wnext < op) {
                            from += wsize + wnext - op;
                            op -= wnext;
                            if (op < len) {
                              len -= op;
                              do {
                                output[_out++] = s_window[from++];
                              } while (--op);
                              from = 0;
                              if (wnext < len) {
                                op = wnext;
                                len -= op;
                                do {
                                  output[_out++] = s_window[from++];
                                } while (--op);
                                from = _out - dist;
                                from_source = output;
                              }
                            }
                          } else {
                            from += wnext - op;
                            if (op < len) {
                              len -= op;
                              do {
                                output[_out++] = s_window[from++];
                              } while (--op);
                              from = _out - dist;
                              from_source = output;
                            }
                          }
                          while (len > 2) {
                            output[_out++] = from_source[from++];
                            output[_out++] = from_source[from++];
                            output[_out++] = from_source[from++];
                            len -= 3;
                          }
                          if (len) {
                            output[_out++] = from_source[from++];
                            if (len > 1) {
                              output[_out++] = from_source[from++];
                            }
                          }
                        } else {
                          from = _out - dist;
                          do {
                            output[_out++] = output[from++];
                            output[_out++] = output[from++];
                            output[_out++] = output[from++];
                            len -= 3;
                          } while (len > 2);
                          if (len) {
                            output[_out++] = output[from++];
                            if (len > 1) {
                              output[_out++] = output[from++];
                            }
                          }
                        }
                      } else if ((op & 64) === 0) {
                        here = dcode[(here & 65535) + (hold & (1 << op) - 1)];
                        continue dodist;
                      } else {
                        strm.msg = "invalid distance code";
                        state.mode = BAD;
                        break top;
                      }
                      break;
                    }
                } else if ((op & 64) === 0) {
                  here = lcode[(here & 65535) + (hold & (1 << op) - 1)];
                  continue dolen;
                } else if (op & 32) {
                  state.mode = TYPE;
                  break top;
                } else {
                  strm.msg = "invalid literal/length code";
                  state.mode = BAD;
                  break top;
                }
                break;
              }
          } while (_in < last && _out < end);
        len = bits >> 3;
        _in -= len;
        bits -= len << 3;
        hold &= (1 << bits) - 1;
        strm.next_in = _in;
        strm.next_out = _out;
        strm.avail_in = _in < last ? 5 + (last - _in) : 5 - (_in - last);
        strm.avail_out = _out < end ? 257 + (end - _out) : 257 - (_out - end);
        state.hold = hold;
        state.bits = bits;
        return;
      };
    }
  });

  // node_modules/pako/lib/zlib/inftrees.js
  var require_inftrees = __commonJS({
    "node_modules/pako/lib/zlib/inftrees.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var MAXBITS = 15;
      var ENOUGH_LENS = 852;
      var ENOUGH_DISTS = 592;
      var CODES = 0;
      var LENS = 1;
      var DISTS = 2;
      var lbase = new Uint16Array([
        /* Length codes 257..285 base */
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        13,
        15,
        17,
        19,
        23,
        27,
        31,
        35,
        43,
        51,
        59,
        67,
        83,
        99,
        115,
        131,
        163,
        195,
        227,
        258,
        0,
        0
      ]);
      var lext = new Uint8Array([
        /* Length codes 257..285 extra */
        16,
        16,
        16,
        16,
        16,
        16,
        16,
        16,
        17,
        17,
        17,
        17,
        18,
        18,
        18,
        18,
        19,
        19,
        19,
        19,
        20,
        20,
        20,
        20,
        21,
        21,
        21,
        21,
        16,
        72,
        78
      ]);
      var dbase = new Uint16Array([
        /* Distance codes 0..29 base */
        1,
        2,
        3,
        4,
        5,
        7,
        9,
        13,
        17,
        25,
        33,
        49,
        65,
        97,
        129,
        193,
        257,
        385,
        513,
        769,
        1025,
        1537,
        2049,
        3073,
        4097,
        6145,
        8193,
        12289,
        16385,
        24577,
        0,
        0
      ]);
      var dext = new Uint8Array([
        /* Distance codes 0..29 extra */
        16,
        16,
        16,
        16,
        17,
        17,
        18,
        18,
        19,
        19,
        20,
        20,
        21,
        21,
        22,
        22,
        23,
        23,
        24,
        24,
        25,
        25,
        26,
        26,
        27,
        27,
        28,
        28,
        29,
        29,
        64,
        64
      ]);
      var inflate_table = (type, lens, lens_index, codes, table, table_index, work, opts) => {
        const bits = opts.bits;
        let len = 0;
        let sym = 0;
        let min = 0, max2 = 0;
        let root = 0;
        let curr = 0;
        let drop = 0;
        let left = 0;
        let used = 0;
        let huff = 0;
        let incr;
        let fill;
        let low;
        let mask;
        let next;
        let base = null;
        let match;
        const count = new Uint16Array(MAXBITS + 1);
        const offs = new Uint16Array(MAXBITS + 1);
        let extra = null;
        let here_bits, here_op, here_val;
        for (len = 0; len <= MAXBITS; len++) {
          count[len] = 0;
        }
        for (sym = 0; sym < codes; sym++) {
          count[lens[lens_index + sym]]++;
        }
        root = bits;
        for (max2 = MAXBITS; max2 >= 1; max2--) {
          if (count[max2] !== 0) {
            break;
          }
        }
        if (root > max2) {
          root = max2;
        }
        if (max2 === 0) {
          table[table_index++] = 1 << 24 | 64 << 16 | 0;
          table[table_index++] = 1 << 24 | 64 << 16 | 0;
          opts.bits = 1;
          return 0;
        }
        for (min = 1; min < max2; min++) {
          if (count[min] !== 0) {
            break;
          }
        }
        if (root < min) {
          root = min;
        }
        left = 1;
        for (len = 1; len <= MAXBITS; len++) {
          left <<= 1;
          left -= count[len];
          if (left < 0) {
            return -1;
          }
        }
        if (left > 0 && (type === CODES || max2 !== 1)) {
          return -1;
        }
        offs[1] = 0;
        for (len = 1; len < MAXBITS; len++) {
          offs[len + 1] = offs[len] + count[len];
        }
        for (sym = 0; sym < codes; sym++) {
          if (lens[lens_index + sym] !== 0) {
            work[offs[lens[lens_index + sym]]++] = sym;
          }
        }
        if (type === CODES) {
          base = extra = work;
          match = 20;
        } else if (type === LENS) {
          base = lbase;
          extra = lext;
          match = 257;
        } else {
          base = dbase;
          extra = dext;
          match = 0;
        }
        huff = 0;
        sym = 0;
        len = min;
        next = table_index;
        curr = root;
        drop = 0;
        low = -1;
        used = 1 << root;
        mask = used - 1;
        if (type === LENS && used > ENOUGH_LENS || type === DISTS && used > ENOUGH_DISTS) {
          return 1;
        }
        for (; ; ) {
          here_bits = len - drop;
          if (work[sym] + 1 < match) {
            here_op = 0;
            here_val = work[sym];
          } else if (work[sym] >= match) {
            here_op = extra[work[sym] - match];
            here_val = base[work[sym] - match];
          } else {
            here_op = 32 + 64;
            here_val = 0;
          }
          incr = 1 << len - drop;
          fill = 1 << curr;
          min = fill;
          do {
            fill -= incr;
            table[next + (huff >> drop) + fill] = here_bits << 24 | here_op << 16 | here_val | 0;
          } while (fill !== 0);
          incr = 1 << len - 1;
          while (huff & incr) {
            incr >>= 1;
          }
          if (incr !== 0) {
            huff &= incr - 1;
            huff += incr;
          } else {
            huff = 0;
          }
          sym++;
          if (--count[len] === 0) {
            if (len === max2) {
              break;
            }
            len = lens[lens_index + work[sym]];
          }
          if (len > root && (huff & mask) !== low) {
            if (drop === 0) {
              drop = root;
            }
            next += min;
            curr = len - drop;
            left = 1 << curr;
            while (curr + drop < max2) {
              left -= count[curr + drop];
              if (left <= 0) {
                break;
              }
              curr++;
              left <<= 1;
            }
            used += 1 << curr;
            if (type === LENS && used > ENOUGH_LENS || type === DISTS && used > ENOUGH_DISTS) {
              return 1;
            }
            low = huff & mask;
            table[low] = root << 24 | curr << 16 | next - table_index | 0;
          }
        }
        if (huff !== 0) {
          table[next + huff] = len - drop << 24 | 64 << 16 | 0;
        }
        opts.bits = root;
        return 0;
      };
      module.exports = inflate_table;
    }
  });

  // node_modules/pako/lib/zlib/inflate.js
  var require_inflate = __commonJS({
    "node_modules/pako/lib/zlib/inflate.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var adler32 = require_adler32();
      var crc32 = require_crc322();
      var inflate_fast = require_inffast();
      var inflate_table = require_inftrees();
      var CODES = 0;
      var LENS = 1;
      var DISTS = 2;
      var {
        Z_FINISH,
        Z_BLOCK,
        Z_TREES,
        Z_OK,
        Z_STREAM_END,
        Z_NEED_DICT,
        Z_STREAM_ERROR,
        Z_DATA_ERROR,
        Z_MEM_ERROR,
        Z_BUF_ERROR,
        Z_DEFLATED
      } = require_constants2();
      var HEAD = 16180;
      var FLAGS = 16181;
      var TIME = 16182;
      var OS = 16183;
      var EXLEN = 16184;
      var EXTRA = 16185;
      var NAME = 16186;
      var COMMENT = 16187;
      var HCRC = 16188;
      var DICTID = 16189;
      var DICT = 16190;
      var TYPE = 16191;
      var TYPEDO = 16192;
      var STORED = 16193;
      var COPY_ = 16194;
      var COPY = 16195;
      var TABLE = 16196;
      var LENLENS = 16197;
      var CODELENS = 16198;
      var LEN_ = 16199;
      var LEN = 16200;
      var LENEXT = 16201;
      var DIST = 16202;
      var DISTEXT = 16203;
      var MATCH = 16204;
      var LIT = 16205;
      var CHECK = 16206;
      var LENGTH = 16207;
      var DONE = 16208;
      var BAD = 16209;
      var MEM = 16210;
      var SYNC = 16211;
      var ENOUGH_LENS = 852;
      var ENOUGH_DISTS = 592;
      var MAX_WBITS = 15;
      var DEF_WBITS = MAX_WBITS;
      var zswap32 = (q) => {
        return (q >>> 24 & 255) + (q >>> 8 & 65280) + ((q & 65280) << 8) + ((q & 255) << 24);
      };
      function InflateState() {
        this.strm = null;
        this.mode = 0;
        this.last = false;
        this.wrap = 0;
        this.havedict = false;
        this.flags = 0;
        this.dmax = 0;
        this.check = 0;
        this.total = 0;
        this.head = null;
        this.wbits = 0;
        this.wsize = 0;
        this.whave = 0;
        this.wnext = 0;
        this.window = null;
        this.hold = 0;
        this.bits = 0;
        this.length = 0;
        this.offset = 0;
        this.extra = 0;
        this.lencode = null;
        this.distcode = null;
        this.lenbits = 0;
        this.distbits = 0;
        this.ncode = 0;
        this.nlen = 0;
        this.ndist = 0;
        this.have = 0;
        this.next = null;
        this.lens = new Uint16Array(320);
        this.work = new Uint16Array(288);
        this.lendyn = null;
        this.distdyn = null;
        this.sane = 0;
        this.back = 0;
        this.was = 0;
      }
      var inflateStateCheck = (strm) => {
        if (!strm) {
          return 1;
        }
        const state = strm.state;
        if (!state || state.strm !== strm || state.mode < HEAD || state.mode > SYNC) {
          return 1;
        }
        return 0;
      };
      var inflateResetKeep = (strm) => {
        if (inflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        const state = strm.state;
        strm.total_in = strm.total_out = state.total = 0;
        strm.msg = "";
        if (state.wrap) {
          strm.adler = state.wrap & 1;
        }
        state.mode = HEAD;
        state.last = 0;
        state.havedict = 0;
        state.flags = -1;
        state.dmax = 32768;
        state.head = null;
        state.hold = 0;
        state.bits = 0;
        state.lencode = state.lendyn = new Int32Array(ENOUGH_LENS);
        state.distcode = state.distdyn = new Int32Array(ENOUGH_DISTS);
        state.sane = 1;
        state.back = -1;
        return Z_OK;
      };
      var inflateReset = (strm) => {
        if (inflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        const state = strm.state;
        state.wsize = 0;
        state.whave = 0;
        state.wnext = 0;
        return inflateResetKeep(strm);
      };
      var inflateReset2 = (strm, windowBits) => {
        let wrap;
        if (inflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        const state = strm.state;
        if (windowBits < 0) {
          wrap = 0;
          windowBits = -windowBits;
        } else {
          wrap = (windowBits >> 4) + 5;
          if (windowBits < 48) {
            windowBits &= 15;
          }
        }
        if (windowBits && (windowBits < 8 || windowBits > 15)) {
          return Z_STREAM_ERROR;
        }
        if (state.window !== null && state.wbits !== windowBits) {
          state.window = null;
        }
        state.wrap = wrap;
        state.wbits = windowBits;
        return inflateReset(strm);
      };
      var inflateInit2 = (strm, windowBits) => {
        if (!strm) {
          return Z_STREAM_ERROR;
        }
        const state = new InflateState();
        strm.state = state;
        state.strm = strm;
        state.window = null;
        state.mode = HEAD;
        const ret = inflateReset2(strm, windowBits);
        if (ret !== Z_OK) {
          strm.state = null;
        }
        return ret;
      };
      var inflateInit = (strm) => {
        return inflateInit2(strm, DEF_WBITS);
      };
      var virgin = true;
      var lenfix;
      var distfix;
      var fixedtables = (state) => {
        if (virgin) {
          lenfix = new Int32Array(512);
          distfix = new Int32Array(32);
          let sym = 0;
          while (sym < 144) {
            state.lens[sym++] = 8;
          }
          while (sym < 256) {
            state.lens[sym++] = 9;
          }
          while (sym < 280) {
            state.lens[sym++] = 7;
          }
          while (sym < 288) {
            state.lens[sym++] = 8;
          }
          inflate_table(LENS, state.lens, 0, 288, lenfix, 0, state.work, { bits: 9 });
          sym = 0;
          while (sym < 32) {
            state.lens[sym++] = 5;
          }
          inflate_table(DISTS, state.lens, 0, 32, distfix, 0, state.work, { bits: 5 });
          virgin = false;
        }
        state.lencode = lenfix;
        state.lenbits = 9;
        state.distcode = distfix;
        state.distbits = 5;
      };
      var updatewindow = (strm, src, end, copy2) => {
        let dist;
        const state = strm.state;
        if (state.window === null) {
          state.wsize = 1 << state.wbits;
          state.wnext = 0;
          state.whave = 0;
          state.window = new Uint8Array(state.wsize);
        }
        if (copy2 >= state.wsize) {
          state.window.set(src.subarray(end - state.wsize, end), 0);
          state.wnext = 0;
          state.whave = state.wsize;
        } else {
          dist = state.wsize - state.wnext;
          if (dist > copy2) {
            dist = copy2;
          }
          state.window.set(src.subarray(end - copy2, end - copy2 + dist), state.wnext);
          copy2 -= dist;
          if (copy2) {
            state.window.set(src.subarray(end - copy2, end), 0);
            state.wnext = copy2;
            state.whave = state.wsize;
          } else {
            state.wnext += dist;
            if (state.wnext === state.wsize) {
              state.wnext = 0;
            }
            if (state.whave < state.wsize) {
              state.whave += dist;
            }
          }
        }
        return 0;
      };
      var inflate = (strm, flush) => {
        let state;
        let input, output;
        let next;
        let put;
        let have, left;
        let hold;
        let bits;
        let _in, _out;
        let copy2;
        let from;
        let from_source;
        let here = 0;
        let here_bits, here_op, here_val;
        let last_bits, last_op, last_val;
        let len;
        let ret;
        const hbuf = new Uint8Array(4);
        let opts;
        let n;
        const order = (
          /* permutation of code lengths */
          new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])
        );
        if (inflateStateCheck(strm) || !strm.output || !strm.input && strm.avail_in !== 0) {
          return Z_STREAM_ERROR;
        }
        state = strm.state;
        if (state.mode === TYPE) {
          state.mode = TYPEDO;
        }
        put = strm.next_out;
        output = strm.output;
        left = strm.avail_out;
        next = strm.next_in;
        input = strm.input;
        have = strm.avail_in;
        hold = state.hold;
        bits = state.bits;
        _in = have;
        _out = left;
        ret = Z_OK;
        inf_leave:
          for (; ; ) {
            switch (state.mode) {
              case HEAD:
                if (state.wrap === 0) {
                  state.mode = TYPEDO;
                  break;
                }
                while (bits < 16) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if (state.wrap & 2 && hold === 35615) {
                  if (state.wbits === 0) {
                    state.wbits = 15;
                  }
                  state.check = 0;
                  hbuf[0] = hold & 255;
                  hbuf[1] = hold >>> 8 & 255;
                  state.check = crc32(state.check, hbuf, 2, 0);
                  hold = 0;
                  bits = 0;
                  state.mode = FLAGS;
                  break;
                }
                if (state.head) {
                  state.head.done = false;
                }
                if (!(state.wrap & 1) || /* check if zlib header allowed */
                (((hold & 255) << 8) + (hold >> 8)) % 31) {
                  strm.msg = "incorrect header check";
                  state.mode = BAD;
                  break;
                }
                if ((hold & 15) !== Z_DEFLATED) {
                  strm.msg = "unknown compression method";
                  state.mode = BAD;
                  break;
                }
                hold >>>= 4;
                bits -= 4;
                len = (hold & 15) + 8;
                if (state.wbits === 0) {
                  state.wbits = len;
                }
                if (len > 15 || len > state.wbits) {
                  strm.msg = "invalid window size";
                  state.mode = BAD;
                  break;
                }
                state.dmax = 1 << state.wbits;
                state.flags = 0;
                strm.adler = state.check = 1;
                state.mode = hold & 512 ? DICTID : TYPE;
                hold = 0;
                bits = 0;
                break;
              case FLAGS:
                while (bits < 16) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                state.flags = hold;
                if ((state.flags & 255) !== Z_DEFLATED) {
                  strm.msg = "unknown compression method";
                  state.mode = BAD;
                  break;
                }
                if (state.flags & 57344) {
                  strm.msg = "unknown header flags set";
                  state.mode = BAD;
                  break;
                }
                if (state.head) {
                  state.head.text = hold >> 8 & 1;
                }
                if (state.flags & 512 && state.wrap & 4) {
                  hbuf[0] = hold & 255;
                  hbuf[1] = hold >>> 8 & 255;
                  state.check = crc32(state.check, hbuf, 2, 0);
                }
                hold = 0;
                bits = 0;
                state.mode = TIME;
              /* falls through */
              case TIME:
                while (bits < 32) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if (state.head) {
                  state.head.time = hold;
                }
                if (state.flags & 512 && state.wrap & 4) {
                  hbuf[0] = hold & 255;
                  hbuf[1] = hold >>> 8 & 255;
                  hbuf[2] = hold >>> 16 & 255;
                  hbuf[3] = hold >>> 24 & 255;
                  state.check = crc32(state.check, hbuf, 4, 0);
                }
                hold = 0;
                bits = 0;
                state.mode = OS;
              /* falls through */
              case OS:
                while (bits < 16) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if (state.head) {
                  state.head.xflags = hold & 255;
                  state.head.os = hold >> 8;
                }
                if (state.flags & 512 && state.wrap & 4) {
                  hbuf[0] = hold & 255;
                  hbuf[1] = hold >>> 8 & 255;
                  state.check = crc32(state.check, hbuf, 2, 0);
                }
                hold = 0;
                bits = 0;
                state.mode = EXLEN;
              /* falls through */
              case EXLEN:
                if (state.flags & 1024) {
                  while (bits < 16) {
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  state.length = hold;
                  if (state.head) {
                    state.head.extra_len = hold;
                  }
                  if (state.flags & 512 && state.wrap & 4) {
                    hbuf[0] = hold & 255;
                    hbuf[1] = hold >>> 8 & 255;
                    state.check = crc32(state.check, hbuf, 2, 0);
                  }
                  hold = 0;
                  bits = 0;
                } else if (state.head) {
                  state.head.extra = null;
                }
                state.mode = EXTRA;
              /* falls through */
              case EXTRA:
                if (state.flags & 1024) {
                  copy2 = state.length;
                  if (copy2 > have) {
                    copy2 = have;
                  }
                  if (copy2) {
                    if (state.head) {
                      len = state.head.extra_len - state.length;
                      if (!state.head.extra) {
                        state.head.extra = new Uint8Array(state.head.extra_len);
                      }
                      state.head.extra.set(
                        input.subarray(
                          next,
                          // extra field is limited to 65536 bytes
                          // - no need for additional size check
                          next + copy2
                        ),
                        /*len + copy > state.head.extra_max - len ? state.head.extra_max : copy,*/
                        len
                      );
                    }
                    if (state.flags & 512 && state.wrap & 4) {
                      state.check = crc32(state.check, input, copy2, next);
                    }
                    have -= copy2;
                    next += copy2;
                    state.length -= copy2;
                  }
                  if (state.length) {
                    break inf_leave;
                  }
                }
                state.length = 0;
                state.mode = NAME;
              /* falls through */
              case NAME:
                if (state.flags & 2048) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  copy2 = 0;
                  do {
                    len = input[next + copy2++];
                    if (state.head && len && state.length < 65536) {
                      state.head.name += String.fromCharCode(len);
                    }
                  } while (len && copy2 < have);
                  if (state.flags & 512 && state.wrap & 4) {
                    state.check = crc32(state.check, input, copy2, next);
                  }
                  have -= copy2;
                  next += copy2;
                  if (len) {
                    break inf_leave;
                  }
                } else if (state.head) {
                  state.head.name = null;
                }
                state.length = 0;
                state.mode = COMMENT;
              /* falls through */
              case COMMENT:
                if (state.flags & 4096) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  copy2 = 0;
                  do {
                    len = input[next + copy2++];
                    if (state.head && len && state.length < 65536) {
                      state.head.comment += String.fromCharCode(len);
                    }
                  } while (len && copy2 < have);
                  if (state.flags & 512 && state.wrap & 4) {
                    state.check = crc32(state.check, input, copy2, next);
                  }
                  have -= copy2;
                  next += copy2;
                  if (len) {
                    break inf_leave;
                  }
                } else if (state.head) {
                  state.head.comment = null;
                }
                state.mode = HCRC;
              /* falls through */
              case HCRC:
                if (state.flags & 512) {
                  while (bits < 16) {
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  if (state.wrap & 4 && hold !== (state.check & 65535)) {
                    strm.msg = "header crc mismatch";
                    state.mode = BAD;
                    break;
                  }
                  hold = 0;
                  bits = 0;
                }
                if (state.head) {
                  state.head.hcrc = state.flags >> 9 & 1;
                  state.head.done = true;
                }
                strm.adler = state.check = 0;
                state.mode = TYPE;
                break;
              case DICTID:
                while (bits < 32) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                strm.adler = state.check = zswap32(hold);
                hold = 0;
                bits = 0;
                state.mode = DICT;
              /* falls through */
              case DICT:
                if (state.havedict === 0) {
                  strm.next_out = put;
                  strm.avail_out = left;
                  strm.next_in = next;
                  strm.avail_in = have;
                  state.hold = hold;
                  state.bits = bits;
                  return Z_NEED_DICT;
                }
                strm.adler = state.check = 1;
                state.mode = TYPE;
              /* falls through */
              case TYPE:
                if (flush === Z_BLOCK || flush === Z_TREES) {
                  break inf_leave;
                }
              /* falls through */
              case TYPEDO:
                if (state.last) {
                  hold >>>= bits & 7;
                  bits -= bits & 7;
                  state.mode = CHECK;
                  break;
                }
                while (bits < 3) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                state.last = hold & 1;
                hold >>>= 1;
                bits -= 1;
                switch (hold & 3) {
                  case 0:
                    state.mode = STORED;
                    break;
                  case 1:
                    fixedtables(state);
                    state.mode = LEN_;
                    if (flush === Z_TREES) {
                      hold >>>= 2;
                      bits -= 2;
                      break inf_leave;
                    }
                    break;
                  case 2:
                    state.mode = TABLE;
                    break;
                  case 3:
                    strm.msg = "invalid block type";
                    state.mode = BAD;
                }
                hold >>>= 2;
                bits -= 2;
                break;
              case STORED:
                hold >>>= bits & 7;
                bits -= bits & 7;
                while (bits < 32) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if ((hold & 65535) !== (hold >>> 16 ^ 65535)) {
                  strm.msg = "invalid stored block lengths";
                  state.mode = BAD;
                  break;
                }
                state.length = hold & 65535;
                hold = 0;
                bits = 0;
                state.mode = COPY_;
                if (flush === Z_TREES) {
                  break inf_leave;
                }
              /* falls through */
              case COPY_:
                state.mode = COPY;
              /* falls through */
              case COPY:
                copy2 = state.length;
                if (copy2) {
                  if (copy2 > have) {
                    copy2 = have;
                  }
                  if (copy2 > left) {
                    copy2 = left;
                  }
                  if (copy2 === 0) {
                    break inf_leave;
                  }
                  output.set(input.subarray(next, next + copy2), put);
                  have -= copy2;
                  next += copy2;
                  left -= copy2;
                  put += copy2;
                  state.length -= copy2;
                  break;
                }
                state.mode = TYPE;
                break;
              case TABLE:
                while (bits < 14) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                state.nlen = (hold & 31) + 257;
                hold >>>= 5;
                bits -= 5;
                state.ndist = (hold & 31) + 1;
                hold >>>= 5;
                bits -= 5;
                state.ncode = (hold & 15) + 4;
                hold >>>= 4;
                bits -= 4;
                if (state.nlen > 286 || state.ndist > 30) {
                  strm.msg = "too many length or distance symbols";
                  state.mode = BAD;
                  break;
                }
                state.have = 0;
                state.mode = LENLENS;
              /* falls through */
              case LENLENS:
                while (state.have < state.ncode) {
                  while (bits < 3) {
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  state.lens[order[state.have++]] = hold & 7;
                  hold >>>= 3;
                  bits -= 3;
                }
                while (state.have < 19) {
                  state.lens[order[state.have++]] = 0;
                }
                state.lencode = state.lendyn;
                state.lenbits = 7;
                opts = { bits: state.lenbits };
                ret = inflate_table(CODES, state.lens, 0, 19, state.lencode, 0, state.work, opts);
                state.lenbits = opts.bits;
                if (ret) {
                  strm.msg = "invalid code lengths set";
                  state.mode = BAD;
                  break;
                }
                state.have = 0;
                state.mode = CODELENS;
              /* falls through */
              case CODELENS:
                while (state.have < state.nlen + state.ndist) {
                  for (; ; ) {
                    here = state.lencode[hold & (1 << state.lenbits) - 1];
                    here_bits = here >>> 24;
                    here_op = here >>> 16 & 255;
                    here_val = here & 65535;
                    if (here_bits <= bits) {
                      break;
                    }
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  if (here_val < 16) {
                    hold >>>= here_bits;
                    bits -= here_bits;
                    state.lens[state.have++] = here_val;
                  } else {
                    if (here_val === 16) {
                      n = here_bits + 2;
                      while (bits < n) {
                        if (have === 0) {
                          break inf_leave;
                        }
                        have--;
                        hold += input[next++] << bits;
                        bits += 8;
                      }
                      hold >>>= here_bits;
                      bits -= here_bits;
                      if (state.have === 0) {
                        strm.msg = "invalid bit length repeat";
                        state.mode = BAD;
                        break;
                      }
                      len = state.lens[state.have - 1];
                      copy2 = 3 + (hold & 3);
                      hold >>>= 2;
                      bits -= 2;
                    } else if (here_val === 17) {
                      n = here_bits + 3;
                      while (bits < n) {
                        if (have === 0) {
                          break inf_leave;
                        }
                        have--;
                        hold += input[next++] << bits;
                        bits += 8;
                      }
                      hold >>>= here_bits;
                      bits -= here_bits;
                      len = 0;
                      copy2 = 3 + (hold & 7);
                      hold >>>= 3;
                      bits -= 3;
                    } else {
                      n = here_bits + 7;
                      while (bits < n) {
                        if (have === 0) {
                          break inf_leave;
                        }
                        have--;
                        hold += input[next++] << bits;
                        bits += 8;
                      }
                      hold >>>= here_bits;
                      bits -= here_bits;
                      len = 0;
                      copy2 = 11 + (hold & 127);
                      hold >>>= 7;
                      bits -= 7;
                    }
                    if (state.have + copy2 > state.nlen + state.ndist) {
                      strm.msg = "invalid bit length repeat";
                      state.mode = BAD;
                      break;
                    }
                    while (copy2--) {
                      state.lens[state.have++] = len;
                    }
                  }
                }
                if (state.mode === BAD) {
                  break;
                }
                if (state.lens[256] === 0) {
                  strm.msg = "invalid code -- missing end-of-block";
                  state.mode = BAD;
                  break;
                }
                state.lenbits = 9;
                opts = { bits: state.lenbits };
                ret = inflate_table(LENS, state.lens, 0, state.nlen, state.lencode, 0, state.work, opts);
                state.lenbits = opts.bits;
                if (ret) {
                  strm.msg = "invalid literal/lengths set";
                  state.mode = BAD;
                  break;
                }
                state.distbits = 6;
                state.distcode = state.distdyn;
                opts = { bits: state.distbits };
                ret = inflate_table(DISTS, state.lens, state.nlen, state.ndist, state.distcode, 0, state.work, opts);
                state.distbits = opts.bits;
                if (ret) {
                  strm.msg = "invalid distances set";
                  state.mode = BAD;
                  break;
                }
                state.mode = LEN_;
                if (flush === Z_TREES) {
                  break inf_leave;
                }
              /* falls through */
              case LEN_:
                state.mode = LEN;
              /* falls through */
              case LEN:
                if (have >= 6 && left >= 258) {
                  strm.next_out = put;
                  strm.avail_out = left;
                  strm.next_in = next;
                  strm.avail_in = have;
                  state.hold = hold;
                  state.bits = bits;
                  inflate_fast(strm, _out);
                  put = strm.next_out;
                  output = strm.output;
                  left = strm.avail_out;
                  next = strm.next_in;
                  input = strm.input;
                  have = strm.avail_in;
                  hold = state.hold;
                  bits = state.bits;
                  if (state.mode === TYPE) {
                    state.back = -1;
                  }
                  break;
                }
                state.back = 0;
                for (; ; ) {
                  here = state.lencode[hold & (1 << state.lenbits) - 1];
                  here_bits = here >>> 24;
                  here_op = here >>> 16 & 255;
                  here_val = here & 65535;
                  if (here_bits <= bits) {
                    break;
                  }
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if (here_op && (here_op & 240) === 0) {
                  last_bits = here_bits;
                  last_op = here_op;
                  last_val = here_val;
                  for (; ; ) {
                    here = state.lencode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
                    here_bits = here >>> 24;
                    here_op = here >>> 16 & 255;
                    here_val = here & 65535;
                    if (last_bits + here_bits <= bits) {
                      break;
                    }
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  hold >>>= last_bits;
                  bits -= last_bits;
                  state.back += last_bits;
                }
                hold >>>= here_bits;
                bits -= here_bits;
                state.back += here_bits;
                state.length = here_val;
                if (here_op === 0) {
                  state.mode = LIT;
                  break;
                }
                if (here_op & 32) {
                  state.back = -1;
                  state.mode = TYPE;
                  break;
                }
                if (here_op & 64) {
                  strm.msg = "invalid literal/length code";
                  state.mode = BAD;
                  break;
                }
                state.extra = here_op & 15;
                state.mode = LENEXT;
              /* falls through */
              case LENEXT:
                if (state.extra) {
                  n = state.extra;
                  while (bits < n) {
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  state.length += hold & (1 << state.extra) - 1;
                  hold >>>= state.extra;
                  bits -= state.extra;
                  state.back += state.extra;
                }
                state.was = state.length;
                state.mode = DIST;
              /* falls through */
              case DIST:
                for (; ; ) {
                  here = state.distcode[hold & (1 << state.distbits) - 1];
                  here_bits = here >>> 24;
                  here_op = here >>> 16 & 255;
                  here_val = here & 65535;
                  if (here_bits <= bits) {
                    break;
                  }
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if ((here_op & 240) === 0) {
                  last_bits = here_bits;
                  last_op = here_op;
                  last_val = here_val;
                  for (; ; ) {
                    here = state.distcode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
                    here_bits = here >>> 24;
                    here_op = here >>> 16 & 255;
                    here_val = here & 65535;
                    if (last_bits + here_bits <= bits) {
                      break;
                    }
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  hold >>>= last_bits;
                  bits -= last_bits;
                  state.back += last_bits;
                }
                hold >>>= here_bits;
                bits -= here_bits;
                state.back += here_bits;
                if (here_op & 64) {
                  strm.msg = "invalid distance code";
                  state.mode = BAD;
                  break;
                }
                state.offset = here_val;
                state.extra = here_op & 15;
                state.mode = DISTEXT;
              /* falls through */
              case DISTEXT:
                if (state.extra) {
                  n = state.extra;
                  while (bits < n) {
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  state.offset += hold & (1 << state.extra) - 1;
                  hold >>>= state.extra;
                  bits -= state.extra;
                  state.back += state.extra;
                }
                if (state.offset > state.dmax) {
                  strm.msg = "invalid distance too far back";
                  state.mode = BAD;
                  break;
                }
                state.mode = MATCH;
              /* falls through */
              case MATCH:
                if (left === 0) {
                  break inf_leave;
                }
                copy2 = _out - left;
                if (state.offset > copy2) {
                  copy2 = state.offset - copy2;
                  if (copy2 > state.whave) {
                    if (state.sane) {
                      strm.msg = "invalid distance too far back";
                      state.mode = BAD;
                      break;
                    }
                  }
                  if (copy2 > state.wnext) {
                    copy2 -= state.wnext;
                    from = state.wsize - copy2;
                  } else {
                    from = state.wnext - copy2;
                  }
                  if (copy2 > state.length) {
                    copy2 = state.length;
                  }
                  from_source = state.window;
                } else {
                  from_source = output;
                  from = put - state.offset;
                  copy2 = state.length;
                }
                if (copy2 > left) {
                  copy2 = left;
                }
                left -= copy2;
                state.length -= copy2;
                do {
                  output[put++] = from_source[from++];
                } while (--copy2);
                if (state.length === 0) {
                  state.mode = LEN;
                }
                break;
              case LIT:
                if (left === 0) {
                  break inf_leave;
                }
                output[put++] = state.length;
                left--;
                state.mode = LEN;
                break;
              case CHECK:
                if (state.wrap) {
                  while (bits < 32) {
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold |= input[next++] << bits;
                    bits += 8;
                  }
                  _out -= left;
                  strm.total_out += _out;
                  state.total += _out;
                  if (state.wrap & 4 && _out) {
                    strm.adler = state.check = /*UPDATE_CHECK(state.check, put - _out, _out);*/
                    state.flags ? crc32(state.check, output, _out, put - _out) : adler32(state.check, output, _out, put - _out);
                  }
                  _out = left;
                  if (state.wrap & 4 && (state.flags ? hold : zswap32(hold)) !== state.check) {
                    strm.msg = "incorrect data check";
                    state.mode = BAD;
                    break;
                  }
                  hold = 0;
                  bits = 0;
                }
                state.mode = LENGTH;
              /* falls through */
              case LENGTH:
                if (state.wrap && state.flags) {
                  while (bits < 32) {
                    if (have === 0) {
                      break inf_leave;
                    }
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  if (state.wrap & 4 && hold !== (state.total & 4294967295)) {
                    strm.msg = "incorrect length check";
                    state.mode = BAD;
                    break;
                  }
                  hold = 0;
                  bits = 0;
                }
                state.mode = DONE;
              /* falls through */
              case DONE:
                ret = Z_STREAM_END;
                break inf_leave;
              case BAD:
                ret = Z_DATA_ERROR;
                break inf_leave;
              case MEM:
                return Z_MEM_ERROR;
              case SYNC:
              /* falls through */
              default:
                return Z_STREAM_ERROR;
            }
          }
        strm.next_out = put;
        strm.avail_out = left;
        strm.next_in = next;
        strm.avail_in = have;
        state.hold = hold;
        state.bits = bits;
        if (state.wsize || _out !== strm.avail_out && state.mode < BAD && (state.mode < CHECK || flush !== Z_FINISH)) {
          if (updatewindow(strm, strm.output, strm.next_out, _out - strm.avail_out)) {
            state.mode = MEM;
            return Z_MEM_ERROR;
          }
        }
        _in -= strm.avail_in;
        _out -= strm.avail_out;
        strm.total_in += _in;
        strm.total_out += _out;
        state.total += _out;
        if (state.wrap & 4 && _out) {
          strm.adler = state.check = /*UPDATE_CHECK(state.check, strm.next_out - _out, _out);*/
          state.flags ? crc32(state.check, output, _out, strm.next_out - _out) : adler32(state.check, output, _out, strm.next_out - _out);
        }
        strm.data_type = state.bits + (state.last ? 64 : 0) + (state.mode === TYPE ? 128 : 0) + (state.mode === LEN_ || state.mode === COPY_ ? 256 : 0);
        if ((_in === 0 && _out === 0 || flush === Z_FINISH) && ret === Z_OK) {
          ret = Z_BUF_ERROR;
        }
        return ret;
      };
      var inflateEnd = (strm) => {
        if (inflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        let state = strm.state;
        if (state.window) {
          state.window = null;
        }
        strm.state = null;
        return Z_OK;
      };
      var inflateGetHeader = (strm, head) => {
        if (inflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        const state = strm.state;
        if ((state.wrap & 2) === 0) {
          return Z_STREAM_ERROR;
        }
        state.head = head;
        head.done = false;
        return Z_OK;
      };
      var inflateSetDictionary = (strm, dictionary) => {
        const dictLength = dictionary.length;
        let state;
        let dictid;
        let ret;
        if (inflateStateCheck(strm)) {
          return Z_STREAM_ERROR;
        }
        state = strm.state;
        if (state.wrap !== 0 && state.mode !== DICT) {
          return Z_STREAM_ERROR;
        }
        if (state.mode === DICT) {
          dictid = 1;
          dictid = adler32(dictid, dictionary, dictLength, 0);
          if (dictid !== state.check) {
            return Z_DATA_ERROR;
          }
        }
        ret = updatewindow(strm, dictionary, dictLength, dictLength);
        if (ret) {
          state.mode = MEM;
          return Z_MEM_ERROR;
        }
        state.havedict = 1;
        return Z_OK;
      };
      module.exports.inflateReset = inflateReset;
      module.exports.inflateReset2 = inflateReset2;
      module.exports.inflateResetKeep = inflateResetKeep;
      module.exports.inflateInit = inflateInit;
      module.exports.inflateInit2 = inflateInit2;
      module.exports.inflate = inflate;
      module.exports.inflateEnd = inflateEnd;
      module.exports.inflateGetHeader = inflateGetHeader;
      module.exports.inflateSetDictionary = inflateSetDictionary;
      module.exports.inflateInfo = "pako inflate (from Nodeca project)";
    }
  });

  // node_modules/pako/lib/zlib/gzheader.js
  var require_gzheader = __commonJS({
    "node_modules/pako/lib/zlib/gzheader.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      function GZheader() {
        this.text = 0;
        this.time = 0;
        this.xflags = 0;
        this.os = 0;
        this.extra = null;
        this.extra_len = 0;
        this.name = "";
        this.comment = "";
        this.hcrc = 0;
        this.done = false;
      }
      module.exports = GZheader;
    }
  });

  // node_modules/pako/lib/inflate.js
  var require_inflate2 = __commonJS({
    "node_modules/pako/lib/inflate.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var zlib_inflate = require_inflate();
      var utils = require_common();
      var strings = require_strings();
      var msg = require_messages();
      var ZStream = require_zstream();
      var GZheader = require_gzheader();
      var toString = Object.prototype.toString;
      var {
        Z_NO_FLUSH,
        Z_FINISH,
        Z_OK,
        Z_STREAM_END,
        Z_NEED_DICT,
        Z_STREAM_ERROR,
        Z_DATA_ERROR,
        Z_MEM_ERROR
      } = require_constants2();
      function Inflate(options) {
        this.options = utils.assign({
          chunkSize: 1024 * 64,
          windowBits: 15,
          to: ""
        }, options || {});
        const opt = this.options;
        if (opt.raw && opt.windowBits >= 0 && opt.windowBits < 16) {
          opt.windowBits = -opt.windowBits;
          if (opt.windowBits === 0) {
            opt.windowBits = -15;
          }
        }
        if (opt.windowBits >= 0 && opt.windowBits < 16 && !(options && options.windowBits)) {
          opt.windowBits += 32;
        }
        if (opt.windowBits > 15 && opt.windowBits < 48) {
          if ((opt.windowBits & 15) === 0) {
            opt.windowBits |= 15;
          }
        }
        this.err = 0;
        this.msg = "";
        this.ended = false;
        this.chunks = [];
        this.strm = new ZStream();
        this.strm.avail_out = 0;
        let status = zlib_inflate.inflateInit2(
          this.strm,
          opt.windowBits
        );
        if (status !== Z_OK) {
          throw new Error(msg[status]);
        }
        this.header = new GZheader();
        zlib_inflate.inflateGetHeader(this.strm, this.header);
        if (opt.dictionary) {
          if (typeof opt.dictionary === "string") {
            opt.dictionary = strings.string2buf(opt.dictionary);
          } else if (toString.call(opt.dictionary) === "[object ArrayBuffer]") {
            opt.dictionary = new Uint8Array(opt.dictionary);
          }
          if (opt.raw) {
            status = zlib_inflate.inflateSetDictionary(this.strm, opt.dictionary);
            if (status !== Z_OK) {
              throw new Error(msg[status]);
            }
          }
        }
      }
      Inflate.prototype.push = function(data, flush_mode) {
        const strm = this.strm;
        const chunkSize = this.options.chunkSize;
        const dictionary = this.options.dictionary;
        let status, _flush_mode, last_avail_out;
        if (this.ended) return false;
        if (flush_mode === ~~flush_mode) _flush_mode = flush_mode;
        else _flush_mode = flush_mode === true ? Z_FINISH : Z_NO_FLUSH;
        if (toString.call(data) === "[object ArrayBuffer]") {
          strm.input = new Uint8Array(data);
        } else {
          strm.input = data;
        }
        strm.next_in = 0;
        strm.avail_in = strm.input.length;
        for (; ; ) {
          if (strm.avail_out === 0) {
            strm.output = new Uint8Array(chunkSize);
            strm.next_out = 0;
            strm.avail_out = chunkSize;
          }
          status = zlib_inflate.inflate(strm, _flush_mode);
          if (status === Z_NEED_DICT && dictionary) {
            status = zlib_inflate.inflateSetDictionary(strm, dictionary);
            if (status === Z_OK) {
              status = zlib_inflate.inflate(strm, _flush_mode);
            } else if (status === Z_DATA_ERROR) {
              status = Z_NEED_DICT;
            }
          }
          while (strm.avail_in > 0 && status === Z_STREAM_END && strm.state.wrap > 0 && data[strm.next_in] !== 0) {
            zlib_inflate.inflateReset(strm);
            status = zlib_inflate.inflate(strm, _flush_mode);
          }
          switch (status) {
            case Z_STREAM_ERROR:
            case Z_DATA_ERROR:
            case Z_NEED_DICT:
            case Z_MEM_ERROR:
              this.onEnd(status);
              this.ended = true;
              return false;
          }
          last_avail_out = strm.avail_out;
          if (strm.next_out) {
            if (strm.avail_out === 0 || status === Z_STREAM_END) {
              if (this.options.to === "string") {
                let next_out_utf8 = strings.utf8border(strm.output, strm.next_out);
                let tail = strm.next_out - next_out_utf8;
                let utf8str = strings.buf2string(strm.output, next_out_utf8);
                strm.next_out = tail;
                strm.avail_out = chunkSize - tail;
                if (tail) strm.output.set(strm.output.subarray(next_out_utf8, next_out_utf8 + tail), 0);
                this.onData(utf8str);
              } else {
                this.onData(strm.output.length === strm.next_out ? strm.output : strm.output.subarray(0, strm.next_out));
              }
            }
          }
          if (status === Z_OK && last_avail_out === 0) continue;
          if (status === Z_STREAM_END) {
            status = zlib_inflate.inflateEnd(this.strm);
            this.onEnd(status);
            this.ended = true;
            return true;
          }
          if (strm.avail_in === 0) break;
        }
        return true;
      };
      Inflate.prototype.onData = function(chunk) {
        this.chunks.push(chunk);
      };
      Inflate.prototype.onEnd = function(status) {
        if (status === Z_OK) {
          if (this.options.to === "string") {
            this.result = this.chunks.join("");
          } else {
            this.result = utils.flattenChunks(this.chunks);
          }
        }
        this.chunks = [];
        this.err = status;
        this.msg = this.strm.msg;
      };
      function inflate(input, options) {
        const inflator = new Inflate(options);
        inflator.push(input);
        if (inflator.err) throw inflator.msg || msg[inflator.err];
        return inflator.result;
      }
      function inflateRaw(input, options) {
        options = options || {};
        options.raw = true;
        return inflate(input, options);
      }
      module.exports.Inflate = Inflate;
      module.exports.inflate = inflate;
      module.exports.inflateRaw = inflateRaw;
      module.exports.ungzip = inflate;
      module.exports.constants = require_constants2();
    }
  });

  // node_modules/pako/index.js
  var require_pako = __commonJS({
    "node_modules/pako/index.js"(exports, module) {
      "use strict";
      init_inject_buffer();
      var { Deflate, deflate, deflateRaw, gzip } = require_deflate2();
      var { Inflate, inflate, inflateRaw, ungzip } = require_inflate2();
      var constants = require_constants2();
      module.exports.Deflate = Deflate;
      module.exports.deflate = deflate;
      module.exports.deflateRaw = deflateRaw;
      module.exports.gzip = gzip;
      module.exports.Inflate = Inflate;
      module.exports.inflate = inflate;
      module.exports.inflateRaw = inflateRaw;
      module.exports.ungzip = ungzip;
      module.exports.constants = constants;
    }
  });

  // node_modules/nexrad-level-2-data/src/gzipdecompress.js
  var require_gzipdecompress = __commonJS({
    "node_modules/nexrad-level-2-data/src/gzipdecompress.js"(exports, module) {
      init_inject_buffer();
      var pako = require_pako();
      var { RandomAccessFile, BIG_ENDIAN } = require_RandomAccessFile();
      module.exports = (raf) => {
        const data = pako.ungzip(raf.buffer);
        return new RandomAccessFile(Buffer.from(data), BIG_ENDIAN);
      };
    }
  });

  // node_modules/nexrad-level-2-data/src/decompress.js
  var require_decompress = __commonJS({
    "node_modules/nexrad-level-2-data/src/decompress.js"(exports, module) {
      init_inject_buffer();
      var bzip = require_lib();
      var gzipDecompress = require_gzipdecompress();
      var { RandomAccessFile, BIG_ENDIAN } = require_RandomAccessFile();
      var { FILE_HEADER_SIZE } = require_constants();
      var decompress = (raf) => {
        const gZipHeader = raf.read(2);
        raf.seek(0);
        if (gZipHeader[0] === 31 && gZipHeader[1] === 139) return gzipDecompress(raf);
        if (raf.getLength() <= FILE_HEADER_SIZE) return raf;
        let headerSize = 0;
        const compressionRecord = readCompressionHeader(raf);
        if (compressionRecord.header !== "BZh") {
          raf.seek(0);
          raf.skip(FILE_HEADER_SIZE);
          headerSize = FILE_HEADER_SIZE;
          const fullCompressionRecord = readCompressionHeader(raf);
          if (fullCompressionRecord.header !== "BZh") {
            raf.seek(0);
            return raf;
          }
        }
        const positions = [];
        raf.seek(raf.getPos() - 8);
        while (raf.getPos() < raf.getLength()) {
          const size = Math.abs(raf.readSInt4());
          positions.push({
            pos: raf.getPos(),
            size
          });
          raf.seek(raf.getPos() + size);
        }
        const outBuffers = [raf.buffer.slice(0, headerSize)];
        positions.forEach((block) => {
          const compressed = raf.buffer.slice(block.pos, block.pos + block.size);
          const output = bzip.decodeBlock(compressed, 32);
          outBuffers.push(output);
        });
        const outBuffer = Buffer.concat(outBuffers);
        return new RandomAccessFile(outBuffer, BIG_ENDIAN);
      };
      var readCompressionHeader = (raf) => ({
        size: raf.readInt(),
        header: raf.readString(3),
        block_size: raf.readString(1)
      });
      module.exports = decompress;
    }
  });

  // node_modules/nexrad-level-2-data/src/parseheader.js
  var require_parseheader = __commonJS({
    "node_modules/nexrad-level-2-data/src/parseheader.js"(exports, module) {
      init_inject_buffer();
      var { FILE_HEADER_SIZE } = require_constants();
      var parse = (raf) => {
        const identifier = raf.readString(6);
        if (identifier === "AR2V00" || identifier === "ARCHIV") {
          const header = {};
          header.version = raf.readString(2);
          raf.skip(".001".length);
          header.modified_julian_date = raf.readInt();
          header.milliseconds = raf.readInt();
          header.ICAO = raf.readString(4);
          raf.seek(0);
          header.raw = raf.read(FILE_HEADER_SIZE);
          return header;
        }
        raf.seek(0);
        return {};
      };
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-2-data/src/parsedata.js
  var require_parsedata = __commonJS({
    "node_modules/nexrad-level-2-data/src/parsedata.js"(exports, module) {
      init_inject_buffer();
      var { RandomAccessFile, BIG_ENDIAN } = require_RandomAccessFile();
      var { Level2Record } = require_Level2Record();
      var { RADAR_DATA_SIZE } = require_constants();
      var decompress = require_decompress();
      var parseHeader = require_parseheader();
      var parseData = (file, options) => {
        const rafCompressed = new RandomAccessFile(file, BIG_ENDIAN);
        const data = [];
        const raf = decompress(rafCompressed);
        const header = parseHeader(raf);
        let messageOffset31 = 0;
        let recordNumber = 0;
        let r;
        let vcp = {};
        let hasGaps = false;
        let isTruncated = false;
        if (raf.getPos() < raf.getLength()) {
          do {
            try {
              r = Level2Record(raf, recordNumber, messageOffset31, header, options);
              recordNumber += 1;
            } catch (e) {
              options.logger.warn(e);
              isTruncated = true;
              r = { finished: true };
            }
            if (!r.finished) {
              if (r.message_type === 31) {
                const messageSize = r.actual_size ?? r.message_size;
                hasGaps = true;
                messageOffset31 += messageSize * 2 + 12 - RADAR_DATA_SIZE;
              }
              if ([1, 5, 7, 31].includes(r.message_type)) {
                if (r?.record?.reflect || r?.record?.velocity || r?.record?.spectrum || r?.record?.zdr || r?.record?.phi || r?.record?.rho) data.push(r);
                if ([5, 7].includes(r.message_type)) vcp = r;
              }
            }
          } while (!r.finished);
        }
        return {
          data: groupAndSortScans(data),
          header,
          vcp,
          isTruncated,
          hasGaps
        };
      };
      var groupAndSortScans = (scans) => {
        const groups = [];
        scans.forEach((scan) => {
          const { elevation_number: elevationNumber } = scan.record;
          if (groups[elevationNumber]) {
            groups[elevationNumber].push(scan);
          } else {
            groups[elevationNumber] = [scan];
          }
        });
        return groups;
      };
      module.exports = parseData;
    }
  });

  // node_modules/nexrad-level-2-data/src/combinedata.js
  var require_combinedata = __commonJS({
    "node_modules/nexrad-level-2-data/src/combinedata.js"(exports, module) {
      init_inject_buffer();
      var combine = (...args) => {
        const rawData = args.flat(50);
        const output = {
          options: {},
          vcp: {},
          header: {},
          data: []
        };
        rawData.forEach((raw) => {
          output.elevation = raw.elevation ?? output.elevation;
          output.hasGaps = output.hasGaps || raw.hasGaps;
          output.isTruncated = output.isTruncated || raw.isTruncated;
          if (raw.options) output.options = { ...output.options, ...raw.options };
          if (raw.vcp) output.vcp = { ...output.vcp, ...raw.vcp };
          if (raw.header) output.header = { ...output.header, ...raw.header };
          if (raw.data) {
            raw.listElevations().forEach((elev) => {
              if (output.data[elev] === void 0) output.data[elev] = [];
              output.data[elev].push(...raw.data[elev]);
            });
          }
        });
        return output;
      };
      module.exports = combine;
    }
  });

  // node_modules/nexrad-level-2-data/src/index.js
  var require_src = __commonJS({
    "node_modules/nexrad-level-2-data/src/index.js"(exports, module) {
      init_inject_buffer();
      var parseData = require_parsedata();
      var combineData = require_combinedata();
      var Level2Radar2 = class _Level2Radar {
        /**
         * Parses a Nexrad Level 2 Data archive or chunk. Provide `rawData` as a `Buffer`. Returns an object formatted per the [ICD FOR RDA/RPG - Build RDA 20.0/RPG 20.0 (PDF)](https://www.roc.noaa.gov/wsr88d/PublicDocs/ICDs/2620002U.pdf), or as close as can reasonably be represented in a javascript object. Additional data accessors are provided in the returned object to pull out typical data in a format ready for processing.
         * Radar data is accessed through the get* methods
         *
         * @param {Buffer|Level2Radar} file Buffer with Nexrad Level 2 data. Alternatively a Level2Radar object, typically used internally when combining data.
         * @param {ParserOptions} [options] Parser options
         */
        constructor(file, options) {
          this.elevation = 1;
          if (file instanceof Buffer) {
            this.options = combineOptions(options);
            const {
              data,
              header,
              vcp,
              hasGaps,
              isTruncated
            } = parseData(file, this.options);
            this.data = data;
            this.header = header;
            this.vcp = vcp;
            this.hasGaps = hasGaps;
            this.isTruncated = isTruncated;
          } else if (typeof file === "object" && (file.data && file.header && file.vcp)) {
            this.data = file.data;
            this.elevation = file.elevation;
            this.header = file.header;
            this.options = file.options;
            this.vcp = file.vcp;
            this.hasGaps = file.hasGaps;
            this.isTruncated = file.isTruncated;
          } else {
            throw new Error("Unknown data provided");
          }
        }
        /**
         * Sets the elevation in use for get* methods
         *
         * @param {number} elevation Selected elevation number
         * @category Configuration
         */
        setElevation(elevation) {
          this.elevation = elevation;
        }
        /**
         * Returns an single azimuth value or array of azimuth values for the current elevation and scan (or all scans if not provided).
         * The order of azimuths in the returned array matches the order of the data in other get* functions.
         *
         * @param {number} [scan] Selected scan
         * @category Data
         * @returns {number|number[]} Azimuth angle
         */
        getAzimuth(scan) {
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getAzimuth invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            this._checkData();
            if (this?.data?.[this.elevation] === void 0) throw new Error(`getAzimuth invalid elevation selected: ${this.elevation}`);
            if (this?.data?.[this.elevation]?.[scan] === void 0) throw new Error(`getAzimuth invalid scan selected: ${scan}`);
            if (this?.data?.[this.elevation]?.[scan]?.record?.azimuth === void 0) throw new Error(`getAzimuth no data for elevation: ${this.elevation}, scan: ${scan}`);
            return this.data[this.elevation][scan].record.azimuth;
          }
          return this.data[this.elevation].map((i) => i.record.azimuth);
        }
        /**
         * Return the number of scans in the current elevation
         *
         * @category Metadata
         * @returns {number}
         */
        getScans() {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getScans no data for elevation: ${this.elevation}`);
          return this.data[this.elevation].length;
        }
        /**
         * Return message_header information for all scans or a specific scan for the selected elevation
         *
         * @category Metadata
         * @param {number} [scan] Selected scan, omit to return all scans for this elevation
         * @returns {MessageHeader}
         */
        getHeader(scan) {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getHeader invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            if (this?.data?.[this.elevation]?.[scan] === void 0) throw new Error(`getHeader invalid scan selected: ${scan}`);
            if (this?.data?.[this.elevation]?.[scan]?.record === void 0) throw new Error(`getHeader no data for elevation: ${this.elevation}, scan: ${scan}`);
            return this.data[this.elevation][scan].record;
          }
          return this.data[this.elevation].map(((i) => i.record));
        }
        /**
         * Returns an Object of radar reflectivity data for the current elevation and scan (or all scans if not provided)
         *
         * @category Data
         * @param {number} [scan] Selected scan or null for all scans in elevation
         * @returns {HighResData|HighResData[]} Scan's high res reflectivity data, or an array of the data.
         */
        getHighresReflectivity(scan) {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getHighresReflectivity invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            if (this?.data?.[this.elevation]?.[scan] === void 0) throw new Error(`getHighresReflectivity invalid scan selected: ${scan}`);
            if (this?.data?.[this.elevation]?.[scan]?.record?.reflect === void 0) throw new Error(`getHighresReflectivity no data for elevation: ${this.elevation}, scan: ${scan}`);
            return this.data[this.elevation][scan].record.reflect;
          }
          return this.data[this.elevation].map((i) => i.record.reflect);
        }
        /**
         * Returns an Object of radar velocity data for the current elevation and scan (or all scans if not provided)
         *
         * @category Data
         * @param {number} [scan] Selected scan, or null for all scans in this elevation
         * @returns {HighResData|HighResData[]} Scan's high res velocity data, or an array of the data.
         */
        getHighresVelocity(scan) {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getHighresVelocity invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            if (this?.data?.[this.elevation]?.[scan] === void 0) throw new Error(`getHighresVelocity invalid scan selected: ${scan}`);
            if (this?.data?.[this.elevation]?.[scan]?.record?.reflect === void 0) throw new Error(`getHighresVelocity no data for elevation: ${this.elevation}, scan: ${scan}`);
            return this.data[this.elevation][scan].record.velocity;
          }
          return this.data[this.elevation].map((i) => i.record.velocity);
        }
        /**
         * Returns an Object of radar spectrum data for the current elevation and scan (or all scans if not provided)
         *
         * @category Data
         * @param {number} [scan] Selected scan, or null for all scans in this elevation
         * @returns {HighResData|HighResData[]} Scan's high res spectrum data, or an array of the data.
         */
        getHighresSpectrum(scan) {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getHighresSpectrum invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            if (this?.data?.[this.elevation]?.[scan] === void 0) throw new Error(`getHighresSpectrum invalid scan selected: ${scan}`);
            if (this?.data?.[this.elevation]?.[scan]?.record?.spectrum === void 0) throw new Error(`getHighresSpectrum no data for elevation: ${this.elevation}, scan: ${scan}`);
            return this.data[this.elevation][scan].record.spectrum;
          }
          return this.data[this.elevation].map((i) => i.record.spectrum);
        }
        /**
         * Returns an Object of radar differential reflectivity data for the current elevation and scan (or all scans if not provided)
         *
         * @category Data
         * @param {number} [scan] Selected scan or null for all scans in elevation
         * @returns {HighResData|HighResData[]} Scan's high res differential reflectivity data, or an array of the data.
         */
        getHighresDiffReflectivity(scan) {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getHighresDiffReflectivity invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            if (this?.data?.[this.elevation]?.[this.scan] === void 0) throw new Error(`getHighresDiffReflectivity invalid scan selected: ${this.scan}`);
            if (this?.data?.[this.elevation]?.[this.scan]?.record?.zdr === void 0) throw new Error(`getHighresDiffReflectivity no data for elevation: ${this.elevation}, scan: ${this.scan}`);
            return this.data[this.elevation][this.scan].record.zdr;
          }
          return this.data[this.elevation].map((i) => i.record.zdr);
        }
        /**
         * Returns an Object of radar differential phase data for the current elevation and scan (or all scans if not provided)
         *
         * @category Data
         * @param {number} [scan] Selected scan or null for all scans in elevation
         * @returns {HighResData|HighResData[]} Scan's high res differential phase data, or an array of the data.
         */
        getHighresDiffPhase(scan) {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getHighresDiffPhase invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            if (this?.data?.[this.elevation]?.[this.scan] === void 0) throw new Error(`getHighresDiffPhase invalid scan selected: ${this.scan}`);
            if (this?.data?.[this.elevation]?.[this.scan]?.record?.phi === void 0) throw new Error(`getHighresDiffPhase no data for elevation: ${this.elevation}, scan: ${this.scan}`);
            return this.data[this.elevation][this.scan].record.phi;
          }
          return this.data[this.elevation].map((i) => i.record.phi);
        }
        /**
         * Returns an Object of radar correlation coefficient data for the current elevation and scan (or all scans if not provided)
         *
         * @category Data
         * @param {number} [scan] Selected scan or null for all scans in elevation
         * @returns {HighResData|HighResData[]} Scan's high res correlation coefficient data, or an array of the data.
         */
        getHighresCorrelationCoefficient(scan) {
          this._checkData();
          if (this?.data?.[this.elevation] === void 0) throw new Error(`getHighresCorrelationCoefficient invalid elevation selected: ${this.elevation}`);
          if (scan !== void 0) {
            if (this?.data?.[this.elevation]?.[this.scan] === void 0) throw new Error(`getHighresCorrelationCoefficient invalid scan selected: ${this.scan}`);
            if (this?.data?.[this.elevation]?.[this.scan]?.record?.rho === void 0) throw new Error(`getHighresCorrelationCoefficient no data for elevation: ${this.elevation}, scan: ${this.scan}`);
            return this.data[this.elevation][this.scan].record.rho;
          }
          return this.data[this.elevation].map((i) => i.record.rho);
        }
        /**
         * List all available elevations
         *
         * @category Metadata
         * @returns {number[]}
         */
        listElevations() {
          return Object.keys(this.data).map((key) => +key);
        }
        _checkData() {
          if (this.data.length === 0) throw new Error("No data found in file");
        }
        /**
         * Combines the data returned by multiple runs of the Level2Data constructor. This is typically used in "chunks" mode to combine all azimuths from one revolution into a single data set. data can be provided as an array of Level2Radar objects, individual Level2Data parameters or any combination thereof.
         *
         * The combine function blindly combines data and the right-most argument will overwrite any previously provided data. Individual azimuths located in Level2Radar.data[] will be appended. It is up to the calling routine to properly manage the parsing of related chunks and send it in to this routine.
         *
         * @param  {...Level2Radar} data Data to combine
         * @returns {Level2Radar} Combined data
         */
        static combineData(...data) {
          const combined = combineData(data);
          return new _Level2Radar(combined);
        }
      };
      var combineOptions = (newOptions) => {
        let logger = newOptions?.logger ?? console;
        if (logger === false) logger = nullLogger;
        return {
          ...newOptions,
          logger
        };
      };
      var nullLogger = {
        log: () => {
        },
        error: () => {
        },
        warn: () => {
        }
      };
      module.exports.Level2Radar = Level2Radar2;
    }
  });

  // node_modules/nexrad-level-3-data/src/randomaccessfile/index.js
  var require_randomaccessfile = __commonJS({
    "node_modules/nexrad-level-3-data/src/randomaccessfile/index.js"(exports, module) {
      init_inject_buffer();
      var BIG_ENDIAN = 0;
      var LITTLE_ENDIAN = 1;
      var RandomAccessFile = class {
        constructor(file, endian = BIG_ENDIAN, stringFormat = "utf-8") {
          this.offset = 0;
          this.buffer = null;
          this.stringFormat = stringFormat;
          if (endian < 0) return;
          this.bigEndian = endian === BIG_ENDIAN;
          if (typeof file === "string") {
            this.buffer = Buffer.from(file, "binary");
          } else {
            this.buffer = file;
          }
          if (this.bigEndian) {
            this.readFloatLocal = this.buffer.readFloatBE.bind(this.buffer);
            this.readIntLocal = this.buffer.readIntBE.bind(this.buffer);
            this.readUIntLocal = this.buffer.readUIntBE.bind(this.buffer);
          } else {
            this.readFloatLocal = this.buffer.readFloatLE.bind(this.buffer);
            this.readIntLocal = this.buffer.readIntLE.bind(this.buffer);
            this.readUIntLocal = this.buffer.readUIntLE.bind(this.buffer);
          }
        }
        // return the current buffer length
        getLength() {
          return this.buffer.length;
        }
        // return the current position in the file
        getPos() {
          return this.offset;
        }
        // seek to a provided buffer offset
        seek(byte) {
          this.offset = byte;
        }
        // read a string from the buffer
        readString(bytes) {
          const data = this.buffer.toString(this.stringFormat, this.offset, this.offset += bytes);
          return data;
        }
        // read a float from the buffer
        readFloat() {
          const float = this.readFloatLocal(this.offset);
          this.offset += 4;
          return float;
        }
        // read a number from the buffer
        readInt() {
          const int = this.readIntLocal(this.offset, 4);
          this.offset += 4;
          return int;
        }
        // read an unsigned number from the buffer
        readUInt() {
          const int = this.readUIntLocal(this.offset, 4);
          this.offset += 4;
          return int;
        }
        // read a short from the buffer
        readShort() {
          const short = this.readIntLocal(this.offset, 2);
          this.offset += 2;
          return short;
        }
        // read an unsigned short from the buffer
        readUShort() {
          const short = this.readUIntLocal(this.offset, 2);
          this.offset += 2;
          return short;
        }
        // read a byte from the buffer
        readByte() {
          return this.read()[0];
        }
        // read a set number of bytes from the buffer and return as an array
        read(bytes = 1) {
          const data = this.buffer.slice(this.offset, this.offset + bytes);
          this.offset += bytes;
          return data;
        }
        // skip a set number of bites and update the offset
        skip(bytes) {
          this.offset += bytes;
        }
      };
      module.exports.RandomAccessFile = RandomAccessFile;
      module.exports.BIG_ENDIAN = BIG_ENDIAN;
      module.exports.LITTLE_ENDIAN = LITTLE_ENDIAN;
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/text.js
  var require_text = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/text.js"(exports, module) {
      init_inject_buffer();
      var parse = (raf) => {
        const text = {};
        text.fileType = raf.readString(6);
        raf.readString(1);
        text.id = raf.readString(4);
        raf.readString(1);
        text.ddhhmm = raf.readString(6);
        raf.readString(3);
        text.type = raf.readString(3);
        text.id3 = raf.readString(3);
        raf.readString(3);
        return text;
      };
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/message.js
  var require_message = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/message.js"(exports, module) {
      init_inject_buffer();
      var parse = (raf) => ({
        code: raf.readShort(),
        julianDate: raf.readShort(),
        seconds: raf.readInt(),
        length: raf.readInt(),
        source: raf.readShort(),
        dest: raf.readShort(),
        blocks: raf.readShort()
      });
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/productdescription.js
  var require_productdescription = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/productdescription.js"(exports, module) {
      init_inject_buffer();
      var MODE_MAINTENANCE = 0;
      var MODE_CLEAN_AIR = 1;
      var MODE_PRECIPITATION = 2;
      var parse = (raf, product) => {
        const divider = raf.readShort();
        if (divider !== -1) throw new Error(`Invalid product description divider: ${divider}`);
        const result = {
          abbreviation: product.abbreviation,
          description: product.description,
          latitude: raf.readInt() / 1e3,
          longitude: raf.readInt() / 1e3,
          height: raf.readShort(),
          code: raf.readShort(),
          mode: raf.readShort(),
          vcp: raf.readShort(),
          sequenceNumber: raf.readShort(),
          volumeScanNumber: raf.readShort(),
          volumeScanDate: raf.readShort(),
          volumeScanTime: raf.readInt(),
          productDate: raf.readShort(),
          productTime: raf.readInt(),
          // halfwords 27-28 are product dependent
          ...product?.productDescription?.halfwords27_28?.(raf.read(4)) ?? { dependent27_28: raf.read(4) },
          elevationNumber: raf.readShort(),
          // halfwords 30-53 are product dependent
          ...product?.productDescription?.halfwords30_53?.(raf.read(48)) ?? { dependent30_53: raf.read(48) },
          version: raf.readByte(),
          spotBlank: raf.readByte(),
          offsetSymbology: raf.readInt(),
          offsetGraphic: raf.readInt(),
          offsetTabular: raf.readInt(),
          supplemental: product.supplemental
        };
        return result;
      };
      module.exports = {
        parse,
        MODE_MAINTENANCE,
        MODE_CLEAN_AIR,
        MODE_PRECIPITATION
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/symbologytext.js
  var require_symbologytext = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/symbologytext.js"(exports, module) {
      init_inject_buffer();
      var parse = (raf) => {
        const pages = [];
        let lines = [];
        let length = raf.readShort();
        do {
          while (length !== -1) {
            lines.push(raf.readString(length));
            length = raf.readShort();
          }
          pages.push(lines);
          lines = [];
          if (raf.getPos() < raf.getLength()) {
            length = raf.readShort();
          } else {
            length = -1;
          }
        } while (length === 80);
        raf.skip(-4);
        return { pages };
      };
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/symbology.js
  var require_symbology = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/symbology.js"(exports, module) {
      init_inject_buffer();
      var symbologyText = require_symbologytext();
      var textSymbologies = [3, 4, 5, 6, 7];
      var parse = (raf) => {
        const blockDivider = raf.readShort();
        const blockId = raf.readShort();
        if (textSymbologies.includes(blockId)) return symbologyText(raf);
        const blockLength = raf.readInt();
        if (blockDivider !== -1) throw new Error(`Invalid symbology block divider: ${blockDivider}`);
        if (blockId !== 1) throw new Error(`Invalid symbology id: ${blockId}`);
        if (blockLength + raf.getPos() - 8 > raf.getLength()) throw new Error(`Block length ${blockLength} overruns file length for block id: ${blockId}`);
        const result = {
          numberLayers: raf.readShort()
        };
        return result;
      };
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/tabular.js
  var require_tabular = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/tabular.js"(exports, module) {
      init_inject_buffer();
      var parseMessageHeader = require_message();
      var { parse: parseProductDescription } = require_productdescription();
      var parse = (raf, product) => {
        const blockDivider = raf.readShort();
        const blockId = raf.readShort();
        const blockLength = raf.readInt();
        if (blockDivider !== -1) throw new Error(`Invalid tabular block divider: ${blockDivider}`);
        if (blockId !== 3) throw new Error(`Invalid tabular id: ${blockId}`);
        if (blockLength < 1 || blockLength > 65535) throw new Error(`Invalid block length ${blockLength}`);
        if (blockLength + raf.getPos() - 8 > raf.getLength()) throw new Error(`Block length ${blockLength} overruns file length for block id: ${blockId}`);
        const messageHeader = parseMessageHeader(raf);
        const productDescription = parseProductDescription(raf, product);
        const blockDivider2 = raf.readShort();
        if (blockDivider2 !== -1) throw new Error(`Invalid second tabular block divider: ${blockDivider2}`);
        const result = {
          messageHeader,
          productDescription,
          totalPages: raf.readShort(),
          charactersPerLine: raf.readShort(),
          pages: []
        };
        for (let i = 0; i < result.totalPages; i += 1) {
          const lines = [];
          let line = "";
          let chars = raf.readShort();
          while (chars !== -1) {
            if (chars !== 80) {
              line += String.fromCharCode(chars >> 8);
              if (line.length % result.charactersPerLine === 0) {
                lines.push(line);
                line = "";
              }
              line += String.fromCharCode(chars & 255);
              if (line.length % result.charactersPerLine === 0) {
                lines.push(line);
                line = "";
              }
            }
            chars = raf.readShort();
          }
          result.pages.push(lines);
        }
        return result;
      };
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/1.js
  var require__ = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/1.js"(exports, module) {
      init_inject_buffer();
      var code = 1;
      var description = "Text and Special Symbol Packets";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          iStartingPoint: raf.readShort(),
          jStartingPoint: raf.readShort()
        };
        result.packetCodeHex = packetCode.toString(16);
        result.text = raf.readString(lengthOfBlock - 4);
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/2.js
  var require__2 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/2.js"(exports, module) {
      init_inject_buffer();
      var code = 2;
      var description = "Text and Special Symbol Packets";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          iStartingPoint: raf.readShort(),
          jStartingPoint: raf.readShort(),
          text: raf.readString(lengthOfBlock - 4)
        };
        result.packetCodeHex = packetCode.toString(16);
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/6.js
  var require__3 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/6.js"(exports, module) {
      init_inject_buffer();
      var code = 6;
      var description = "Linked Vector Packet";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          iStartingPoint: raf.readShort(),
          jStartingPoint: raf.readShort(),
          vectors: []
        };
        result.packetCodeHex = packetCode.toString(16);
        const endByte = raf.getPos() + lengthOfBlock - 4;
        while (raf.getPos() < endByte) {
          result.vectors.push({
            i: raf.readShort(),
            j: raf.readShort()
          });
        }
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/8.js
  var require__4 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/8.js"(exports, module) {
      init_inject_buffer();
      var code = 8;
      var description = "Text and Special Symbol Packets";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        const result = {
          color: raf.readShort(),
          iStartingPoint: raf.readShort(),
          jStartingPoint: raf.readShort()
        };
        result.packetCodeHex = packetCode.toString(16);
        result.text = raf.readString(lengthOfBlock - 6);
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/10.js
  var require__5 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/10.js"(exports, module) {
      init_inject_buffer();
      var code = 16;
      var description = "Digital Radial Data Array Packet";
      var parser = (raf, productDescription) => {
        const packetCode = raf.readUShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          firstBin: raf.readShort(),
          numberBins: raf.readShort(),
          iSweepCenter: raf.readShort(),
          jSweepCenter: raf.readShort(),
          rangeScale: raf.readShort() / 1e3,
          numberRadials: raf.readShort()
        };
        result.packetCodeHex = packetCode.toString(16);
        const scaling = {
          scale: productDescription?.plot?.scale ?? 1,
          offset: productDescription?.plot?.offset ?? 0
        };
        const scaled = [];
        let start = 0;
        if (productDescription?.plot?.leadingFlags?.noData === 0) {
          start = 1;
          scaled[0] = null;
        }
        if (productDescription?.plot?.maxDataValue !== void 0) {
          for (let i = start; i <= productDescription.plot.maxDataValue; i += 1) {
            scaled.push((i - scaling.offset) / scaling.scale);
          }
        } else if (productDescription?.plot?.dataLevels !== void 0) {
          scaled[0] = null;
          scaled[1] = null;
          for (let i = 2; i <= productDescription.plot.dataLevels; i += 1) {
            scaled[i] = productDescription.plot.minimumDataValue + i * productDescription.plot.dataIncrement;
          }
        }
        const radials = [];
        const radialsRaw = [];
        for (let r = 0; r < result.numberRadials; r += 1) {
          const bytesInRadial = raf.readShort();
          const radial = {
            startAngle: raf.readShort() / 10,
            angleDelta: raf.readShort() / 10,
            bins: []
          };
          const radialRaw = { ...radial, bins: [] };
          for (let i = 0; i < result.numberBins; i += 1) {
            const value = raf.readByte();
            radial.bins.push(scaled[value]);
            radialRaw.bins.push(value);
          }
          radials.push(radial);
          radialsRaw.push(radialRaw);
          if (bytesInRadial !== result.numberBins) raf.skip(bytesInRadial - result.numberBins);
        }
        result.radials = radials;
        result.radialsRaw = radialsRaw;
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/13.js
  var require__6 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/13.js"(exports, module) {
      init_inject_buffer();
      var code = 19;
      var description = "Special Graphic Symbol Packet";
      var featureKey = {
        1: "mesocyclone (extrapolated)",
        3: "mesocyclone (persistent, new or increasing)",
        5: "TVS (extrapolated)",
        6: "ETVS (extrapolated)",
        7: "TVS (persistent, new or increasing)",
        8: "ETVS (persistent, new or increasing)",
        9: "MDA Circulation with Strength Rank >= 5 AND with a Base Height <= 1 km ARL or with its base on the lowest elevation angle",
        10: "MDA Circulation with Strength Rank >= 5 AND with a Base Height > 1 km ARL AND that Base is not on the lowest elevation angle",
        11: " MDA Circulation with Strength Rank< 5"
      };
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          points: []
        };
        result.packetCodeHex = packetCode.toString(16);
        let i = 0;
        for (i = 0; i < lengthOfBlock && i + 8 < lengthOfBlock; i += 8) {
          const iStartingPoint = raf.readShort();
          const jStartingPoint = raf.readShort();
          const pointFeatureType = raf.readShort();
          const pointFeatureAttribute = raf.readShort();
          result.points.push({
            iStartingPoint,
            jStartingPoint,
            pointFeatureType,
            pointFeatureAttribute
          });
        }
        raf.skip(result.lengthOfBlock - i);
        return result;
      };
      module.exports = {
        code,
        description,
        parser,
        supplemental: { featureKey }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/14.js
  var require__7 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/14.js"(exports, module) {
      init_inject_buffer();
      var code = 20;
      var description = "Special Graphic Symbol Packet";
      var featureKey = {
        1: "mesocyclone (extrapolated)",
        3: "mesocyclone (persistent, new or increasing)",
        5: "TVS (extrapolated)",
        6: "ETVS (extrapolated)",
        7: "TVS (persistent, new or increasing)",
        8: "ETVS (persistent, new or increasing)",
        9: "MDA Circulation with Strength Rank >= 5 AND with a Base Height <= 1 km ARL or with its base on the lowest elevation angle",
        10: "MDA Circulation with Strength Rank >= 5 AND with a Base Height > 1 km ARL AND that Base is not on the lowest elevation angle",
        11: " MDA Circulation with Strength Rank< 5"
      };
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          points: []
        };
        result.packetCodeHex = packetCode.toString(16);
        let i = 0;
        for (i = 0; i < lengthOfBlock && i + 8 <= lengthOfBlock; i += 8) {
          const iStartingPoint = raf.readShort();
          const jStartingPoint = raf.readShort();
          const pointFeatureType = raf.readShort();
          const pointFeatureAttribute = raf.readShort() / 4;
          result.points.push({
            iStartingPoint,
            jStartingPoint,
            pointFeatureType,
            pointFeatureAttribute
          });
        }
        raf.skip(result.lengthOfBlock - i);
        return result;
      };
      module.exports = {
        code,
        description,
        parser,
        supplemental: { featureKey }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/utilities/ij.js
  var require_ij = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/utilities/ij.js"(exports, module) {
      init_inject_buffer();
      var ijToAzDeg = (i, j, rawScale = 8, conversion = 0.539957) => {
        const nm = Math.sqrt(i ** 2 + j ** 2) / rawScale * conversion;
        let deg = 0;
        if (i === 0) {
          deg = Math.atan(-j / i) * 180 / Math.PI + 90;
          if (deg < 0) deg += 180;
        }
        return {
          deg,
          nm
        };
      };
      module.exports = {
        ijToAzDeg
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/15.js
  var require__8 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/15.js"(exports, module) {
      init_inject_buffer();
      var code = 21;
      var description = "Special Graphic Symbol Packet";
      var { ijToAzDeg } = require_ij();
      var trendCodeScale = [
        null,
        // index zero is unused
        100,
        // feet
        100,
        // feet
        100,
        // feet
        1,
        // %
        1,
        // %
        1,
        // kg/m^2
        1,
        // dBz
        100
        // feet
      ];
      var trendCodes = {
        1: "Cell top, feet",
        2: "Cell base, feet",
        3: "Max ref height, feet",
        4: "Probability of Hail, %",
        5: "Probability of Severe Hail, %",
        6: "Cell based VIL, kg/m^2",
        7: "Max ref, dBz",
        8: "Centroid height, feet"
      };
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const packetLength = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const startPos = raf.getPos();
        const endPos = startPos + packetLength;
        const cellId = raf.readString(2);
        const result = {
          iPosition: raf.readShort(),
          jPosition: raf.readShort(),
          trends: []
        };
        const converted = ijToAzDeg(result.iPosition, result.jPosition);
        result.nm = converted.nm;
        result.deg = converted.deg;
        while (raf.getPos() < endPos) {
          const trendCode = raf.readShort();
          const numberVolumes = raf.readByte();
          const latestVolumePointer = raf.readByte() - 1;
          const trend = {
            type: trendCodes[trendCode],
            data: []
          };
          trend.type = trendCodes[trendCode];
          for (let j = 0; j < numberVolumes; j += 1) {
            let value = raf.readShort();
            if ([1, 2].includes(trendCode) && value > 700) value -= 1e3;
            trend.data.push(value * trendCodeScale[trendCode]);
          }
          trend.data = [...trend.data.slice(latestVolumePointer + 1), ...trend.data.slice(0, latestVolumePointer + 1)].reverse();
          result.trends[trendCode] = trend;
        }
        return { [cellId]: result };
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/16.js
  var require__9 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/16.js"(exports, module) {
      init_inject_buffer();
      var code = 22;
      var description = "Cell Trend Data Packet";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const numberVolumes = raf.readByte();
        const latestVolumePointer = raf.readByte() - 1;
        const result = {
          volumeTimes: []
        };
        for (let i = 0; i < numberVolumes; i += 1) {
          result.volumeTimes.push(raf.readShort());
        }
        result.volumeTimes = [...result.volumeTimes.slice(latestVolumePointer + 1), ...result.volumeTimes.slice(0, latestVolumePointer + 1)].reverse();
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/17.js
  var require__10 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/17.js"(exports, module) {
      init_inject_buffer();
      var code = 23;
      var description = "Special Graphic Symbol Packet";
      var parser = (raf) => {
        const { parser: packetParser } = require_packets();
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        const endPos = raf.getPos() + lengthOfBlock;
        const result = {
          packets: []
        };
        while (raf.getPos() < endPos) {
          result.packets.push(packetParser(raf));
        }
        result.packetCodeHex = packetCode.toString(16);
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/18.js
  var require__11 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/18.js"(exports, module) {
      init_inject_buffer();
      var code = 24;
      var description = "Special Graphic Symbol Packet";
      var { parser } = require__10();
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/19.js
  var require__12 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/19.js"(exports, module) {
      init_inject_buffer();
      var code = 25;
      var description = "Special Graphic Symbol Packet";
      var { parser } = require__10();
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/32.js
  var require__13 = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/32.js"(exports, module) {
      init_inject_buffer();
      var code = 32;
      var description = "Special Graphic Symbol Packet";
      var featureKey = {
        1: "mesocyclone (extrapolated)",
        3: "mesocyclone (persistent, new or increasing)",
        5: "TVS (extrapolated)",
        6: "ETVS (extrapolated)",
        7: "TVS (persistent, new or increasing)",
        8: "ETVS (persistent, new or increasing)",
        9: "MDA Circulation with Strength Rank >= 5 AND with a Base Height <= 1 km ARL or with its base on the lowest elevation angle",
        10: "MDA Circulation with Strength Rank >= 5 AND with a Base Height > 1 km ARL AND that Base is not on the lowest elevation angle",
        11: " MDA Circulation with Strength Rank< 5"
      };
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          points: []
        };
        result.packetCodeHex = packetCode.toString(16);
        let i = 0;
        for (i = 0; i < lengthOfBlock && i + 8 < lengthOfBlock; i += 8) {
          const iStartingPoint = raf.readShort();
          const jStartingPoint = raf.readShort();
          const pointFeatureType = raf.readShort();
          const pointFeatureAttribute = raf.readShort();
          result.points.push({
            iStartingPoint,
            jStartingPoint,
            pointFeatureType,
            pointFeatureAttribute
          });
        }
        raf.skip(result.lengthOfBlock - i);
        return result;
      };
      module.exports = {
        code,
        description,
        parser,
        supplemental: { featureKey }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/a.js
  var require_a = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/a.js"(exports, module) {
      init_inject_buffer();
      var code = 10;
      var description = "Unlinked Vector Packet";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          color: raf.readShort(),
          vectors: []
        };
        result.packetCodeHex = packetCode.toString(16);
        const endByte = raf.getPos() + lengthOfBlock - 2;
        while (raf.getPos() < endByte) {
          result.vectors.push({
            start: {
              i: raf.readShort(),
              j: raf.readShort()
            },
            end: {
              i: raf.readShort(),
              j: raf.readShort()
            }
          });
        }
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/utilities/rle.js
  var require_rle = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/utilities/rle.js"(exports, module) {
      init_inject_buffer();
      var expand4_4 = (byte) => {
        const run = byte >> 4;
        const value = byte & 15;
        const result = [];
        for (let i = 0; i < run; i += 1) {
          result.push(value);
        }
        return result;
      };
      module.exports = {
        expand4_4
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/af1f.js
  var require_af1f = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/af1f.js"(exports, module) {
      init_inject_buffer();
      var code = 44831;
      var description = "Radial Data Packet (16 Data Levels)";
      var rle = require_rle();
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          firstBin: raf.readShort(),
          numberBins: raf.readShort(),
          iSweepCenter: raf.readShort(),
          jSweepCenter: raf.readShort(),
          rangeScale: raf.readShort() / 1e3,
          numRadials: raf.readShort()
        };
        result.packetCodeHex = packetCode.toString(16);
        const radials = [];
        for (let r = 0; r < result.numRadials; r += 1) {
          const rleLength = raf.readShort() * 2;
          const radial = {
            startAngle: raf.readShort() / 10,
            angleDelta: raf.readShort() / 10,
            bins: []
          };
          for (let i = 0; i < rleLength; i += 1) {
            radial.bins.push(...rle.expand4_4(raf.readByte()));
          }
          radials.push(radial);
        }
        result.radials = radials;
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/c.js
  var require_c = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/c.js"(exports, module) {
      init_inject_buffer();
      var code = 12;
      var description = "Tornado Vortex Signautre";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        if (packetCode !== code) throw new Error(`Packet codes do not match ${code} !== ${packetCode}`);
        const result = {
          points: []
        };
        result.packetCodeHex = packetCode.toString(16);
        let i = 0;
        for (i = 0; i < lengthOfBlock && i + 4 <= lengthOfBlock; i += 4) {
          const iStartingPoint = raf.readShort();
          const jStartingPoint = raf.readShort();
          result.points.push({
            iStartingPoint,
            jStartingPoint
          });
        }
        raf.skip(result.lengthOfBlock - i);
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/f.js
  var require_f = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/f.js"(exports, module) {
      init_inject_buffer();
      var code = 15;
      var description = "Special Graphic Symbol Packet";
      var parser = (raf) => {
        const packetCode = raf.readUShort();
        const lengthOfBlock = raf.readShort();
        const result = {
          symbols: []
        };
        const endPos = raf.getPos() + lengthOfBlock;
        while (raf.getPos() < endPos) {
          result.symbols.push({
            iStartingPoint: raf.readShort(),
            jStartingPoint: raf.readShort(),
            text: raf.readString(2)
          });
        }
        result.packetCodeHex = packetCode.toString(16);
        return result;
      };
      module.exports = {
        code,
        description,
        parser
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/packets/index.js
  var require_packets = __commonJS({
    "node_modules/nexrad-level-3-data/src/packets/index.js"(exports, module) {
      init_inject_buffer();
      var packetsRaw = [
        require__(),
        require__2(),
        require__3(),
        require__4(),
        require__5(),
        require__6(),
        require__7(),
        require__8(),
        require__9(),
        require__10(),
        require__11(),
        require__12(),
        require__13(),
        require_a(),
        require_af1f(),
        require_c(),
        require_f()
      ];
      var packets = {};
      packetsRaw.forEach((packet) => {
        if (packets[packet.code]) {
          throw new Error("Duplicate packet code " + packet.code);
        }
        packets[packet.code] = packet;
      });
      var parser = (raf, productDescription) => {
        const packetCode = raf.readUShort();
        raf.skip(-2);
        const packetParser = packets[packetCode];
        if (!packetParser) {
          return null;
        }
        return packetParser.parser(raf, productDescription);
      };
      module.exports = { packets, parser };
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/graphic22.js
  var require_graphic22 = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/graphic22.js"(exports, module) {
      init_inject_buffer();
      var { parser } = require_packets();
      var parse22 = (raf) => {
        let result = {
          cells: {}
        };
        let divider = raf.readShort();
        while (divider !== -1 && raf.getPos() < raf.getLength()) {
          raf.skip(-2);
          const data = parser(raf);
          if (data.volumeTimes) result = { ...result, ...data };
          if (!data.volumeTimes) result.cells = { ...result.cells, ...data };
          if (raf.getPos() < raf.getLength()) divider = raf.readShort();
        }
        if (raf.getPos() < raf.getLength()) raf.skip(-2);
        return result;
      };
      module.exports = parse22;
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/graphic.js
  var require_graphic = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/graphic.js"(exports, module) {
      init_inject_buffer();
      var { parser } = require_packets();
      var graphic22 = require_graphic22();
      var parse = (raf) => {
        const blockDivider = raf.readShort();
        if (blockDivider === 22) {
          raf.skip(-2);
          return graphic22(raf);
        }
        const blockId = raf.readShort();
        const blockLength = raf.readInt();
        if (blockDivider !== -1) throw new Error(`Invalid graphic block divider: ${blockDivider}`);
        if (blockId !== 2) throw new Error(`Invalid graphic id: ${blockId}`);
        if (blockLength < 1 || blockLength > 65535) throw new Error(`Invalid block length ${blockLength}`);
        if (blockLength + raf.getPos() - 8 > raf.getLength()) throw new Error(`Block length ${blockLength} overruns file length for block id: ${blockId}`);
        const numberPages = raf.readShort();
        const packets = [];
        if (numberPages < 1 || numberPages > 48 - 1) throw new Error(`Invalid graphic number of pages: ${numberPages}`);
        for (let pageNum = 0; pageNum < numberPages; pageNum += 1) {
          const pageNumber = raf.readShort();
          const pageLength = raf.readShort();
          const endByte = raf.getPos() + pageLength;
          if (pageNum + 1 !== pageNumber) throw new Error(`Invalid page number: ${pageNumber}`);
          while (raf.getPos() < endByte) {
            packets.push(parser(raf));
          }
        }
        return packets;
      };
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-3-data/src/headers/radialpackets.js
  var require_radialpackets = __commonJS({
    "node_modules/nexrad-level-3-data/src/headers/radialpackets.js"(exports, module) {
      init_inject_buffer();
      var { parser } = require_packets();
      var parse = (raf, productDescription, layerCount, options) => {
        const layers = [];
        for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
          const startPos = raf.getPos();
          const layerDivider = raf.readShort();
          const layerLength = raf.readInt();
          if (layerDivider !== -1) throw new Error(`Invalid layer divider ${layerDivider} in layer ${layerIndex}`);
          if (layerLength + raf.getPos() > raf.getLength()) throw new Error(`Layer size overruns block size for layer ${layerIndex}`);
          try {
            const packets = [];
            while (raf.getPos() < startPos + layerLength) {
              packets.push(parser(raf, productDescription));
            }
            if (packets.length === 1) {
              layers.push(packets[0]);
            } else {
              layers.push(packets);
            }
          } catch (e) {
            options.logger.warn(e.stack);
            raf.seek(startPos + layerLength);
            layers.push(void 0);
          }
        }
        return layers;
      };
      module.exports = parse;
    }
  });

  // node_modules/nexrad-level-3-data/src/products/56/index.js
  var require__14 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/56/index.js"(exports, module) {
      init_inject_buffer();
      var code = 56;
      var abbreviation = ["N0S", "N1S", "N2S", "N3S"];
      var description = "Storm relative velocity";
      var { RandomAccessFile } = require_randomaccessfile();
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          elevationAngle: raf.readShort() / 10,
          dependent31_46: raf.read(32),
          maxNegativeVelocity: raf.readShort(),
          // knots
          maxPositiveVelocity: raf.readShort(),
          // knots
          motionSourceFlag: raf.readShort(),
          // = -1
          dependent50: raf.readShort(),
          averageStormSpeed: raf.readShort() / 10,
          // knots
          averageStormDirection: raf.readShort() / 10
          // degrees
        };
      };
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/58/formatter.js
  var require_formatter = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/58/formatter.js"(exports, module) {
      init_inject_buffer();
      module.exports = (data) => {
        const pages = data?.tabular?.pages;
        if (!pages) return {};
        const result = {};
        pages.forEach((page) => {
          page.forEach((line) => {
            const idMatch = line.match(/ {2}([A-Z][0-9]) {5}[0-9 ]{3}\/[0-9 ]{3} {3}/);
            if (!idMatch) return;
            const id = idMatch[1];
            const rawPositions = [...line.matchAll(/([ 0-9]{3}\/[ 0-9]{3}|NO DATA| {2}NEW {2})/g)];
            const stringPositions = rawPositions.map((position, index) => parseStringPosition(position[1], index === 1));
            const [current, movement, ...forecast] = stringPositions;
            result[id] = {
              current,
              movement,
              forecast
            };
          });
        });
        return {
          storms: result
        };
      };
      var parseStringPosition = (position, kts = false) => {
        if (position === "NO DATA") return null;
        if (position === "  NEW  ") return "new";
        const values = position.match(/([ 0-9]{3})\/([ 0-9]{3})/);
        if (!values) return void 0;
        if (kts) {
          return {
            deg: +values[1],
            kts: +values[2]
          };
        }
        return {
          deg: +values[1],
          nm: +values[2]
        };
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/58/index.js
  var require__15 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/58/index.js"(exports, module) {
      init_inject_buffer();
      var code = 58;
      var abbreviation = ["NST"];
      var description = "Storm Tracking Information";
      var { RandomAccessFile } = require_randomaccessfile();
      var formatter = require_formatter();
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          elevationAngle: raf.readShort() / 10,
          dependent31_46: raf.read(32),
          maxNegativeVelocity: raf.readShort(),
          // knots
          maxPositiveVelocity: raf.readShort(),
          // knots
          motionSourceFlag: raf.readShort(),
          // = -1
          dependent50: raf.readShort(),
          averageStormSpeed: raf.readShort() / 10,
          // knots
          averageStormDirection: raf.readShort() / 10
          // degrees
        };
      };
      module.exports = {
        code,
        abbreviation,
        description,
        formatter,
        productDescription: {
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/59/formatter.js
  var require_formatter2 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/59/formatter.js"(exports, module) {
      init_inject_buffer();
      module.exports = (data) => {
        const pages = data?.tabular?.pages;
        if (!pages) return {};
        const result = {};
        pages.forEach((page) => {
          page.forEach((line) => {
            const rawMatch = line.match(/ {8}([A-Z]\d) {4} *([0-9.]{1,3}) *([0-9.]{1,3}) *<?>?([0-9.]{4,6}) */);
            if (!rawMatch) return;
            const [, id, probSevere, probHail, maxSize] = [...rawMatch];
            result[id] = {
              probSevere: +probSevere,
              probHail: +probHail,
              maxSize: +maxSize
            };
          });
        });
        return {
          hail: result
        };
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/59/index.js
  var require__16 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/59/index.js"(exports, module) {
      init_inject_buffer();
      var code = 59;
      var abbreviation = ["NHI"];
      var description = "Hail Index";
      var formatter = require_formatter2();
      module.exports = {
        code,
        abbreviation,
        description,
        formatter,
        productDescription: {}
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/61/formatter.js
  var require_formatter3 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/61/formatter.js"(exports, module) {
      init_inject_buffer();
      module.exports = (data) => {
        const pages = data?.tabular?.pages;
        if (!pages) return {};
        const result = {};
        pages.forEach((page) => {
          page.forEach((line) => {
            const rawMatch = line.match(/ {2}([A-Z0-9]{3}) {4}([A-Z][0-9]) {3,5}([0-9.]{1,3})\/ {0,2}([0-9.]{1,3}) {3,5}([0-9.]{1,3}) {3,5}([0-9.]{1,3}) {3,5}([0-9.]{1,3})\/ {0,2}([0-9.]{1,3})[ <>]{4}([0-9.]{4})[ <>]{3,4}([0-9.]{3,4})\/ {0,2}([0-9.]{1,4}) {3,5}([0-9.]{2,4})\/ {0,2}([0-9.]{1,4})/);
            if (!rawMatch) return;
            const [, type, id, az, range, avfdv, lldv, mxdv, mvdvhgt, depth, base, top, maxshear, maxshearheight] = [...rawMatch];
            result[id] = {
              type,
              az: +az,
              range: +range,
              avfdv: +avfdv,
              lldv: +lldv,
              mxdv: +mxdv,
              mvdvhgt: +mvdvhgt,
              depth: +depth,
              base: +base,
              top: +top,
              maxshear: +maxshear,
              maxshearheight: +maxshearheight
            };
          });
        });
        return {
          tvs: result
        };
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/61/index.js
  var require__17 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/61/index.js"(exports, module) {
      init_inject_buffer();
      var code = 61;
      var abbreviation = ["NTV"];
      var description = "Tornadic Vortex Signature";
      var formatter = require_formatter3();
      module.exports = {
        code,
        abbreviation,
        description,
        formatter,
        productDescription: {}
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/62/index.js
  var require__18 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/62/index.js"(exports, module) {
      init_inject_buffer();
      var code = 62;
      var abbreviation = ["NSS"];
      var description = "Storm Structure";
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {}
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/78/index.js
  var require__19 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/78/index.js"(exports, module) {
      init_inject_buffer();
      var code = 78;
      var abbreviation = "N1P";
      var description = "One-hour precipitation";
      var { RandomAccessFile } = require_randomaccessfile();
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        raf.seek(34);
        return {
          maxRainfall: raf.readShort() / 10,
          meanFieldBias: raf.readShort() / 100,
          sampleSize: raf.readShort() / 100,
          endRanifallDate: raf.readShort(),
          endRainfallMinutes: raf.readShort(),
          plot: {
            maxDataValue: 16
          }
        };
      };
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/80/index.js
  var require__20 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/80/index.js"(exports, module) {
      init_inject_buffer();
      var code = 80;
      var abbreviation = "NTP";
      var description = "Storm Total Rainfall Accumulation";
      var { RandomAccessFile } = require_randomaccessfile();
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        raf.seek(34);
        return {
          maxRainfall: raf.readShort() / 10,
          beginRanifallDate: raf.readShort(),
          beginRainfallMinutes: raf.readShort(),
          endRanifallDate: raf.readShort(),
          endRainfallMinutes: raf.readShort(),
          meanFieldBias: raf.readShort() / 100,
          sampleSize: raf.readShort() / 100,
          plot: {
            maxDataValue: 16
          }
        };
      };
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/94/index.js
  var require__21 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/94/index.js"(exports, module) {
      init_inject_buffer();
      var code = 94;
      var abbreviation = ["NXQ", "NYQ", "NZQ", "N0Q", "NAQ", "N1Q", "NBQ", "N2Q", "N3Q"];
      var description = "Digital Base Reflectivity";
      var { RandomAccessFile } = require_randomaccessfile();
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          elevationAngle: raf.readShort() / 10,
          plot: {
            minimumDataValue: raf.readShort() / 10,
            dataIncrement: raf.readShort() / 10,
            dataLevels: raf.readShort()
          },
          dependent34_46: raf.read(26),
          maxReflectivity: raf.readShort(),
          // dBZ
          dependent48_49: raf.read(4),
          ...deltaTime(raf.readShort()),
          compressionMethod: raf.readShort(),
          uncompressedProductSize: (raf.readUShort() << 16) + raf.readUShort()
        };
      };
      var deltaTime = (value) => ({
        deltaTime: (value & 65504) >> 5,
        nonSupplementalScan: (value & 31) === 0,
        sailsScan: (value & 31) === 1,
        mrleScan: (value & 31) === 2
      });
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/141/formatter.js
  var require_formatter4 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/141/formatter.js"(exports, module) {
      init_inject_buffer();
      module.exports = (data) => {
        const pages = data?.tabular?.pages;
        if (!pages) return {};
        const result = {};
        pages.forEach((page) => {
          page.forEach((line) => {
            const rawMatch = line.match(/ +([0-9.]+) +([0-9.]+)\/ *([0-9.]+) +([0-9.]+) +([A-Z0-9]{2}) +([0-9.]+) +([0-9.]+)[ <]+([0-9.]+)[ <>]+([0-9.]+)[ <>]+([0-9.]+)[ <>]+([0-9.]+)[ <>]+([0-9.]+) +([YN]) {1,4}([0-9.]*)\/* {0,3}([0-9.]*) +([0-9.]*)/);
            if (!rawMatch) return;
            const [, id, az, ran, sr, stmId, llRv, llDv, llBase, depthKft, depthStmrel, maxRvKft, maxrvKts, tvs, motionDeg, motionKts, msi] = [...rawMatch];
            let motion = false;
            if (motionDeg !== "") {
              motion = {
                deg: +motionDeg,
                kts: +motionKts
              };
            }
            result[id] = {
              az: +az,
              ran: +ran,
              sr: +sr,
              stmId,
              lowLevel: {
                rv: +llRv,
                dv: +llDv,
                base: +llBase
              },
              depth: {
                kft: +depthKft,
                stmrel: +depthStmrel
              },
              maxRv: {
                kft: +maxRvKft,
                kts: +maxrvKts
              },
              tvs: tvs === "Y",
              motion,
              msi: msi ?? null
            };
          });
        });
        return {
          mesocyclone: result
        };
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/141/index.js
  var require__22 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/141/index.js"(exports, module) {
      init_inject_buffer();
      var code = 141;
      var abbreviation = ["NMD"];
      var description = "Mesocyclone";
      var formatter = require_formatter4();
      var { RandomAccessFile } = require_randomaccessfile();
      var halfwords27_28 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          minimumReflectivity: raf.readShort(),
          overlapDisplayFilter: raf.readShort()
        };
      };
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          filterStrengthRank: raf.readShort()
        };
      };
      module.exports = {
        code,
        abbreviation,
        description,
        formatter,
        productDescription: {
          halfwords27_28,
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/165/index.js
  var require__23 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/165/index.js"(exports, module) {
      init_inject_buffer();
      var code = 165;
      var abbreviation = ["N0H", "N1H", "N2H", "N3H"];
      var description = "Hydrometeor Classification";
      var { RandomAccessFile } = require_randomaccessfile();
      var key = {
        0: "ND: Below Threshold",
        10: "BI: Biological",
        20: "GC: Anomalous Propagation/Ground Clutter",
        30: "IC: Ice Crystals",
        40: "DS: Dry Snow",
        50: "WS: Wet Snow",
        60: "RA: Light and/or Moderate Rain",
        70: "HR: Heavy Rain",
        80: "BD: Big Drops (rain)",
        90: "GR: Graupel",
        100: "HA: Hail, possibly with rain",
        110: "LH: Large Hail",
        120: "GH: Giant Hail",
        140: "UK: Unknown Classification",
        150: "RF: Range Folded"
      };
      var halfwords27_28 = (data) => ({
        halfwords27_28: data
      });
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          elevationAngle: raf.readShort() / 10,
          dependent31_49: raf.read(38),
          ...deltaTime(raf.readShort()),
          compressionMethod: raf.readShort(),
          uncompressedSize: (raf.readUShort() << 16) + raf.readUShort(),
          plot: { maxDataValue: 150 }
        };
      };
      var deltaTime = (value) => ({
        deltaTime: (value & 65504) >> 5,
        nonSupplementalScan: (value & 31) === 0,
        sailsScan: (value & 31) === 1,
        mrleScan: (value & 31) === 2
      });
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords27_28,
          halfwords30_53
        },
        supplemental: { key }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/170/index.js
  var require__24 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/170/index.js"(exports, module) {
      init_inject_buffer();
      var code = 170;
      var abbreviation = "DAA";
      var description = "Digital One Hour Accumulation";
      var { RandomAccessFile } = require_randomaccessfile();
      var halfwords27_28 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          thresholdMinTime: raf.readShort(),
          totalTime: raf.readShort()
        };
      };
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          nullProductFlag: nullProductFlag(raf.readShort()),
          plot: {
            scale: raf.readFloat() * 100,
            offset: raf.readFloat(),
            dependent35: raf.readShort(),
            maxDataValue: raf.readShort(),
            leadingFlags: leadingFlags(raf.readShort()),
            trailingFlags: raf.readShort()
          },
          dependent39_46: raf.read(16),
          maxAccumulation: raf.readShort() / 10,
          accumulationEndDate: raf.readShort(),
          accumulationEndMinutes: raf.readShort(),
          meanFieldBias: raf.readShort() / 1e3,
          compressionMethod: raf.readShort(),
          uncompressedSize: (raf.readUShort() << 16) + raf.readUShort()
        };
      };
      var nullProductFlag = (data) => {
        if (data === 0) return false;
        let reason = "";
        switch (data) {
          case 0:
            reason = false;
            break;
          case 1:
            reason = "No accumulation available. Threshold: \u2018Elapsed Time to Restart\u2019 [TIMRS] xx minutes exceeded.";
            break;
          case 2:
            reason = "No precipitation detected during the specified time span.";
            break;
          case 3:
            reason = "No accumulation data available for the specified time span.";
            break;
          case 4:
            reason = "No precipitation detected since hh:mmZ. Threshold: 'Time Without Precipitation for Resetting Storm Totals' [RAINT] is xx minutes or No precipitation detected since RPG startup.";
            break;
          case 5:
            reason = "No precipitation detected since hh:mmZ or No precipitation detected since RPG startup.";
            break;
          case 6:
            reason = "No Top_of_Hour accumulation - Some problem encountered with the SQL query resulted in an error.";
            break;
          case 7:
            reason = "No Top_of_Hour accumulation because of excessive missing time encountered.";
            break;
          default:
            reason = "Undefined";
        }
        return {
          value: data,
          reason
        };
      };
      var leadingFlags = (data) => ({
        noData: data & false
      });
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords27_28,
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/172/index.js
  var require__25 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/172/index.js"(exports, module) {
      init_inject_buffer();
      var code = 172;
      var abbreviation = "DTA";
      var description = "Storm Total Precipitation";
      var { RandomAccessFile } = require_randomaccessfile();
      var halfwords27_28 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          accumulationStartDate: raf.readShort(),
          accumulationStartMinutes: raf.readShort()
        };
      };
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          nullProductFlag: nullProductFlag(raf.readShort()),
          plot: {
            scale: raf.readFloat() * 100,
            offset: raf.readFloat(),
            dependent35: raf.readShort(),
            maxDataValue: raf.readShort(),
            leadingFlags: leadingFlags(raf.readShort()),
            trailingFlags: raf.readShort()
          },
          dependent39_46: raf.read(16),
          maxAccumulation: raf.readShort() / 10,
          accumulationEndDate: raf.readShort(),
          accumulationEndMinutes: raf.readShort(),
          meanFieldBias: raf.readShort() / 1e3,
          compressionMethod: raf.readShort(),
          uncompressedSize: (raf.readUShort() << 16) + raf.readUShort()
        };
      };
      var nullProductFlag = (data) => {
        if (data === 0) return false;
        let reason = "";
        switch (data) {
          case 0:
            reason = false;
            break;
          case 1:
            reason = "No accumulation available. Threshold: \u2018Elapsed Time to Restart\u2019 [TIMRS] xx minutes exceeded.";
            break;
          case 2:
            reason = "No precipitation detected during the specified time span.";
            break;
          case 3:
            reason = "No accumulation data available for the specified time span.";
            break;
          case 4:
            reason = "No precipitation detected since hh:mmZ. Threshold: 'Time Without Precipitation for Resetting Storm Totals' [RAINT] is xx minutes or No precipitation detected since RPG startup.";
            break;
          case 5:
            reason = "No precipitation detected since hh:mmZ or No precipitation detected since RPG startup.";
            break;
          case 6:
            reason = "No Top_of_Hour accumulation - Some problem encountered with the SQL query resulted in an error.";
            break;
          case 7:
            reason = "No Top_of_Hour accumulation because of excessive missing time encountered.";
            break;
          default:
            reason = "Undefined";
        }
        return {
          value: data,
          reason
        };
      };
      var leadingFlags = (data) => ({
        noData: data & false
      });
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords27_28,
          halfwords30_53
        }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/177/index.js
  var require__26 = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/177/index.js"(exports, module) {
      init_inject_buffer();
      var code = 177;
      var abbreviation = "HHC";
      var description = "Hybrid Hydrometeor Classification";
      var { RandomAccessFile } = require_randomaccessfile();
      var { key } = require__23().supplemental;
      var halfwords27_28 = (data) => ({
        halfwords27_28: data
      });
      var halfwords30_53 = (data) => {
        const raf = new RandomAccessFile(data);
        return {
          dependent30_46: raf.read(34),
          modeFilter: raf.readShort(),
          hybridRatePercentBinsFilled: raf.readShort() / 100,
          highestElevation: raf.readShort() / 10,
          dependent50: raf.read(2),
          compressionMethod: raf.readShort(),
          uncompressedSize: (raf.readUShort() << 16) + raf.readUShort(),
          plot: { maxDataValue: 150 }
        };
      };
      module.exports = {
        code,
        abbreviation,
        description,
        productDescription: {
          halfwords27_28,
          halfwords30_53
        },
        supplemental: { key }
      };
    }
  });

  // node_modules/nexrad-level-3-data/src/products/index.js
  var require_products = __commonJS({
    "node_modules/nexrad-level-3-data/src/products/index.js"(exports, module) {
      init_inject_buffer();
      var productsRaw = [
        require__14(),
        require__15(),
        require__16(),
        require__17(),
        require__18(),
        require__19(),
        require__20(),
        require__21(),
        require__22(),
        require__23(),
        require__24(),
        require__25(),
        require__26()
      ];
      var products = {};
      productsRaw.forEach((product) => {
        if (products[product.code]) {
          throw new Error("Duplicate product code " + product.code);
        }
        products[product.code] = product;
      });
      var productAbbreviations = productsRaw.map((product) => product.abbreviation).flat();
      module.exports = { products, productAbbreviations, productsRaw };
    }
  });

  // node_modules/nexrad-level-3-data/src/index.js
  var require_src2 = __commonJS({
    "node_modules/nexrad-level-3-data/src/index.js"(exports, module) {
      init_inject_buffer();
      var bzip = require_lib();
      var { RandomAccessFile } = require_randomaccessfile();
      var textHeader = require_text();
      var messageHeader = require_message();
      var { parse: productDescription } = require_productdescription();
      var symbologyHeader = require_symbology();
      var tabularHeader = require_tabular();
      var graphicHeader = require_graphic();
      var radialPackets = require_radialpackets();
      var { products, productAbbreviations } = require_products();
      var nexradLevel3Data2 = (file, _options) => {
        const options = combineOptions(_options);
        const raf = new RandomAccessFile(file);
        const result = {};
        result.textHeader = textHeader(raf);
        const textHeaderLength = raf.getPos();
        if (!result.textHeader.fileType.startsWith("SDUS")) throw new Error(`Incorrect file type header: ${result.textHeader.fileType}`);
        if (!productAbbreviations.includes(result.textHeader.type)) throw new Error(`Unsupported product type: ${result.textHeader.type}`);
        result.messageHeader = messageHeader(raf);
        const product = products[result.messageHeader.code.toString()];
        if (!product) throw new Error(`Unsupported product code: ${result.messageHeader.code}`);
        result.productDescription = productDescription(raf, product);
        let decompressed;
        if (result.productDescription.compressionMethod > 0) {
          const rafPos = raf.getPos();
          const compressed = raf.read(raf.getLength() - raf.getPos());
          const data = bzip.decode(compressed);
          raf.seek(0);
          decompressed = new RandomAccessFile(Buffer.concat([
            raf.read(rafPos),
            data
          ]));
          decompressed.seek(rafPos);
        } else {
          decompressed = raf;
        }
        try {
          if (result.productDescription.offsetSymbology !== 0) {
            const offsetSymbologyBytes = textHeaderLength + result.productDescription.offsetSymbology * 2;
            if (offsetSymbologyBytes > decompressed.getLength()) throw new Error(`Invalid symbology offset: ${result.productDescription.offsetSymbology}`);
            decompressed.seek(offsetSymbologyBytes);
            result.symbology = symbologyHeader(decompressed);
            result.radialPackets = radialPackets(decompressed, result.productDescription, result.symbology.numberLayers, options);
          }
        } catch (e) {
          options.logger.warn(e.stack);
          options.logger.warn("Unable to parse symbology data");
        }
        try {
          if (result.productDescription.offsetGraphic !== 0) {
            const offsetGraphicBytes = textHeaderLength + result.productDescription.offsetGraphic * 2;
            if (offsetGraphicBytes > decompressed.getLength()) throw new Error(`Invalid graphic offset: ${result.productDescription.offsetGraphic}`);
            decompressed.seek(offsetGraphicBytes);
            result.graphic = graphicHeader(decompressed);
          }
        } catch (e) {
          options.logger.warn(e.stack);
          options.logger.warn("Unable to parse graphic data");
        }
        try {
          if (result.productDescription.offsetTabular !== 0) {
            const offsetTabularBytes = textHeaderLength + result.productDescription.offsetTabular * 2;
            if (offsetTabularBytes > decompressed.getLength()) throw new Error(`Invalid tabular offset: ${result.productDescription.offsetTabular}`);
            decompressed.seek(offsetTabularBytes);
            result.tabular = tabularHeader(decompressed, product);
          }
        } catch (e) {
          options.logger.warn(e.stack);
          options.logger.warn("Unable to parse tabular data");
        }
        try {
          const formatted = product?.formatter?.(result);
          if (formatted) result.formatted = formatted;
        } catch (e) {
          options.logger.warn(e.stack);
          options.logger.warn("Unable to parse formatted tabular data");
        }
        return result;
      };
      var combineOptions = (newOptions) => {
        let logger = newOptions?.logger ?? console;
        if (logger === false) logger = nullLogger;
        return {
          ...newOptions,
          logger
        };
      };
      var nullLogger = {
        log: () => {
        },
        error: () => {
        },
        warn: () => {
        }
      };
      module.exports = nexradLevel3Data2;
    }
  });

  // radar_worker.js
  init_inject_buffer();
  var import_buffer2 = __toESM(require_buffer(), 1);
  var import_nexrad_level_2_data = __toESM(require_src(), 1);
  var import_nexrad_level_3_data = __toESM(require_src2(), 1);

  // dealias.js
  init_inject_buffer();
  var np = {
    linspace(startValue, stopValue, cardinality) {
      const arr = [];
      const step = (stopValue - startValue) / (cardinality - 1);
      for (let i = 0; i < cardinality; i++) {
        arr.push(startValue + step * i);
      }
      return arr;
    },
    shape(arr) {
      const numRows = arr.length;
      const numCols = arr[0]?.length;
      return [numRows ?? 1, numCols ?? 1];
    },
    zeros(shape) {
      if (shape.length === 0) {
        return 0;
      }
      const arr = new Array(shape[0]);
      for (let i = 0; i < shape[0]; i++) {
        arr[i] = this.zeros(shape.slice(1));
      }
      return arr;
    },
    ones_like(arr) {
      return new Array(arr.length).fill(1);
    },
    bincount(arr) {
      if (!arr.length) return [];
      const counts = new Array(max(arr) + 1).fill(0);
      for (const x of arr) {
        counts[x] += 1;
      }
      return counts;
    },
    lexsort(arr1, arr2) {
      const indices = Array.from({ length: arr1.length }, (_, i) => i);
      indices.sort((a, b) => {
        const cmp = arr1[a] - arr1[b];
        if (cmp !== 0) {
          return cmp;
        }
        return arr2[a] - arr2[b];
      });
      return indices;
    },
    nonzero(arr) {
      return arr.reduce((acc, cur, i) => {
        if (cur) {
          acc.push(i);
        }
        return acc;
      }, []);
    },
    argmax(arr) {
      let maxIndex = 0;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] > arr[maxIndex]) {
          maxIndex = i;
        }
      }
      return maxIndex;
    },
    add: {
      reduceat(arr, indices) {
        const result = [];
        for (let i = 0; i < indices.length; i++) {
          const curIndex = indices[i];
          const nextIndex = indices[i + 1];
          if (Number.isFinite(nextIndex) && curIndex > nextIndex) {
            result.push(curIndex);
          } else {
            const sliced = arr.slice(curIndex, nextIndex);
            const added = sliced.reduce((a, b) => a + b, 0);
            result.push(added);
          }
        }
        return result;
      }
    }
  };
  function copy(arr) {
    return JSON.parse(JSON.stringify(arr));
  }
  function remove(arr, value) {
    const index = arr.indexOf(value);
    if (index !== -1) {
      arr.splice(index, 1);
    }
    return arr;
  }
  function max(arr) {
    let current = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      if (value > current) current = value;
    }
    return current;
  }
  function labelImage(arr) {
    const labels = new Array(arr.length).fill(0).map(() => new Array(arr[0].length).fill(0));
    let labelCount = 1;
    for (let i = 0; i < arr.length; i++) {
      for (let j = 0; j < arr[0].length; j++) {
        if (arr[i][j] && labels[i][j] === 0) {
          const queue = [[i, j]];
          while (queue.length > 0) {
            const [row, col] = queue.shift();
            labels[row][col] = labelCount;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const x = row + dx;
              const y = col + dy;
              if (x >= 0 && x < arr.length && y >= 0 && y < arr[0].length && arr[x][y] && labels[x][y] === 0) {
                queue.push([x, y]);
                labels[x][y] = -1;
              }
            }
          }
          labelCount += 1;
        }
      }
    }
    for (let i = 0; i < labels.length; i++) {
      for (let j = 0; j < labels[0].length; j++) {
        if (labels[i][j] === -1) {
          labels[i][j] = 0;
        }
      }
    }
    return [labels, labelCount - 1];
  }
  function maskValues(velocities) {
    for (let i = 0; i < velocities.length; i++) {
      for (let n = 0; n < velocities[i].length; n++) {
        if (velocities[i][n] == null || !Number.isFinite(velocities[i][n])) {
          velocities[i][n] = -64.5;
        }
      }
    }
    return velocities;
  }
  function findSweepIntervalSplits(nyquist, intervalSplits, velocities) {
    let addStart = 0;
    let addEnd = 0;
    const interval = 2 * nyquist / intervalSplits;
    if (velocities.length !== 0) {
      let maxVel = -Infinity;
      let minVel = Infinity;
      for (let r = 0; r < velocities.length; r++) {
        const row = velocities[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length; c++) {
          const value = row[c];
          if (!Number.isFinite(value)) continue;
          if (value > maxVel) maxVel = value;
          if (value < minVel) minVel = value;
        }
      }
      if (Number.isFinite(maxVel) && Number.isFinite(minVel)) {
        if (maxVel > nyquist || minVel < -nyquist) {
          addStart = Math.ceil((maxVel - nyquist) / interval);
          addEnd = Math.ceil(-(minVel + nyquist) / interval);
        }
      }
    }
    const start = -nyquist - addStart * interval;
    const end = nyquist + addEnd * interval;
    const num = intervalSplits + 1 + addStart + addEnd;
    return np.linspace(start, end, num);
  }
  function combineRegions(regionTracker, edgeTracker) {
    const [status, extra] = edgeTracker.popEdge();
    if (status) {
      return true;
    }
    let [node1, node2, _weight, diff, edgeNumber] = extra;
    let rdiff = Math.round(diff);
    const node1Size = regionTracker.getNodeSize(node1);
    const node2Size = regionTracker.getNodeSize(node2);
    let baseNode;
    let mergeNode;
    if (node1Size > node2Size) {
      [baseNode, mergeNode] = [node1, node2];
    } else {
      [baseNode, mergeNode] = [node2, node1];
      rdiff = -rdiff;
    }
    if (rdiff !== 0) {
      regionTracker.unwrapNode(mergeNode, rdiff);
      edgeTracker.unwrapNode(mergeNode, rdiff);
    }
    regionTracker.mergeNodes(baseNode, mergeNode);
    edgeTracker.mergeNodes(baseNode, mergeNode, edgeNumber);
    return false;
  }
  var EdgeTracker = class {
    constructor(indices, edgeCount, velocities, nyquistInterval, nnodes) {
      const nedges = Math.floor(indices[0].length / 2);
      this.nodeAlpha = new Array(nedges).fill(0);
      this.nodeBeta = new Array(nedges).fill(0);
      this.sumDiff = new Array(nedges).fill(0);
      this.weight = new Array(nedges).fill(0);
      this.commonFinder = new Array(nnodes).fill(false);
      this.commonIndex = new Array(nnodes).fill(0);
      this.lastBaseNode = -1;
      this.edgesInNode = new Array(nnodes).fill(0).map(() => []);
      let edge = 0;
      const [idx1, idx2] = indices;
      const [vel1, vel2] = velocities;
      for (let k = 0; k < idx1.length; k++) {
        const i = idx1[k];
        const j = idx2[k];
        const count = edgeCount[k];
        const vel = vel1[k];
        const nvel = vel2[k];
        if (i < j) {
          continue;
        }
        this.nodeAlpha[edge] = i;
        this.nodeBeta[edge] = j;
        this.sumDiff[edge] = (vel - nvel) / nyquistInterval;
        this.weight[edge] = count;
        this.edgesInNode[i].push(edge);
        this.edgesInNode[j].push(edge);
        edge += 1;
      }
    }
    mergeNodes(baseNode, mergeNode, fooEdge) {
      this.weight[fooEdge] = -999;
      this.edgesInNode[mergeNode] = remove(this.edgesInNode[mergeNode], fooEdge);
      this.edgesInNode[baseNode] = remove(this.edgesInNode[baseNode], fooEdge);
      this.commonFinder[mergeNode] = false;
      const edgesInMerge = [...this.edgesInNode[mergeNode]];
      if (this.lastBaseNode !== baseNode) {
        this.commonFinder.fill(false);
        const edgesInBase = [...this.edgesInNode[baseNode]];
        for (let i = 0; i < edgesInBase.length; i++) {
          const edgeNum = edgesInBase[i];
          if (this.nodeBeta[edgeNum] === baseNode) {
            this.reverseEdgeDirection(edgeNum);
          }
          const neighbor = this.nodeBeta[edgeNum];
          this.commonFinder[neighbor] = true;
          this.commonIndex[neighbor] = edgeNum;
        }
      }
      for (let i = 0; i < edgesInMerge.length; i++) {
        const edgeNum = edgesInMerge[i];
        if (this.nodeBeta[edgeNum] === mergeNode) {
          this.reverseEdgeDirection(edgeNum);
        }
        this.nodeAlpha[edgeNum] = baseNode;
        const neighbor = this.nodeBeta[edgeNum];
        if (this.commonFinder[neighbor]) {
          const baseEdgeNum = this.commonIndex[neighbor];
          this.combineEdges(baseEdgeNum, edgeNum, mergeNode, neighbor);
        } else {
          this.commonFinder[neighbor] = true;
          this.commonIndex[neighbor] = edgeNum;
        }
      }
      const edges = this.edgesInNode[mergeNode];
      this.edgesInNode[baseNode].push(...edges);
      this.edgesInNode[mergeNode] = [];
      this.lastBaseNode = Number(baseNode);
    }
    combineEdges(baseEdge, mergeEdge, mergeNode, neighborNode) {
      this.weight[baseEdge] += this.weight[mergeEdge];
      this.weight[mergeEdge] = -999;
      this.sumDiff[baseEdge] += this.sumDiff[mergeEdge];
      this.edgesInNode[mergeNode] = remove(this.edgesInNode[mergeNode], mergeEdge);
      this.edgesInNode[neighborNode] = remove(this.edgesInNode[neighborNode], mergeEdge);
    }
    reverseEdgeDirection(edge) {
      const oldAlpha = Number(this.nodeAlpha[edge]);
      const oldBeta = Number(this.nodeBeta[edge]);
      this.nodeAlpha[edge] = oldBeta;
      this.nodeBeta[edge] = oldAlpha;
      this.sumDiff[edge] = -1 * this.sumDiff[edge];
    }
    unwrapNode(node, nwrap) {
      if (nwrap === 0) {
        return;
      }
      for (let i = 0; i < this.edgesInNode[node].length; i++) {
        const edge = this.edgesInNode[node][i];
        const weight = this.weight[edge];
        if (node === this.nodeAlpha[edge]) {
          this.sumDiff[edge] += weight * nwrap;
        } else {
          this.sumDiff[edge] += -weight * nwrap;
        }
      }
    }
    popEdge() {
      const edgeNum = np.argmax(this.weight);
      const node1 = this.nodeAlpha[edgeNum];
      const node2 = this.nodeBeta[edgeNum];
      const weight = this.weight[edgeNum];
      const diff = this.sumDiff[edgeNum] / Number(weight);
      if (weight < 0) {
        return [true, null];
      }
      return [false, [node1, node2, weight, diff, edgeNum]];
    }
  };
  var RegionTracker = class {
    constructor(regionSizes) {
      const nregions = regionSizes.length + 1;
      this.nodeSize = new Array(nregions).fill(0);
      this.nodeSize.splice(1, regionSizes.length, ...regionSizes);
      this.regionsInNode = new Array(nregions).fill(0).map((_, i) => [i]);
      this.unwrapNumber = new Array(nregions).fill(0);
    }
    mergeNodes(nodeA, nodeB) {
      const regionsToMerge = this.regionsInNode[nodeB];
      this.regionsInNode[nodeA].push(...regionsToMerge);
      this.regionsInNode[nodeB] = [];
      this.nodeSize[nodeA] += this.nodeSize[nodeB];
      this.nodeSize[nodeB] = 0;
    }
    unwrapNode(node, nwrap) {
      if (nwrap === 0) {
        return;
      }
      const regionsToUnwrap = this.regionsInNode[node];
      for (let i = 0; i < regionsToUnwrap.length; i++) {
        this.unwrapNumber[regionsToUnwrap[i]] += nwrap;
      }
    }
    getNodeSize(node) {
      return this.nodeSize[node];
    }
  };
  function edgeSumAndCount(labels, numMaskedGates, data, raysWrapAround, maxGapX, maxGapY, protectedMask = null) {
    const lShape = np.shape(labels);
    let totalNodes = lShape[0] * lShape[1] - numMaskedGates;
    if (raysWrapAround) {
      totalNodes += lShape[0] * 2;
    }
    let [indices, velocities] = fastEdgeFinder(labels, data, raysWrapAround, maxGapX, maxGapY, totalNodes, protectedMask);
    let [index1, index2] = indices;
    let [vel1, vel2] = velocities;
    let count = np.ones_like(vel1);
    if (vel1.length === 0) {
      return [[[], []], [], [[], []]];
    }
    const order = np.lexsort(index1, index2);
    index1 = order.map((i) => index1[i]);
    index2 = order.map((i) => index2[i]);
    vel1 = order.map((i) => vel1[i]);
    vel2 = order.map((i) => vel2[i]);
    count = order.map((i) => count[i]);
    const uniqueMask = new Array(index1.length - 1);
    for (let i = 0; i < uniqueMask.length; i++) {
      uniqueMask[i] = index1[i + 1] !== index1[i] || index2[i + 1] !== index2[i];
    }
    uniqueMask.unshift(true);
    index1 = index1.filter((_, i) => uniqueMask[i]);
    index2 = index2.filter((_, i) => uniqueMask[i]);
    const uniqueInds = np.nonzero(uniqueMask);
    vel1 = np.add.reduceat(vel1, uniqueInds);
    vel2 = np.add.reduceat(vel2, uniqueInds);
    count = np.add.reduceat(count, uniqueInds);
    return [[index1, index2], count, [vel1, vel2]];
  }
  function isProtectedGate(mask, rayIndex, gateIndex) {
    return Boolean(mask?.[rayIndex]?.[gateIndex]);
  }
  function fastEdgeFinder(labels, data, raysWrapAround, maxGapX, maxGapY, totalNodes, protectedMask = null) {
    const lShape = np.shape(labels);
    const collector = new EdgeCollector(totalNodes);
    const right = lShape[0] - 1;
    const bottom = lShape[1] - 1;
    for (let xIndex = 0; xIndex < lShape[0]; xIndex++) {
      for (let yIndex = 0; yIndex < lShape[1]; yIndex++) {
        const label = labels[xIndex][yIndex];
        if (label === 0) {
          continue;
        }
        if (isProtectedGate(protectedMask, xIndex, yIndex)) {
          continue;
        }
        const vel = data[xIndex][yIndex];
        let xCheck = xIndex - 1;
        if (xCheck === -1 && raysWrapAround) {
          xCheck = right;
        }
        if (xCheck !== -1) {
          let neighbor = labels[xCheck][yIndex];
          if (neighbor === 0) {
            for (let i = 0; i < maxGapX; i++) {
              xCheck -= 1;
              if (xCheck === -1) {
                if (raysWrapAround) {
                  xCheck = right;
                } else {
                  break;
                }
              }
              neighbor = labels[xCheck][yIndex];
              if (neighbor !== 0) {
                break;
              }
            }
          }
          const nvel = data[xCheck][yIndex];
          if (!isProtectedGate(protectedMask, xCheck, yIndex)) {
            collector.addEdge(label, neighbor, vel, nvel);
          }
        }
        xCheck = xIndex + 1;
        if (xCheck === right + 1 && raysWrapAround) {
          xCheck = 0;
        }
        if (xCheck !== right + 1) {
          let neighbor = labels[xCheck][yIndex];
          if (neighbor === 0) {
            for (let i = 0; i < maxGapX; i++) {
              xCheck += 1;
              if (xCheck === right + 1) {
                if (raysWrapAround) {
                  xCheck = 0;
                } else {
                  break;
                }
              }
              neighbor = labels[xCheck][yIndex];
              if (neighbor !== 0) {
                break;
              }
            }
          }
          const nvel = data[xCheck][yIndex];
          if (!isProtectedGate(protectedMask, xCheck, yIndex)) {
            collector.addEdge(label, neighbor, vel, nvel);
          }
        }
        let yCheck = yIndex - 1;
        if (yCheck !== -1) {
          let neighbor = labels[xIndex][yCheck];
          if (neighbor === 0) {
            for (let i = 0; i < maxGapY; i++) {
              yCheck -= 1;
              if (yCheck === -1) {
                break;
              }
              neighbor = labels[xIndex][yCheck];
              if (neighbor !== 0) {
                break;
              }
            }
          }
          const nvel = data[xIndex][yCheck];
          if (!isProtectedGate(protectedMask, xIndex, yCheck)) {
            collector.addEdge(label, neighbor, vel, nvel);
          }
        }
        yCheck = yIndex + 1;
        if (yCheck !== bottom + 1) {
          let neighbor = labels[xIndex][yCheck];
          if (neighbor === 0) {
            for (let i = 0; i < maxGapY; i++) {
              yCheck += 1;
              if (yCheck === bottom + 1) {
                break;
              }
              neighbor = labels[xIndex][yCheck];
              if (neighbor !== 0) {
                break;
              }
            }
          }
          const nvel = data[xIndex][yCheck];
          if (!isProtectedGate(protectedMask, xIndex, yCheck)) {
            collector.addEdge(label, neighbor, vel, nvel);
          }
        }
      }
    }
    return collector.getIndicesAndVelocities();
  }
  function dilateMask(mask, rayRadius = 1, gateRadius = 1) {
    const rows = mask.length;
    const cols = mask[0]?.length || 0;
    const expanded = mask.map((row) => row.slice());
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!mask[r][c]) continue;
        for (let dr = -rayRadius; dr <= rayRadius; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -gateRadius; dc <= gateRadius; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            expanded[rr][cc] = true;
          }
        }
      }
    }
    return expanded;
  }
  function buildRotationProtectionMask(velocities, nyquistVelocity, options = {}) {
    if (!Array.isArray(velocities) || velocities.length === 0 || !Number.isFinite(nyquistVelocity) || nyquistVelocity <= 0) {
      return null;
    }
    const rayCount = velocities.length;
    const gateCount = velocities[0]?.length || 0;
    if (gateCount === 0) {
      return null;
    }
    const signComponentThreshold = Number.isFinite(options.signComponentThreshold) ? options.signComponentThreshold : Math.max(8, nyquistVelocity * 0.25);
    const radialPolarityShearThreshold = Number.isFinite(options.radialPolarityShearThreshold) ? options.radialPolarityShearThreshold : Math.max(10, nyquistVelocity * 0.45);
    const rayRadius = Number.isFinite(options.rayRadius) ? options.rayRadius : 0;
    const gateRadius = Number.isFinite(options.gateRadius) ? options.gateRadius : 1;
    const mask = new Array(rayCount).fill(false).map(() => new Array(gateCount).fill(false));
    let protectedCount = 0;
    const mark = (r, c) => {
      if (!mask[r][c]) {
        mask[r][c] = true;
        protectedCount += 1;
      }
    };
    for (let r = 0; r < rayCount; r++) {
      for (let c = 0; c + 1 < gateCount; c++) {
        const v1 = velocities[r][c];
        const v2 = velocities[r][c + 1];
        if (!Number.isFinite(v1) || !Number.isFinite(v2)) continue;
        const polarityFlip = v1 < 0 && v2 > 0 || v1 > 0 && v2 < 0;
        if (!polarityFlip) continue;
        const shear = Math.abs(v2 - v1);
        if (shear >= radialPolarityShearThreshold && Math.abs(v1) >= signComponentThreshold && Math.abs(v2) >= signComponentThreshold) {
          mark(r, c);
          mark(r, c + 1);
        }
      }
    }
    if (protectedCount === 0) {
      return {
        mask,
        protectedCount: 0,
        dilatedProtectedCount: 0
      };
    }
    const dilatedMask = dilateMask(mask, rayRadius, gateRadius);
    let dilatedProtectedCount = 0;
    for (let r = 0; r < rayCount; r++) {
      for (let c = 0; c < gateCount; c++) {
        if (dilatedMask[r][c]) {
          dilatedProtectedCount += 1;
        }
      }
    }
    return {
      mask: dilatedMask,
      protectedCount,
      dilatedProtectedCount
    };
  }
  function collectLocalNeighborValues(rows, rayIndex, gateIndex) {
    const values = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        if (dr === 0 && dg === 0) continue;
        const rr = rayIndex + dr;
        const cc = gateIndex + dg;
        if (rr < 0 || rr >= rows.length || cc < 0 || cc >= (rows[rr]?.length || 0)) continue;
        const neighbor = rows[rr][cc];
        if (Number.isFinite(neighbor)) {
          values.push(neighbor);
        }
      }
    }
    return values;
  }
  function collectRadialNeighborValues(rows, rayIndex, gateIndex, window = 3) {
    const values = [];
    const row = rows[rayIndex] || [];
    for (let dg = -window; dg <= window; dg++) {
      if (dg === 0) continue;
      const cc = gateIndex + dg;
      if (cc < 0 || cc >= row.length) continue;
      const neighbor = row[cc];
      if (Number.isFinite(neighbor)) {
        values.push(neighbor);
      }
    }
    return values;
  }
  function scoreCandidateAgainstNeighbors(candidate, neighbors) {
    if (!neighbors.length) return Infinity;
    let score = 0;
    for (let i = 0; i < neighbors.length; i++) {
      score += Math.abs(candidate - neighbors[i]);
    }
    return score / neighbors.length;
  }
  function locallyUnwrapRotationGates(originalRows, correctedRows, nyquistVelocity, rotationMask, debugStats = null) {
    if (!rotationMask || !Array.isArray(rotationMask)) {
      return correctedRows;
    }
    const interval = 2 * nyquistVelocity;
    let locallyAdjustedGateCount = 0;
    const maxPasses = 2;
    const minDiscontinuityToConsider = Math.max(8, nyquistVelocity * 0.6);
    const minImprovementRequired = Math.max(2, nyquistVelocity * 0.15);
    for (let pass = 0; pass < maxPasses; pass++) {
      let passAdjusted = 0;
      for (let r = 0; r < correctedRows.length; r++) {
        for (let c = 0; c < (correctedRows[r]?.length || 0); c++) {
          if (!rotationMask[r]?.[c]) continue;
          const originalValue = originalRows[r]?.[c];
          const currentValue = correctedRows[r]?.[c];
          if (!Number.isFinite(originalValue) || !Number.isFinite(currentValue)) continue;
          const radialNeighbors = collectRadialNeighborValues(correctedRows, r, c, 3);
          const neighbors = radialNeighbors.length >= 2 ? radialNeighbors : collectLocalNeighborValues(correctedRows, r, c);
          if (neighbors.length < 2) continue;
          const baseWrap = Math.round((currentValue - originalValue) / interval);
          let bestValue = currentValue;
          let bestScore = scoreCandidateAgainstNeighbors(currentValue, neighbors);
          if (bestScore < minDiscontinuityToConsider) {
            continue;
          }
          for (let wrapOffset = -1; wrapOffset <= 1; wrapOffset++) {
            const candidateWrap = baseWrap + wrapOffset;
            const candidateValue = originalValue + candidateWrap * interval;
            const score = scoreCandidateAgainstNeighbors(candidateValue, neighbors);
            if (score < bestScore - minImprovementRequired) {
              bestScore = score;
              bestValue = candidateValue;
            }
          }
          if (bestValue !== currentValue) {
            correctedRows[r][c] = bestValue;
            passAdjusted += 1;
          }
        }
      }
      locallyAdjustedGateCount += passAdjusted;
      if (passAdjusted === 0) break;
    }
    if (debugStats) {
      debugStats.rotationLocalAdjustedGateCount = locallyAdjustedGateCount;
    }
    return correctedRows;
  }
  var EdgeCollector = class {
    constructor(totalNodes) {
      this.lIndex = new Array(totalNodes * 4);
      this.nIndex = new Array(totalNodes * 4);
      this.lVelo = new Array(totalNodes * 4);
      this.nVelo = new Array(totalNodes * 4);
      this.idx = 0;
    }
    addEdge(label, neighbor, vel, nvel) {
      if (neighbor === label || neighbor === 0) {
        return 0;
      }
      this.lIndex[this.idx] = label;
      this.nIndex[this.idx] = neighbor;
      this.lVelo[this.idx] = vel;
      this.nVelo[this.idx] = nvel;
      this.idx += 1;
      return 1;
    }
    getIndicesAndVelocities() {
      const indices = [this.lIndex.slice(0, this.idx), this.nIndex.slice(0, this.idx)];
      const velocities = [this.lVelo.slice(0, this.idx), this.nVelo.slice(0, this.idx)];
      return [indices, velocities];
    }
  };
  function findRegions(vel, limits) {
    const label = np.zeros(np.shape(vel));
    let nfeatures = 0;
    for (let i = 0; i < limits.length - 1; i++) {
      const lmin = limits[i];
      const lmax = limits[i + 1];
      const rows = vel.length;
      const cols = vel[0].length;
      const inp = new Array(rows);
      for (let r = 0; r < rows; r++) {
        inp[r] = new Array(cols);
        for (let c = 0; c < cols; c++) {
          inp[r][c] = lmin <= vel[r][c] && vel[r][c] < lmax;
        }
      }
      const [limitLabel, limitNfeatures] = labelImage(inp);
      const llshape = np.shape(limitLabel);
      for (let r = 0; r < llshape[0]; r++) {
        for (let c = 0; c < llshape[1]; c++) {
          if (limitLabel[r][c] !== 0) {
            limitLabel[r][c] += nfeatures;
          }
        }
      }
      for (let r = 0; r < label.length; r++) {
        for (let c = 0; c < label[r].length; c++) {
          label[r][c] += limitLabel[r][c];
        }
      }
      nfeatures += limitNfeatures;
    }
    return [label, nfeatures];
  }
  function dealias2D(velocities, nyquistVelocity, options = {}) {
    if (!Array.isArray(velocities) || velocities.length === 0 || !Number.isFinite(nyquistVelocity) || nyquistVelocity <= 0) {
      return velocities;
    }
    const intervalSplits = 3;
    const skipBetweenRays = 99;
    const skipAlongRay = 100;
    const centered = true;
    const raysWrapAround = true;
    const protectedMask = options.protectedMask || null;
    let sdata = copy(velocities);
    sdata = maskValues(sdata);
    const scorr = copy(velocities);
    const nyquistInterval = 2 * nyquistVelocity;
    const intervalLimits = findSweepIntervalSplits(nyquistVelocity, intervalSplits, sdata);
    const [labels, nfeatures] = findRegions(sdata, intervalLimits);
    if (nfeatures < 2) {
      return scorr;
    }
    const bincount = np.bincount(labels.flat());
    const numMaskedGates = bincount[0] || 0;
    const regionSizes = bincount.slice(1);
    const [indices, edgeCount, velos] = edgeSumAndCount(
      labels,
      numMaskedGates,
      sdata,
      raysWrapAround,
      skipBetweenRays,
      skipAlongRay,
      protectedMask
    );
    if (edgeCount.length === 0) {
      return scorr;
    }
    const regionTracker = new RegionTracker(regionSizes);
    const edgeTracker = new EdgeTracker(indices, edgeCount, velos, nyquistInterval, nfeatures + 1);
    while (true) {
      if (combineRegions(regionTracker, edgeTracker)) {
        break;
      }
    }
    if (centered) {
      const gatesDealiased = regionSizes.reduce((a, b) => a + b, 0);
      let totalFolds = 0;
      for (let i = 0; i < regionSizes.length; i++) {
        totalFolds += regionSizes[i] * regionTracker.unwrapNumber[i + 1];
      }
      const sweepOffset = Math.round(totalFolds / gatesDealiased);
      if (sweepOffset !== 0) {
        for (let i = 0; i < regionTracker.unwrapNumber.length; i++) {
          regionTracker.unwrapNumber[i] -= sweepOffset;
        }
      }
    }
    for (let i = 1; i < nfeatures + 1; i++) {
      const nwrap = regionTracker.unwrapNumber[i];
      if (nwrap !== 0) {
        for (let r = 0; r < labels.length; r++) {
          for (let c = 0; c < labels[0].length; c++) {
            if (labels[r][c] === i) {
              scorr[r][c] += nwrap * nyquistInterval;
            }
          }
        }
      }
    }
    return scorr;
  }
  var inferNyquistFromData = (rows) => {
    let maxAbs = 0;
    let foundFinite = false;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        const value = row[c];
        if (!Number.isFinite(value)) continue;
        foundFinite = true;
        const abs = Math.abs(value);
        if (abs > maxAbs) maxAbs = abs;
      }
    }
    if (!foundFinite) return null;
    if (!Number.isFinite(maxAbs) || maxAbs <= 0) return null;
    return maxAbs;
  };
  var inferNyquistFromHeaders = (headers) => {
    if (!Array.isArray(headers)) return null;
    const normalizeNyquist = (value) => {
      if (!Number.isFinite(value) || value <= 0) return null;
      return value > 300 ? value / 100 : value;
    };
    const values = headers.map((header) => normalizeNyquist(Number(header?.radial?.nyquist_velocity))).filter((value) => Number.isFinite(value) && value > 0);
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  function dealiasVelocityRadials(radials, options = {}) {
    if (!Array.isArray(radials) || radials.length === 0) {
      return radials;
    }
    let maxGateCount = 0;
    for (let i = 0; i < radials.length; i++) {
      const gateCount = Number(radials[i]?.gate_count || 0);
      if (gateCount > maxGateCount) {
        maxGateCount = gateCount;
      }
    }
    if (maxGateCount <= 0) {
      return radials;
    }
    const rows = new Array(radials.length);
    for (let r = 0; r < radials.length; r++) {
      rows[r] = new Array(maxGateCount).fill(null);
      const radial = radials[r];
      if (!radial || !Array.isArray(radial.moment_data)) {
        continue;
      }
      const gateCount = Math.min(Number(radial.gate_count || 0), radial.moment_data.length, maxGateCount);
      for (let g = 0; g < gateCount; g++) {
        const value = radial.moment_data[g];
        rows[r][g] = Number.isFinite(value) ? value : null;
      }
    }
    const nyquistVelocity = Number(options?.nyquistVelocity);
    const headerNyquist = inferNyquistFromHeaders(options?.headers);
    const inferredNyquist = inferNyquistFromData(rows);
    const nyquist = Number.isFinite(nyquistVelocity) && nyquistVelocity > 0 ? nyquistVelocity : headerNyquist || inferredNyquist;
    if (!Number.isFinite(nyquist) || nyquist <= 0) {
      return radials;
    }
    const rotationProtection = buildRotationProtectionMask(rows, nyquist, options?.rotationProtection);
    if (options?.debugStats) {
      options.debugStats.rotationProtectedGateCount = rotationProtection?.protectedCount || 0;
      options.debugStats.rotationProtectedExpandedGateCount = rotationProtection?.dilatedProtectedCount || 0;
    }
    const corrected = dealias2D(rows, nyquist);
    locallyUnwrapRotationGates(rows, corrected, nyquist, rotationProtection?.mask || null, options?.debugStats || null);
    if (options?.debugMaskToRf === true && rotationProtection?.mask) {
      let forcedMaskGateCount = 0;
      for (let r = 0; r < corrected.length; r++) {
        for (let g = 0; g < (corrected[r]?.length || 0); g++) {
          if (!rotationProtection.mask[r]?.[g]) {
            continue;
          }
          if (!Number.isFinite(rows[r]?.[g])) {
            continue;
          }
          corrected[r][g] = -100;
          forcedMaskGateCount += 1;
        }
      }
      if (options?.debugStats) {
        options.debugStats.rotationMaskForcedRfGateCount = forcedMaskGateCount;
      }
    }
    for (let r = 0; r < radials.length; r++) {
      const radial = radials[r];
      if (!radial || !Array.isArray(radial.moment_data)) {
        continue;
      }
      const gateCount = Math.min(Number(radial.gate_count || 0), radial.moment_data.length, corrected[r]?.length || 0);
      for (let g = 0; g < gateCount; g++) {
        const originalValue = radial.moment_data[g];
        const correctedValue = corrected[r][g];
        if (Number.isFinite(originalValue) && Number.isFinite(correctedValue)) {
          radial.moment_data[g] = correctedValue;
        }
      }
    }
    return radials;
  }

  // radar_worker.js
  var LEVEL3_PARSE_MODE = "fast";
  var EARTH_RADIUS = 6371e3;
  var DEG_TO_RAD = Math.PI / 180;
  var RAD_TO_DEG = 180 / Math.PI;
  var getLevel2MomentForLayer = (layer) => {
    const upperLayer = typeof layer === "string" ? layer.toUpperCase() : "";
    switch (upperLayer) {
      case "REF":
        return "reflect";
      case "VEL":
        return "velocity";
      case "CC":
        return "rho";
      case "KDP":
        return "phi";
      case "SW":
        return "spectrum";
      case "ZDR":
        return "zdr";
      default:
        return null;
    }
  };
  var getLevel2Vcp = (radar, header = null) => {
    const patternNumber = Number(radar?.vcp?.record?.pattern_number);
    if (Number.isFinite(patternNumber)) {
      return patternNumber;
    }
    const headerVcp = Number(header?.vcp);
    if (Number.isFinite(headerVcp)) {
      return headerVcp;
    }
    return null;
  };
  var createRadarProjector = (radarLat, radarLon) => {
    const lat1 = radarLat * DEG_TO_RAD;
    const lon1 = radarLon * DEG_TO_RAD;
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const rangeCache = /* @__PURE__ */ new Map();
    return (sinAz, cosAz, distanceMeters) => {
      let entry = rangeCache.get(distanceMeters);
      if (entry === void 0) {
        const dR = distanceMeters / EARTH_RADIUS;
        entry = { s: Math.sin(dR), c: Math.cos(dR) };
        rangeCache.set(distanceMeters, entry);
      }
      const lat2 = Math.asin(sinLat1 * entry.c + cosLat1 * entry.s * cosAz);
      const lon2 = lon1 + Math.atan2(
        sinAz * entry.s * cosLat1,
        entry.c - sinLat1 * Math.sin(lat2)
      );
      return [lon2 * RAD_TO_DEG, lat2 * RAD_TO_DEG];
    };
  };
  var buildPolygon = (project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2) => {
    const p1 = project(sinAz1, cosAz1, r1);
    const p2 = project(sinAz2, cosAz2, r1);
    const p3 = project(sinAz2, cosAz2, r2);
    const p4 = project(sinAz1, cosAz1, r2);
    return [p1, p2, p3, p4];
  };
  var createMeshBuilder = (includeGeojson) => {
    const mesh = [];
    const features = includeGeojson ? [] : null;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    const updateBounds = (point) => {
      const lng = point[0];
      const lat = point[1];
      minLng = Math.min(minLng, lng);
      minLat = Math.min(minLat, lat);
      maxLng = Math.max(maxLng, lng);
      maxLat = Math.max(maxLat, lat);
    };
    const pushQuad = (quad, value) => {
      for (let i = 0; i < 4; i++) {
        updateBounds(quad[i]);
      }
      const encodedValue = value === "rf" ? NaN : value;
      mesh.push(
        quad[0][0],
        quad[0][1],
        quad[1][0],
        quad[1][1],
        quad[2][0],
        quad[2][1],
        quad[3][0],
        quad[3][1],
        encodedValue
      );
      if (features) {
        const closed = [quad[0], quad[1], quad[2], quad[3], quad[0]];
        features.push({
          type: "Feature",
          properties: { val: value === "rf" ? "rf" : value },
          geometry: { type: "Polygon", coordinates: [closed] }
        });
      }
    };
    const finalize = () => {
      const meshData = new Float32Array(mesh);
      const bounds = Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
      const geojson = features ? { type: "FeatureCollection", features } : null;
      return { meshData, bounds, geojson };
    };
    return { pushQuad, finalize };
  };
  var processRadarData = (radar, radarLocation, extent, layer, options = {}) => {
    let radarData;
    if (layer === "REF") {
      radarData = radar.getHighresReflectivity();
    } else if (layer === "VEL") {
      radarData = radar.getHighresVelocity();
      if (Array.isArray(radarData) && radarData.every((item) => item === void 0)) {
        const elevationLevels = radar.listElevations().sort((a, b) => a - b);
        let currentIndex = elevationLevels.indexOf(radar.elevation);
        while (currentIndex + 1 < elevationLevels.length) {
          currentIndex += 1;
          radar.setElevation(elevationLevels[currentIndex]);
          radarData = radar.getHighresVelocity();
          if (Array.isArray(radarData) && !radarData.every((item) => item === void 0)) {
            break;
          }
        }
      }
    } else if (layer === "CC") {
      radarData = radar.getHighresCorrelationCoefficient();
    } else if (layer === "KDP") {
      radarData = radar.getHighresDiffPhase();
    } else if (layer === "SW") {
      radarData = radar.getHighresSpectrum();
    } else if (layer == "ZDR") {
      radarData = radar.getHighresDiffReflectivity();
    } else {
      throw new Error(`Unknown radar layer: ${layer}`);
    }
    if (Array.isArray(radarData) && radarData.length > 0 && radarData.every((item) => item === void 0)) {
      throw new Error(`No ${layer} data at elevation ${radar.elevation} - this tilt may not carry this moment, try a different tilt`);
    }
    if (!Array.isArray(radarData) || radarData.length === 0) {
      throw new Error(`No radar data available for layer: ${layer}`);
    }
    const numberOfRadarIterations = radarData.length;
    const gateLimit = Number.isFinite(options.gate_limit) ? options.gate_limit : null;
    const project = createRadarProjector(radarLocation[0], radarLocation[1]);
    const includeGeojson = options.includeGeojson === true;
    const builder = createMeshBuilder(includeGeojson);
    const scanIsPartial = Boolean(radar?.hasGaps || radar?.isTruncated);
    const headers = radar.getHeader();
    const shouldDealiasLevel2Velocity = layer === "VEL" && options?.enableVelocityDealias !== false;
    if (shouldDealiasLevel2Velocity) {
      try {
        const firstNyquist = Number(headers?.[0]?.radial?.nyquist_velocity);
        radarData = dealiasVelocityRadials(radarData, {
          nyquistVelocity: Number.isFinite(firstNyquist) && firstNyquist > 0 ? firstNyquist : void 0,
          headers
        });
      } catch (error) {
        console.error("Velocity dealiasing failed:", error);
      }
    }
    const forwardDelta = (fromAz, toAz) => {
      if (!Number.isFinite(fromAz) || !Number.isFinite(toAz)) return 1;
      let delta = toAz - fromAz;
      while (delta <= 0) delta += 360;
      return delta;
    };
    const getAzimuthPair = (index) => {
      const current = headers?.[index];
      if (!current || !Number.isFinite(current.azimuth)) return null;
      const az1 = current.azimuth;
      const prev = index > 0 ? headers[index - 1] : null;
      const next = index + 1 < numberOfRadarIterations ? headers[index + 1] : null;
      const prevDelta = prev && Number.isFinite(prev.azimuth) ? forwardDelta(prev.azimuth, az1) : null;
      let delta;
      if (next && Number.isFinite(next.azimuth)) {
        delta = forwardDelta(az1, next.azimuth);
      } else {
        if (!scanIsPartial && headers?.[0] && Number.isFinite(headers[0].azimuth)) {
          delta = forwardDelta(az1, headers[0].azimuth);
        } else {
          delta = Number.isFinite(prevDelta) ? prevDelta : 1;
        }
      }
      const az2 = az1 + (Number.isFinite(delta) && delta > 0 ? delta : 1);
      return { az1, az2 };
    };
    const normalizePhiDelta = (delta) => {
      if (!Number.isFinite(delta)) return null;
      if (delta > 180) return delta - 360;
      if (delta < -180) return delta + 360;
      return delta;
    };
    const computeKdpFromPhi = (momentData, gateIndex, gateSizeKm) => {
      if (!Array.isArray(momentData) || !Number.isFinite(gateSizeKm) || gateSizeKm <= 0) return null;
      let leftIndex = null;
      let rightIndex = null;
      for (let step = 1; step <= 3; step++) {
        const li = gateIndex - step;
        const ri = gateIndex + step;
        if (leftIndex == null && li >= 0 && Number.isFinite(momentData[li])) leftIndex = li;
        if (rightIndex == null && ri < momentData.length && Number.isFinite(momentData[ri])) rightIndex = ri;
        if (leftIndex != null && rightIndex != null) break;
      }
      let kdp = null;
      if (leftIndex != null && rightIndex != null && rightIndex > leftIndex) {
        const dPhi = normalizePhiDelta(momentData[rightIndex] - momentData[leftIndex]);
        if (Number.isFinite(dPhi)) {
          kdp = 0.5 * (dPhi / ((rightIndex - leftIndex) * gateSizeKm));
        }
      }
      if (!Number.isFinite(kdp)) {
        const curr = momentData[gateIndex];
        if (Number.isFinite(curr) && rightIndex != null && rightIndex > gateIndex) {
          const dPhi = normalizePhiDelta(momentData[rightIndex] - curr);
          if (Number.isFinite(dPhi)) kdp = 0.5 * (dPhi / ((rightIndex - gateIndex) * gateSizeKm));
        } else if (Number.isFinite(curr) && leftIndex != null && gateIndex > leftIndex) {
          const dPhi = normalizePhiDelta(curr - momentData[leftIndex]);
          if (Number.isFinite(dPhi)) kdp = 0.5 * (dPhi / ((gateIndex - leftIndex) * gateSizeKm));
        }
      }
      if (!Number.isFinite(kdp)) return null;
      if (kdp < 0) kdp = 0;
      if (kdp > 20) kdp = 20;
      return kdp;
    };
    for (let index = 0; index < numberOfRadarIterations; index++) {
      const radial = radarData[index];
      if (!radial || typeof radial !== "object" || !radial.moment_data || typeof radial.gate_count !== "number") continue;
      const azPair = getAzimuthPair(index);
      if (!azPair) continue;
      const { az1, az2 } = azPair;
      const az1Rad = az1 * DEG_TO_RAD;
      const az2Rad = az2 * DEG_TO_RAD;
      const sinAz1 = Math.sin(az1Rad);
      const cosAz1 = Math.cos(az1Rad);
      const sinAz2 = Math.sin(az2Rad);
      const cosAz2 = Math.cos(az2Rad);
      const firstGate = radial.first_gate;
      const gateSize = radial.gate_size;
      for (let gateIndex = 0; gateIndex < radial.gate_count - 1; gateIndex++) {
        const rawValue = radial.moment_data[gateIndex];
        if (rawValue === null) continue;
        const r1 = (firstGate + gateIndex * gateSize) * 1e3;
        const r2 = (firstGate + (gateIndex + 1) * gateSize) * 1e3;
        let value = rawValue;
        if (layer === "KDP") {
          if (value !== "rf") value = computeKdpFromPhi(radial.moment_data, gateIndex, gateSize);
        }
        if (value == null) continue;
        if (layer === "REF" && gateLimit !== null && value !== "rf" && value < gateLimit) continue;
        if (layer === "VEL" && value !== "rf" && Number.isFinite(value)) value *= 1.94384;
        const coords = buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2);
        builder.pushQuad(coords, value);
      }
    }
    return builder.finalize();
  };
  var processLevel3Data = (radar, radarLocation, options = {}) => {
    const radialPackets = Array.isArray(radar.radialPackets) ? radar.radialPackets : [];
    const packet = radialPackets.find((entry) => entry && Array.isArray(entry.radials));
    if (!packet) throw new Error("No radial packet data found in Level 3 product.");
    const rangeScaleKm = packet.rangeScale ?? 1;
    const firstBin = packet.firstBin ?? 0;
    const numberBins = packet.numberBins ?? 0;
    const radials = packet.radials || [];
    const gateLimit = Number.isFinite(options.gate_limit) ? options.gate_limit : 0;
    const project = createRadarProjector(radarLocation[0], radarLocation[1]);
    const builder = createMeshBuilder(options.includeGeojson === true);
    for (let index = 0; index < radials.length; index++) {
      const radial = radials[index];
      if (!radial || typeof radial !== "object") continue;
      const az1 = radial.startAngle;
      const az2 = radial.startAngle + radial.angleDelta;
      const az1Rad = az1 * DEG_TO_RAD;
      const az2Rad = az2 * DEG_TO_RAD;
      const sinAz1 = Math.sin(az1Rad);
      const cosAz1 = Math.cos(az1Rad);
      const sinAz2 = Math.sin(az2Rad);
      const cosAz2 = Math.cos(az2Rad);
      const bins = radial.bins || [];
      for (let binIndex = 0; binIndex < Math.min(bins.length, numberBins); binIndex++) {
        var value = bins[binIndex];
        if (value == null) continue;
        let scaleFactor = 250;
        if (radar.productDescription.code === 56) {
          scaleFactor = 1e3;
          const map56 = { 15: "rf", 14: 64, 13: 50, 12: 36, 11: 26, 10: 20, 9: 10, 8: 0, 7: -1, 6: -10, 5: -20, 4: -26, 3: -36, 2: -50, 1: -64, 0: null };
          value = map56[value];
        } else if (radar.productDescription.code === 170 || radar.productDescription.code === 172) {
          scaleFactor = 1e3;
          if (value == "rf") value = 0;
        }
        if (value == null) continue;
        if (value !== "rf" && gateLimit && value < gateLimit) continue;
        const r1 = (firstBin + binIndex * rangeScaleKm) * scaleFactor;
        const r2 = (firstBin + (binIndex + 1) * rangeScaleKm) * scaleFactor;
        builder.pushQuad(buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2), value);
      }
    }
    return builder.finalize();
  };
  var getLevel3Metadata = (radar) => {
    const pd = radar?.productDescription;
    if (!pd) return { timeIso: null, elevationAngle: null, vcp: null };
    const dateValue = Number(pd.volumeScanDate ?? pd.productDate);
    const timeValue = Number(pd.volumeScanTime ?? pd.productTime);
    let timeIso = null;
    if (Number.isFinite(dateValue) && Number.isFinite(timeValue)) {
      timeIso = new Date((dateValue * 86400 + timeValue) * 1e3).toISOString();
    }
    return {
      timeIso,
      elevationAngle: Number.isFinite(pd.elevationAngle) ? pd.elevationAngle : null,
      vcp: Number.isFinite(pd.vcp) ? pd.vcp : null
    };
  };
  var toEpochMs = (monotonicMs) => performance.timeOrigin + monotonicMs;
  self.onmessage = (event) => {
    const { type } = event.data || {};
    if (type === "process-chunks") {
      const { buffers: rawBuffers, layer: chunkLayer, options: chunkOptions = {} } = event.data;
      if (!Array.isArray(rawBuffers) || rawBuffers.length === 0) {
        self.postMessage({ type: "error", message: "process-chunks: no buffers provided" });
        return;
      }
      try {
        const parserStartMs = toEpochMs(performance.now());
        const requestedMoment = getLevel2MomentForLayer(chunkLayer);
        const parsedChunks = rawBuffers.map(
          (buf) => new import_nexrad_level_2_data.Level2Radar(import_buffer2.Buffer.from(buf), requestedMoment ? { includeMoments: [requestedMoment] } : void 0)
        );
        const radar = import_nexrad_level_2_data.Level2Radar.combineData(...parsedChunks);
        const parserEndMs = toEpochMs(performance.now());
        const elevations = radar.listElevations();
        radar.setElevation(elevations[0] || 1);
        const recordHeader = radar.getHeader(0);
        const radarLocation = [recordHeader.volume.latitude, recordHeader.volume.longitude];
        const { meshData, bounds, geojson } = processRadarData(radar, radarLocation, recordHeader.radial_length, chunkLayer, chunkOptions);
        const meshEndMs = toEpochMs(performance.now());
        self.postMessage({
          type: "result",
          geojson,
          meshData,
          bounds,
          metadata: {
            station: chunkOptions.station || null,
            product: chunkLayer,
            timeIso: null,
            elevationAngle: recordHeader.elevation_angle,
            vcp: getLevel2Vcp(radar, recordHeader)
          },
          timing: { parserStartMs, parserEndMs, meshEndMs }
        }, [meshData.buffer]);
      } catch (err) {
        self.postMessage({ type: "error", message: err.message || String(err) });
      }
      return;
    }
    const { arrayBuffer, layer, options } = event.data || {};
    if (type !== "process" || !arrayBuffer) return;
    try {
      const parserStartMs = toEpochMs(performance.now());
      let parserEndMs = null;
      let meshEndMs = null;
      const upperLayer = typeof layer === "string" ? layer.toUpperCase() : "";
      const isLevel2Product = ["REF", "VEL", "CC", "KDP", "SW", "ZDR"].includes(upperLayer);
      const buffer = import_buffer2.Buffer.from(arrayBuffer);
      if (!isLevel2Product) {
        const requestedParseMode = typeof options?.level3ParseMode === "string" ? options.level3ParseMode.toLowerCase() : null;
        const level3ParseMode = requestedParseMode === "full" ? "full" : LEVEL3_PARSE_MODE;
        const radar = (0, import_nexrad_level_3_data.default)(
          buffer,
          level3ParseMode === "fast" ? { logger: false, parseGraphic: false, parseTabular: false, parseFormatted: false, includeRawBinData: false, includePacketMetadata: false, parseFirstRadialPacketOnly: true, minimalOutput: true } : { logger: false }
        );
        parserEndMs = toEpochMs(performance.now());
        const radarLat = radar.productDescription?.latitude;
        const radarLon = radar.productDescription?.longitude;
        if (radarLat == null || radarLon == null) throw new Error("Missing radar location in Level 3 product description.");
        const { meshData, bounds, geojson } = processLevel3Data(radar, [radarLat, radarLon], options);
        meshEndMs = toEpochMs(performance.now());
        const { timeIso, elevationAngle, vcp } = getLevel3Metadata(radar);
        self.postMessage({ type: "result", geojson, meshData, bounds, metadata: { station: options?.station || null, product: layer, timeIso, elevationAngle, vcp }, timing: { parserStartMs, parserEndMs, meshEndMs } }, [meshData.buffer]);
      } else {
        const requestedMoment = getLevel2MomentForLayer(layer);
        const radar = new import_nexrad_level_2_data.Level2Radar(buffer, { logger: false, includeMoments: requestedMoment ? [requestedMoment] : void 0 });
        parserEndMs = toEpochMs(performance.now());
        const elevationNumbers = radar.listElevations();
        const elevations = elevationNumbers.map((number) => {
          radar.setElevation(number);
          const h = radar.getHeader(0);
          return { number, angle: Number.isFinite(h?.elevation_angle) ? h.elevation_angle : null };
        });
        if (options?.elevation && elevationNumbers.includes(options.elevation)) {
          radar.setElevation(options.elevation);
        } else {
          radar.setElevation(elevationNumbers[0] || 1);
        }
        const header = radar.getHeader(0);
        const radarLocation = [header.volume.latitude, header.volume.longitude];
        const { meshData, bounds, geojson } = processRadarData(radar, radarLocation, header.radial_length, layer, options);
        meshEndMs = toEpochMs(performance.now());
        self.postMessage({
          type: "result",
          geojson,
          meshData,
          bounds,
          metadata: {
            timeIso: new Date(header.julian_date * 86400 * 1e3 + header.mseconds - 36e5).toISOString(),
            elevationAngle: header.elevation_angle,
            elevationNumber: header.elevation_number,
            elevations,
            station: options?.station || null,
            vcp: getLevel2Vcp(radar, header)
          },
          timing: { parserStartMs, parserEndMs, meshEndMs }
        }, [meshData.buffer]);
      }
    } catch (error) {
      self.postMessage({ type: "error", message: error?.message || String(error) });
    }
  };
})();
/*! Bundled license information:

ieee754/index.js:
  (*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> *)

buffer/index.js:
  (*!
   * The buffer module from node.js, for the browser.
   *
   * @author   Feross Aboukhadijeh <https://feross.org>
   * @license  MIT
   *)
*/
