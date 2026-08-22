import { Buffer } from 'buffer';
import { Level2Radar } from './level2/src/index.js';
import nexradLevel3Data from './level3/src/browser.js';
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
        // Level-II parser exposes differential phase (phi); KDP is derived during rendering.
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
    // sin/cos of angular distance depend only on range, not azimuth.
    // Cache them so each unique distance is computed once across all radials.
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

// ── How far out to draw, and at what detail ───────────────────────────────
//
// A NEXRAD reflectivity sweep reaches 460 km. At super-resolution it is
// sampled every 250 m, so that is 1832 cells on each of 720 radials: 1.3
// million polygons for one picture, which no phone is going to hold.
//
// The cap used to be a flat count of 460 GATES, which is a completely
// different distance depending on how wide a gate is. On the legacy 1 km
// gates it meant 460 km, the whole sweep. On the 250 m super-resolution
// gates that every modern VCP uses at the lowest tilt, it meant 115 km - a
// quarter of what the radar measured, and the reason this looked short next
// to every other radar app.
//
// So the cap is a DISTANCE now, set to the full reach of the product, and
// the thing that keeps the polygon count down is detail thinning with range
// instead. That is not a compromise made to save memory, it is what the beam
// already does: about one degree wide, it is 2 km across at 115 km and 4 km
// at 230 km, so 250 m radial cells out there are finer than anything the
// radar can resolve. Merging them loses nothing that was ever there.
//
// Full detail is kept inside RANGE_FULL_DETAIL_KM, which covers every storm
// anyone interrogates closely, and beyond that the cells lengthen in steps.
const RANGE_FULL_DETAIL_KM = 100;
const RANGE_STEP_KM = 100;      // every further step of this doubles the cell
const RANGE_MAX_STRIDE = 8;     // never coarser than this, however far out

// How many gates to merge into one cell at this range.
//
// Range is in kilometres and gateSizeKm is how long one gate is. A gate that
// is already a kilometre long is not thinned at all: it is coarser than the
// beam is wide out to 57 km, and past that the sweep is short enough to draw
// whole anyway.
const strideForRange = (rangeKm, gateSizeKm, full) => {
    if (full) return 1;
    if (!(gateSizeKm > 0) || gateSizeKm >= 0.9) return 1;
    if (rangeKm <= RANGE_FULL_DETAIL_KM) return 1;
    // Doubling rather than counting up: 100 to 200 km merges two gates, 200
    // to 300 merges four, 300 to 400 merges eight. Counting up gave 460 km of
    // sweep about a thousand cells on every radial, and drawing a million of
    // anything is where a browser stops being a browser. Doubling gives about
    // six hundred, and it matches what the beam is doing anyway: the beam
    // widens in proportion to range, so the cell should too.
    const steps = Math.floor((rangeKm - RANGE_FULL_DETAIL_KM) / RANGE_STEP_KM) + 1;
    const stride = Math.pow(2, steps);
    // Never merge past the point where a cell is longer than the beam is
    // wide: that would be visible as blockiness rather than as fidelity
    // nobody could see anyway.
    const beamKm = rangeKm / 57;
    const byBeam = Math.max(1, Math.floor(beamKm / gateSizeKm));
    return Math.max(1, Math.min(RANGE_MAX_STRIDE, stride, byBeam));
};

