// TDWR digital base reflectivity.
//
// The terminal radars at airports publish their own products, and this parser
// knew none of them, so every terminal answered "Unsupported product type:
// TZ0". The product description block is laid out exactly as the super
// resolution reflectivity above it, which AtticRadar's own tables confirm:
// both read the elevation angle at halfword 32, the maximum at 33, and the
// compression and uncompressed size at 37 and 38 to 39. So this is 153's
// reader with the terminals' product code and names.

import { RandomAccessFile } from '../../randomaccessfile/index.js';

const code = 180;
const abbreviation = ['TZ0', 'TZ1', 'TZ2', 'TZ3'];
const description = 'TDWR Base Reflectivity';

// eslint-disable-next-line camelcase
const halfwords30_53 = (data) => {
	const raf = new RandomAccessFile(data);
	return {
		elevationAngle: raf.readShort() / 10,
		plot: {
			minimumDataValue: raf.readShort() / 10,
			dataIncrement: raf.readShort() / 10,
			dataLevels: raf.readShort(),
		},
		dependent34_46: raf.read(26),
		maxReflectivity: raf.readShort(),	// dBZ
		dependent48_49: raf.read(4),
		deltaTime: raf.readShort(),
		compressionMethod: raf.readShort(),
		uncompressedProductSize: (raf.readUShort() << 16) + raf.readUShort(),
	};
};

const product = {
	code,
	abbreviation,
	description,
	productDescription: {
		halfwords30_53,
	},
};

if (typeof module !== 'undefined') {
	module.exports = product;
}

export default product;
export { code, abbreviation, description, halfwords30_53 };
