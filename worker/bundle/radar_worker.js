import { Buffer } from 'buffer';
import { Level2Radar } from 'nexrad-level-2-data';
import nexradLevel3Data from 'nexrad-level-3-data';
import { dealiasVelocityRadials } from './dealias.js';

const LEVEL3_PARSE_MODE = 'fast';

const EARTH_RADIUS = 6371000;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const getLevel2MomentForLayer = (layer) => {
    const upperLayer = typeof layer === 'string' ? layer.toUpperCase() : '';
    switch (upperLayer) {
    case 'REF':
        return 'reflect';
    case 'VEL':
        return 'velocity';
    case 'CC':
        return 'rho';
    case 'KDP':
        return 'phi';
    case 'SW':
        return 'spectrum';
    case 'ZDR':
        return 'zdr';
    default:
        return null;
    }
};

const getLevel2Vcp = (radar, header = null) => {
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

const createRadarProjector = (radarLat, radarLon) => {
    const lat1 = radarLat * DEG_TO_RAD;
    const lon1 = radarLon * DEG_TO_RAD;
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const rangeCache = new Map();

    return (sinAz, cosAz, distanceMeters) => {
        let entry = rangeCache.get(distanceMeters);
        if (entry === undefined) {
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

const buildPolygon = (project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2) => {
    const p1 = project(sinAz1, cosAz1, r1);
    const p2 = project(sinAz2, cosAz2, r1);
    const p3 = project(sinAz2, cosAz2, r2);
    const p4 = project(sinAz1, cosAz1, r2);
    return [p1, p2, p3, p4];
};

const createMeshBuilder = (includeGeojson) => {
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
        const encodedValue = value === 'rf' ? NaN : value;
        mesh.push(
            quad[0][0], quad[0][1],
            quad[1][0], quad[1][1],
            quad[2][0], quad[2][1],
            quad[3][0], quad[3][1],
            encodedValue
        );
        if (features) {
            const closed = [quad[0], quad[1], quad[2], quad[3], quad[0]];
            features.push({
                type: 'Feature',
                properties: { val: value === 'rf' ? 'rf' : value },
                geometry: { type: 'Polygon', coordinates: [closed] }
            });
        }
    };

    const finalize = () => {
        const meshData = new Float32Array(mesh);
        const bounds = Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
        const geojson = features ? { type: 'FeatureCollection', features } : null;
        return { meshData, bounds, geojson };
    };

    return { pushQuad, finalize };
};

const processRadarData = (radar, radarLocation, extent, layer, options = {}) => {
    let radarData;
    if (layer === 'REF') {
        radarData = radar.getHighresReflectivity();
    } else if (layer === 'VEL') {
        radarData = radar.getHighresVelocity();
        if (Array.isArray(radarData) && radarData.every(item => item === undefined)) {
            const elevationLevels = radar.listElevations().sort((a, b) => a - b);
            let currentIndex = elevationLevels.indexOf(radar.elevation);
            while (currentIndex + 1 < elevationLevels.length) {
                currentIndex += 1;
                radar.setElevation(elevationLevels[currentIndex]);
                radarData = radar.getHighresVelocity();
                if (Array.isArray(radarData) && !radarData.every(item => item === undefined)) {
                    break;
                }
            }
        }
    } else if (layer === 'CC') {
        radarData = radar.getHighresCorrelationCoefficient();
    } else if (layer === 'KDP') {
        radarData = radar.getHighresDiffPhase();
    } else if (layer === 'SW') {
        radarData = radar.getHighresSpectrum();
    } else if (layer == 'ZDR') {
        radarData = radar.getHighresDiffReflectivity();
    } else {
        throw new Error(`Unknown radar layer: ${layer}`);
    }

    // CC/ZDR/KDP/SW aren't broadcast on every tilt of every VCP - a tilt that
    // lacks the moment comes back as an array of nothing but `undefined`
    // (not an empty array, so the length check below wouldn't have caught
    // it), which used to fall all the way through to a generic "no data
    // returned" only after building an empty mesh. Catching it here gives a
    // specific, actionable message instead.
    if (Array.isArray(radarData) && radarData.length > 0 && radarData.every((item) => item === undefined)) {
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

    const shouldDealiasLevel2Velocity = layer === 'VEL' && options?.enableVelocityDealias !== false;

    if (shouldDealiasLevel2Velocity) {
        try {
            const firstNyquist = Number(headers?.[0]?.radial?.nyquist_velocity);
            radarData = dealiasVelocityRadials(radarData, {
                nyquistVelocity: Number.isFinite(firstNyquist) && firstNyquist > 0 ? firstNyquist : undefined,
                headers,
            });
        } catch (error) {
            console.error('Velocity dealiasing failed:', error);
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
        if (!radial || typeof radial !== 'object' || !radial.moment_data || typeof radial.gate_count !== 'number') continue;
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
            const r1 = (firstGate + gateIndex * gateSize) * 1000;
            const r2 = (firstGate + (gateIndex + 1) * gateSize) * 1000;
            let value = rawValue;
            if (layer === 'KDP') {
                if (value !== 'rf') value = computeKdpFromPhi(radial.moment_data, gateIndex, gateSize);
            }
            if (value == null) continue;
            if (layer === 'REF' && gateLimit !== null && value !== 'rf' && value < gateLimit) continue;
            if (layer === 'VEL' && value !== 'rf' && Number.isFinite(value)) value *= 1.94384;
            const coords = buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2);
            builder.pushQuad(coords, value);
        }
    }

    return builder.finalize();
};

const processLevel3Data = (radar, radarLocation, options = {}) => {
    const radialPackets = Array.isArray(radar.radialPackets) ? radar.radialPackets : [];
    const packet = radialPackets.find((entry) => entry && Array.isArray(entry.radials));
    if (!packet) throw new Error('No radial packet data found in Level 3 product.');
    const rangeScaleKm = packet.rangeScale ?? 1;
    const firstBin = packet.firstBin ?? 0;
    const numberBins = packet.numberBins ?? 0;
    const radials = packet.radials || [];
    const gateLimit = Number.isFinite(options.gate_limit) ? options.gate_limit : 0;
    const project = createRadarProjector(radarLocation[0], radarLocation[1]);
    const builder = createMeshBuilder(options.includeGeojson === true);

    for (let index = 0; index < radials.length; index++) {
        const radial = radials[index];
        if (!radial || typeof radial !== 'object') continue;
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
                scaleFactor = 1000;
                const map56 = { 15:'rf',14:64,13:50,12:36,11:26,10:20,9:10,8:0,7:-1,6:-10,5:-20,4:-26,3:-36,2:-50,1:-64,0:null };
                value = map56[value];
            } else if (radar.productDescription.code === 170 || radar.productDescription.code === 172) {
                scaleFactor = 1000;
                if (value == 'rf') value = 0;
            }
            if (value == null) continue;
            if (value !== 'rf' && gateLimit && value < gateLimit) continue;
            const r1 = (firstBin + (binIndex * rangeScaleKm)) * scaleFactor;
            const r2 = (firstBin + ((binIndex + 1) * rangeScaleKm)) * scaleFactor;
            builder.pushQuad(buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2), value);
        }
    }

    return builder.finalize();
};