// What the caller asked for, resolved once per scan.
//
// `range_limit_km` is the real control. `gate_limit` is still honoured
// because it is what the page used to send, but it is now a ceiling on the
// gate index rather than the only limit, so an old caller cannot silently
// shorten the range back to a quarter of the sweep.
const readRangeOptions = (options) => ({
    limitKm: Number.isFinite(options.range_limit_km) && options.range_limit_km > 0
        ? options.range_limit_km : null,
    gateCap: Number.isFinite(options.gate_limit) && options.gate_limit > 0
        ? options.gate_limit : null,
    full: options.full_detail === true,
});

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
                geometry: {
                    type: 'Polygon',
                    coordinates: [closed]
                }
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
    // GWCFC fix, carried into the SparkRadar source: the tilt-up hunt below
    // was written for velocity alone, but spectrum width lives on the same
    // Doppler cut velocity does, one sweep above the surveillance cut, so
    // asking for SW at the lowest tilt failed on virtually every scan while
    // the data sat a sweep away. Every moment walks now.
    const momentGetters = {
        REF: () => radar.getHighresReflectivity(),
        VEL: () => radar.getHighresVelocity(),
        CC:  () => radar.getHighresCorrelationCoefficient(),
        KDP: () => radar.getHighresDiffPhase(),
        SW:  () => radar.getHighresSpectrum(),
        ZDR: () => radar.getHighresDiffReflectivity(),
    };
    const momentEmpty = (d) => !Array.isArray(d) || d.length === 0
        || d.every((item) => item === undefined);
    let radarData;
    if (momentGetters[layer]) {
        radarData = momentGetters[layer]();
        // Tilt up until we find the moment
        if (momentEmpty(radarData)) {
            const elevationLevels = radar.listElevations().sort((a, b) => a - b);
            let currentIndex = elevationLevels.indexOf(radar.elevation);
            while (currentIndex + 1 < elevationLevels.length) {
                currentIndex += 1;
                radar.setElevation(elevationLevels[currentIndex]);
                radarData = momentGetters[layer]();
                if (!momentEmpty(radarData)) {
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

    if (!Array.isArray(radarData) || radarData.length === 0) {
        throw new Error(`No radar data available for layer: ${layer}`);
    }

    const numberOfRadarIterations = radarData.length;
    const range = readRangeOptions(options);
    const project = createRadarProjector(radarLocation[0], radarLocation[1]);
    const includeGeojson = options.includeGeojson === true;
    const builder = createMeshBuilder(includeGeojson);
    const scanIsPartial = Boolean(radar?.hasGaps || radar?.isTruncated);
    const headers = radar.getHeader();

    const shouldDealiasLevel2Velocity = layer === 'VEL' && options?.enableVelocityDealias !== false;

    if (shouldDealiasLevel2Velocity) {
        try {
            console.log('Applying velocity dealiasing to Level-II velocity data...');
            const beforeRows = radarData.map((radial) => {
                if (!radial || !Array.isArray(radial.moment_data)) return null;
                return radial.moment_data.slice();
            });
            const dealiasDebug = {};
            const firstNyquist = Number(headers?.[0]?.radial?.nyquist_velocity);
            radarData = dealiasVelocityRadials(radarData, {
                nyquistVelocity: Number.isFinite(firstNyquist) && firstNyquist > 0 ? firstNyquist : undefined,
				headers,
                debugStats: dealiasDebug
            });

            let finiteBefore = 0;
            let changedGates = 0;
            let maxAbsDelta = 0;
            for (let i = 0; i < radarData.length; i++) {
                const radial = radarData[i];
                const before = beforeRows[i];
                if (!radial || !Array.isArray(radial.moment_data) || !Array.isArray(before)) {
                    continue;
                }
                const gateCount = Math.min(before.length, radial.moment_data.length);
                for (let g = 0; g < gateCount; g++) {
                    const oldVal = before[g];
                    const newVal = radial.moment_data[g];
                    if (!Number.isFinite(oldVal) || !Number.isFinite(newVal)) {
                        continue;
                    }
                    finiteBefore += 1;
                    const delta = newVal - oldVal;
                    if (delta !== 0) {
                        changedGates += 1;
                        const absDelta = Math.abs(delta);
                        if (absDelta > maxAbsDelta) {
                            maxAbsDelta = absDelta;
                        }
                    }
                }
            }

            console.log(
                `[dealias] L2 VEL changed ${changedGates}/${finiteBefore} finite gates; max |delta|=${maxAbsDelta.toFixed(3)} m/s`
            );
            console.log(
                `[dealias] rotation protection marked ${dealiasDebug.rotationProtectedGateCount || 0} gates; expanded mask covers ${dealiasDebug.rotationProtectedExpandedGateCount || 0} gates`
            );
            console.log(
                `[dealias] local rotation-zone unwrap adjusted ${dealiasDebug.rotationLocalAdjustedGateCount || 0} gates`
            );
            console.log(
                `[dealias] local rotation-zone double-wrap candidates ${dealiasDebug.rotationLocalDoubleWrapCandidateCount || 0}`
            );
            console.log(
                `[dealias] local rotation-zone solved ${dealiasDebug.rotationLocalSolvedSegmentCount || 0} segments across ${dealiasDebug.rotationLocalSolvedRayCount || 0} radials`
            );
            console.log('Velocity dealiasing completed successfully.');
        } catch (error) {
            console.error('Velocity dealiasing failed for Level-II velocity data:', error);
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
        if (!current || !Number.isFinite(current.azimuth)) {
            return null;
        }

        const az1 = current.azimuth;
        const prev = index > 0 ? headers[index - 1] : null;
        const next = index + 1 < numberOfRadarIterations ? headers[index + 1] : null;
        const prevDelta = prev && Number.isFinite(prev.azimuth)
            ? forwardDelta(prev.azimuth, az1)
            : null;

        let delta;
        if (next && Number.isFinite(next.azimuth)) {
            const nextDelta = forwardDelta(az1, next.azimuth);
            // For interior radials, use the true next-edge delta so adjacent wedges touch.
            delta = nextDelta;
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
        if (!Array.isArray(momentData) || !Number.isFinite(gateSizeKm) || gateSizeKm <= 0) {
            return null;
        }

        // Use a wider adaptive baseline for dPhi/dr to reduce gate-to-gate noise.
        let leftIndex = null;
        let rightIndex = null;
        for (let step = 1; step <= 3; step++) {
            const li = gateIndex - step;
            const ri = gateIndex + step;
            if (leftIndex == null && li >= 0 && Number.isFinite(momentData[li])) {
                leftIndex = li;
            }
            if (rightIndex == null && ri < momentData.length && Number.isFinite(momentData[ri])) {
                rightIndex = ri;
            }
            if (leftIndex != null && rightIndex != null) break;
        }

        let kdp = null;
        if (leftIndex != null && rightIndex != null && rightIndex > leftIndex) {
            const dPhi = normalizePhiDelta(momentData[rightIndex] - momentData[leftIndex]);
            if (Number.isFinite(dPhi)) {
                const dR = (rightIndex - leftIndex) * gateSizeKm;
                // KDP = 0.5 * dPhi/dr
                kdp = 0.5 * (dPhi / dR);
            }
        }

        // One-sided fallback.
        if (!Number.isFinite(kdp)) {
            const curr = momentData[gateIndex];
            if (Number.isFinite(curr) && rightIndex != null && rightIndex > gateIndex) {
                const dPhi = normalizePhiDelta(momentData[rightIndex] - curr);
                if (Number.isFinite(dPhi)) {
                    const dR = (rightIndex - gateIndex) * gateSizeKm;
                    kdp = 0.5 * (dPhi / dR);
                }
            } else if (Number.isFinite(curr) && leftIndex != null && gateIndex > leftIndex) {
                const dPhi = normalizePhiDelta(curr - momentData[leftIndex]);
                if (Number.isFinite(dPhi)) {
                    const dR = (gateIndex - leftIndex) * gateSizeKm;
                    kdp = 0.5 * (dPhi / dR);
                }
            }
        }

        if (!Number.isFinite(kdp)) return null;

        // Match display expectations for this product family: suppress negative artifacts.
        if (kdp < 0) kdp = 0;
        if (kdp > 20) kdp = 20;
        return kdp;
    };

    for (let index = 0; index < numberOfRadarIterations; index++) {
        const radial = radarData[index];
        if (!radial || typeof radial !== 'object' || !radial.moment_data || typeof radial.gate_count !== 'number') {
            continue;
        }

        const azPair = getAzimuthPair(index);
        if (!azPair) {
            continue;
        }
        const { az1, az2 } = azPair;
        const az1Rad = az1 * DEG_TO_RAD;
        const az2Rad = az2 * DEG_TO_RAD;
        const sinAz1 = Math.sin(az1Rad);
        const cosAz1 = Math.cos(az1Rad);
        const sinAz2 = Math.sin(az2Rad);
        const cosAz2 = Math.cos(az2Rad);

        const firstGate = radial.first_gate;
        const gateSize = radial.gate_size;
        const lastGate = radial.gate_count - 1;

        // Where the sweep is allowed to stop. With nothing asked for, that is
        // wherever the radar stopped measuring, which is the whole point of
        // this change: the full 460 km rather than a quarter of it.
        let capIndex = lastGate;
        if (range.limitKm !== null && gateSize > 0) {
            capIndex = Math.min(capIndex,
                Math.ceil((range.limitKm - firstGate) / gateSize));
        }
        if (range.gateCap !== null) capIndex = Math.min(capIndex, range.gateCap);
        if (capIndex < 1) continue;

        for (let gateIndex = 0; gateIndex < capIndex; ) {
            const rangeKm = firstGate + gateIndex * gateSize;
            const stride = Math.max(1, Math.min(
                strideForRange(rangeKm, gateSize, range.full),
                capIndex - gateIndex));

            // One value for the merged cell, and which one is not a detail.
            //
            // On correlation coefficient it has to be the MINIMUM: a debris
            // ball under a tornado is a hole of LOW CC, and a merge that took
            // the maximum would erase exactly the signature a warning gets
            // written from. On velocity it is the largest magnitude either
            // way, so an inbound-outbound couplet survives instead of the two
            // halves cancelling. Everywhere else the maximum is right, since
            // a core is what a merged cell should still show.
            //
            // GWCFC: correlation coefficient merges by MEAN, not by minimum.
            //
            // For reflectivity and velocity the extreme IS the signal: a core
            // and a couplet are what a merged cell must not lose, so max and
            // max-magnitude are right. Correlation coefficient is the other
            // way round. Low CC is mostly NOISE - a single poorly lit gate at
            // low signal to noise reads low - and it is only occasionally the
            // rare thing worth seeing. Taking the minimum of a merged cell
            // therefore hands the whole cell to its worst gate.
            //
            // That is not a small bias. Stride is 1 inside 100 km and doubles
            // every 100 km after, so past 300 km eight gates collapse into one
            // and uniform 0.98 rain reported whichever of those eight happened
            // to be lowest. The far half of every sweep came out looking like
            // mixed or non-meteorological echo, and the closer the colour
            // scale got to being useful at the top end the more obvious it was.
            //
            // Nothing is lost by averaging. Debris balls sit close to the
            // radar - that is where a tornado is observable at all - and
            // inside 100 km the stride is 1, so there is no merge happening
            // there in the first place. The minimum rule only ever applied
            // where it was not needed, and only ever did harm.
            let value = null;
            let ccSum = 0, ccCount = 0;
            for (let k = 0; k < stride; k++) {
                const rawValue = radial.moment_data[gateIndex + k];
                if (rawValue === null || rawValue === undefined) continue;
                let v = rawValue;
                if (layer === 'KDP' && v !== 'rf') {
                    v = computeKdpFromPhi(radial.moment_data, gateIndex + k, gateSize);
                }
                if (v == null) continue;
                if (layer === 'CC') {
                    if (v === 'rf') continue;
                    ccSum += v; ccCount += 1;
                    value = ccSum / ccCount;
                    continue;
                }
                if (value == null || value === 'rf') { value = v; continue; }
                if (v === 'rf') continue;
                if (layer === 'VEL') value = Math.abs(v) > Math.abs(value) ? v : value;
                else value = Math.max(value, v);
            }

            if (value == null) { gateIndex += stride; continue; }

            if (layer === 'VEL' && value !== 'rf' && Number.isFinite(value)) {
                // Convert m/s to knots to match palette units
                value *= 1.94384;
            }

            const r1 = rangeKm * 1000;
            const r2 = (firstGate + (gateIndex + stride) * gateSize) * 1000;
            const coords = buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2);
            builder.pushQuad(coords, value);
            gateIndex += stride;
        }
    }

    return builder.finalize();
};

// Storm relative velocity ships four bits per bin, which is a code into this
// table rather than a speed. Index 0 means no data and 15 means range folded.
const SRV_LEVELS = [null, -64, -50, -36, -26, -20, -10, -1, 0,
                    10, 20, 26, 36, 50, 64];

const processLevel3Data = (radar, radarLocation, options = {}) => {
    const radialPackets = Array.isArray(radar.radialPackets) ? radar.radialPackets : [];
    const packet = radialPackets.find((entry) => entry && Array.isArray(entry.radials));
    if (!packet) {
        throw new Error('No radial packet data found in Level 3 product.');
    }

    const rangeScaleKm = packet.rangeScale ?? 1;
    const firstBin = packet.firstBin ?? 0;
    const numberBins = packet.numberBins ?? 0;
    const radials = packet.radials || [];
    const range = readRangeOptions(options);

    // The product code, not a name the page passed in, because the file says
    // what it is and the page only says what it asked for.
    const code = radar.productDescription?.code;
    // How long one bin is, in metres. Most products count in 250 m steps;
    // storm relative velocity and the digital accumulations count in whole
    // kilometres. This never changed inside the loop, so it does not belong
    // there.
    const scaleFactor = (code === 56 || code === 170 || code === 172) ? 1000 : 250;
    const binKm = (rangeScaleKm * scaleFactor) / 1000;
    const isVelocity = code === 25 || code === 27 || code === 55
                       || code === 56 || code === 99;
    const isCorrelation = code === 161;

    // One bin's raw code turned into the number the palette reads.
    const decodeBin = (raw) => {
        if (raw == null) return null;
        if (code === 56) {
            if (raw === 15) return 'rf';
            const level = SRV_LEVELS[raw];
            return level === undefined ? raw : level;
        }
        if ((code === 170 || code === 172) && raw === 'rf') return 0;
        return raw;
    };

    const numberOfRadarIterations = radials.length;
    const project = createRadarProjector(radarLocation[0], radarLocation[1]);
    const includeGeojson = options.includeGeojson === true;
    const builder = createMeshBuilder(includeGeojson);

    for (let index = 0; index < numberOfRadarIterations; index++) {
        const radial = radials[index];
        if (!radial || typeof radial !== 'object') {
            continue;
        }

        const az1 = radial.startAngle;
        const az2 = radial.startAngle + radial.angleDelta;
        const az1Rad = az1 * DEG_TO_RAD;
        const az2Rad = az2 * DEG_TO_RAD;
        const sinAz1 = Math.sin(az1Rad);
        const cosAz1 = Math.cos(az1Rad);
        const sinAz2 = Math.sin(az2Rad);
        const cosAz2 = Math.cos(az2Rad);
        const bins = radial.bins || [];

        const binCount = Math.min(bins.length, numberBins);
        // How far out this radial is drawn. With nothing asked for, all of it:
        // a long-range base reflectivity product carries 460 km and used to be
        // cut to 115 by a cap counted in bins rather than in kilometres.
        let cap = binCount;
        if (range.limitKm !== null && rangeScaleKm > 0) {
            cap = Math.min(cap, Math.ceil(
                ((range.limitKm * 1000) / scaleFactor - firstBin) / rangeScaleKm));
        }
        if (range.gateCap !== null) cap = Math.min(cap, range.gateCap);
        if (cap < 1) continue;

        for (let binIndex = 0; binIndex < cap; ) {
            const rangeKm = ((firstBin + binIndex * rangeScaleKm) * scaleFactor) / 1000;
            const stride = Math.max(1, Math.min(
                strideForRange(rangeKm, binKm, range.full), cap - binIndex));

            // Same rule as Level 2, including the correction: correlation
            // coefficient merges by MEAN. Low CC is mostly noise rather than
            // the rare thing worth seeing, so handing a merged cell to its
            // worst gate dragged the whole far field down. See the long note
            // on the Level 2 path above.
            let value = null;
            let ccSum = 0, ccCount = 0;
            for (let k = 0; k < stride; k++) {
                const v = decodeBin(bins[binIndex + k]);
                if (v == null) continue;
                if (isCorrelation) {
                    if (v === 'rf') continue;
                    ccSum += v; ccCount += 1;
                    value = ccSum / ccCount;
                    continue;
                }
                if (value == null || value === 'rf') { value = v; continue; }
                if (v === 'rf') continue;
                if (isVelocity) value = Math.abs(v) > Math.abs(value) ? v : value;
                else value = Math.max(value, v);
            }

            if (value == null) { binIndex += stride; continue; }

            const r1 = (firstBin + (binIndex * rangeScaleKm)) * scaleFactor;
            const r2 = (firstBin + ((binIndex + stride) * rangeScaleKm)) * scaleFactor;

            const coords = buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2);
            builder.pushQuad(coords, value);
            binIndex += stride;
        }
    }

    return builder.finalize();
};

const getLevel3Metadata = (radar) => {
    const productDescription = radar?.productDescription;
    if (!productDescription) return { timeIso: null, elevationAngle: null, vcp: null };

    const dateValue = Number(productDescription.volumeScanDate ?? productDescription.productDate);
    const timeValue = Number(productDescription.volumeScanTime ?? productDescription.productTime);
    let timeIso = null;
    if (Number.isFinite(dateValue) && Number.isFinite(timeValue)) {
        const epochMs = (dateValue * 86400 + timeValue) * 1000;
        timeIso = new Date(epochMs).toISOString();
    }

    const elevationAngle = Number.isFinite(productDescription.elevationAngle)
        ? productDescription.elevationAngle
        : null;

    const vcp = Number.isFinite(productDescription.vcp)
        ? productDescription.vcp
        : null;

    return { timeIso, elevationAngle, vcp };
};

const toEpochMs = (monotonicMs) => performance.timeOrigin + monotonicMs;

self.onmessage = (event) => {
    const { type } = event.data || {};

    // --- Chunk-combine path (Level-II streaming) ---
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
            const extent = recordHeader.radial_length;

            const { meshData, bounds, geojson } = processRadarData(radar, radarLocation, extent, chunkLayer, chunkOptions);
            const meshEndMs = toEpochMs(performance.now());

            const metadata = {
                station: chunkOptions.station || null,
                product: chunkLayer,
                timeIso: null,
                elevationAngle: recordHeader.elevation_angle,
                vcp: getLevel2Vcp(radar, recordHeader),
            };

            self.postMessage({
                type: 'result',
                geojson,
                meshData,
                bounds,
                metadata,
                timing: { parserStartMs, parserEndMs, meshEndMs },
            }, [meshData.buffer]);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
        return;
    }

    // --- Single-file path (archive / local upload / Level-III) ---
    const { arrayBuffer, layer, options } = event.data || {};
    if (type !== 'process' || !arrayBuffer) {
        return;
    }

    try {
        const parserStartMs = toEpochMs(performance.now());
        let parserEndMs = null;
        let meshEndMs = null;
        const upperLayer = typeof layer === 'string' ? layer.toUpperCase() : '';
        // Include ZDR as a Level-II (super-res) product so ZDR archive files are
        // parsed with the Level2 parser instead of being misclassified as Level3.
        const isLevel2Product = upperLayer === 'REF' || upperLayer === 'VEL' || upperLayer === 'CC' || upperLayer === 'KDP' || upperLayer === 'SW' || upperLayer === 'ZDR';
        const isLevel3 = !isLevel2Product;
        const buffer = Buffer.from(arrayBuffer);

        if (isLevel3) {
            const requestedParseMode = typeof options?.level3ParseMode === 'string'
                ? options.level3ParseMode.toLowerCase()
                : null;
            const level3ParseMode = requestedParseMode === 'full' ? 'full' : LEVEL3_PARSE_MODE;
            const radar = nexradLevel3Data(
                buffer,
                level3ParseMode === 'fast'
                    ? {
                        logger: false,
                        parseGraphic: false,
                        parseTabular: false,
                        parseFormatted: false,
                        includeRawBinData: false,
                        includePacketMetadata: false,
                        parseFirstRadialPacketOnly: true,
                        minimalOutput: true
                    }
                    : {
                        logger: false
                    }
            );
            parserEndMs = toEpochMs(performance.now());
            const radarLat = radar.productDescription?.latitude;
            const radarLon = radar.productDescription?.longitude;
            if (radarLat == null || radarLon == null) {
                throw new Error('Missing radar location in Level 3 product description.');
            }
            const radarLocation = [radarLat, radarLon];
            const { meshData, bounds, geojson } = processLevel3Data(radar, radarLocation, options);
            meshEndMs = toEpochMs(performance.now());
            const { timeIso, elevationAngle, vcp } = getLevel3Metadata(radar);
            const metadata = {
                station: options?.station || null,
                product: layer,
                timeIso,
                elevationAngle,
                vcp
            };

            self.postMessage({
                type: 'result',
                geojson,
                meshData,
                bounds,
                metadata,
                timing: {
                    parserStartMs,
                    parserEndMs,
                    meshEndMs
                }
            }, [meshData.buffer]);
        } else {
            const requestedMoment = getLevel2MomentForLayer(layer);
            const radar = new Level2Radar(buffer, {
                logger: false,
                includeMoments: requestedMoment ? [requestedMoment] : undefined
            });
            parserEndMs = toEpochMs(performance.now());

            const elevations = radar.listElevations();
            if (options?.elevation && elevations.includes(options.elevation)) {
                radar.setElevation(options.elevation);
            } else {
                radar.setElevation(elevations[0] || 1);
            }

            const header = radar.getHeader(0);
            const radarLocation = [header.volume.latitude, header.volume.longitude];
            const extent = header.radial_length;

            const { meshData, bounds, geojson } = processRadarData(radar, radarLocation, extent, layer, options);
            meshEndMs = toEpochMs(performance.now());
            const metadata = {
                timeIso: new Date((header.julian_date * 86400 * 1000) + header.mseconds - 3600000).toISOString(),
                elevationAngle: header.elevation_angle,
                station: options?.station || null,
                vcp: getLevel2Vcp(radar, header),
                // GWCFC: the page builds its tilt picker from what this volume
                // actually carries, so the list rides back with the result.
                availableElevations: elevations,
                elevationNumber: radar.elevation
            };

            self.postMessage({
                type: 'result',
                geojson,
                meshData,
                bounds,
                metadata,
                timing: {
                    parserStartMs,
                    parserEndMs,
                    meshEndMs
                }
            }, [meshData.buffer]);
        }
    } catch (error) {
        self.postMessage({ type: 'error', message: error?.message || String(error) });
    }
};