const getLevel3Metadata = (radar) => {
    const pd = radar?.productDescription;
    if (!pd) return { timeIso: null, elevationAngle: null, vcp: null };
    const dateValue = Number(pd.volumeScanDate ?? pd.productDate);
    const timeValue = Number(pd.volumeScanTime ?? pd.productTime);
    let timeIso = null;
    if (Number.isFinite(dateValue) && Number.isFinite(timeValue)) {
        timeIso = new Date((dateValue * 86400 + timeValue) * 1000).toISOString();
    }
    return {
        timeIso,
        elevationAngle: Number.isFinite(pd.elevationAngle) ? pd.elevationAngle : null,
        vcp: Number.isFinite(pd.vcp) ? pd.vcp : null,
    };
};

const toEpochMs = (monotonicMs) => performance.timeOrigin + monotonicMs;

self.onmessage = (event) => {
    const { type } = event.data || {};

    if (type === 'process-chunks') {
        const { buffers: rawBuffers, layer: chunkLayer, options: chunkOptions = {} } = event.data;
        if (!Array.isArray(rawBuffers) || rawBuffers.length === 0) {
            self.postMessage({ type: 'error', message: 'process-chunks: no buffers provided' });
            return;
        }
        try {
            const parserStartMs = toEpochMs(performance.now());
            const requestedMoment = getLevel2MomentForLayer(chunkLayer);
            const parsedChunks = rawBuffers.map(buf =>
                new Level2Radar(Buffer.from(buf), requestedMoment ? { includeMoments: [requestedMoment] } : undefined)
            );
            const radar = Level2Radar.combineData(...parsedChunks);
            const parserEndMs = toEpochMs(performance.now());
            const elevations = radar.listElevations();
            radar.setElevation(elevations[0] || 1);
            const recordHeader = radar.getHeader(0);
            const radarLocation = [recordHeader.volume.latitude, recordHeader.volume.longitude];
            const { meshData, bounds, geojson } = processRadarData(radar, radarLocation, recordHeader.radial_length, chunkLayer, chunkOptions);
            const meshEndMs = toEpochMs(performance.now());
            self.postMessage({
                type: 'result',
                geojson,
                meshData,
                bounds,
                metadata: {
                    station: chunkOptions.station || null,
                    product: chunkLayer,
                    timeIso: null,
                    elevationAngle: recordHeader.elevation_angle,
                    vcp: getLevel2Vcp(radar, recordHeader),
                },
                timing: { parserStartMs, parserEndMs, meshEndMs },
            }, [meshData.buffer]);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
        return;
    }

    const { arrayBuffer, layer, options } = event.data || {};
    if (type !== 'process' || !arrayBuffer) return;

    try {
        const parserStartMs = toEpochMs(performance.now());
        let parserEndMs = null;
        let meshEndMs = null;
        const upperLayer = typeof layer === 'string' ? layer.toUpperCase() : '';
        const isLevel2Product = ['REF','VEL','CC','KDP','SW','ZDR'].includes(upperLayer);
        const buffer = Buffer.from(arrayBuffer);

        if (!isLevel2Product) {
            const requestedParseMode = typeof options?.level3ParseMode === 'string'
                ? options.level3ParseMode.toLowerCase() : null;
            const level3ParseMode = requestedParseMode === 'full' ? 'full' : LEVEL3_PARSE_MODE;
            const radar = nexradLevel3Data(buffer, level3ParseMode === 'fast'
                ? { logger: false, parseGraphic: false, parseTabular: false, parseFormatted: false, includeRawBinData: false, includePacketMetadata: false, parseFirstRadialPacketOnly: true, minimalOutput: true }
                : { logger: false }
            );
            parserEndMs = toEpochMs(performance.now());
            const radarLat = radar.productDescription?.latitude;
            const radarLon = radar.productDescription?.longitude;
            if (radarLat == null || radarLon == null) throw new Error('Missing radar location in Level 3 product description.');
            const { meshData, bounds, geojson } = processLevel3Data(radar, [radarLat, radarLon], options);
            meshEndMs = toEpochMs(performance.now());
            const { timeIso, elevationAngle, vcp } = getLevel3Metadata(radar);
            self.postMessage({ type: 'result', geojson, meshData, bounds, metadata: { station: options?.station || null, product: layer, timeIso, elevationAngle, vcp }, timing: { parserStartMs, parserEndMs, meshEndMs } }, [meshData.buffer]);
        } else {
            const requestedMoment = getLevel2MomentForLayer(layer);
            const radar = new Level2Radar(buffer, { logger: false, includeMoments: requestedMoment ? [requestedMoment] : undefined });
            parserEndMs = toEpochMs(performance.now());
            const elevationNumbers = radar.listElevations();
            // setElevation() here is a cheap re-point into the already-fully-
            // parsed volume, not a re-decode, so visiting every tilt just to
            // read its real angle (the VCP determines how many tilts exist and
            // at what angles - anywhere from 4 to 15+) costs nothing extra
            // compared to the mesh-building step below, which only runs once
            // for whichever single tilt actually gets rendered.
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
                type: 'result', geojson, meshData, bounds,
                metadata: {
                    timeIso: new Date((header.julian_date * 86400 * 1000) + header.mseconds - 3600000).toISOString(),
                    elevationAngle: header.elevation_angle,
                    elevationNumber: header.elevation_number,
                    elevations,
                    station: options?.station || null,
                    vcp: getLevel2Vcp(radar, header),
                },
                timing: { parserStartMs, parserEndMs, meshEndMs },
            }, [meshData.buffer]);
        }
    } catch (error) {
        self.postMessage({ type: 'error', message: error?.message || String(error) });
    }
};
