/**
 * nomads_gfs.js
 * -------------------------------------------------------------------
 * Overlay NOAA NOMADS GFS (Global Forecast System) model output on a
 * Leaflet map using their public WMS (Web Map Service) endpoint.
 *
 * WMS = Web Map Service. It's a standard protocol where you send a
 * request like "give me an image of temperature over this area" and
 * the server sends back a PNG you can lay over the map.
 *
 * USAGE (after including this file and Leaflet):
 *
 *   const gfs = new NomadsGFS(map);
 *   gfs.showLayer('TMP_TGL_2');    // 2m temperature
 *   gfs.setForecastHour(24);        // jump to +24h forecast
 *   gfs.hide();                      // remove from map
 *
 * NOMADS WMS endpoint:
 *   https://nomads.ncep.noaa.gov/cgi-bin/wms_gfs.php
 *
 * IMPORTANT CORS NOTE:
 *   NOMADS does NOT set Access-Control-Allow-Origin headers, so direct
 *   browser fetch() calls are blocked. However, Leaflet's tileLayer.wms
 *   uses <img> tags (not fetch), so it bypasses CORS - tiles load fine.
 *   Only use fetch() for metadata; use a CORS proxy if you need to.
 * -------------------------------------------------------------------
 */

(function (window) {
  'use strict';

  // ── Run calculation ──────────────────────────────────────────────────────
  // GFS runs 4 times a day: 00z, 06z, 12z, 18z UTC.
  // Data takes about 3.5 hours to process and appear on NOMADS.
  // So at 10:00z, the latest *available* run is 06z (not 12z yet).
  function latestGFSRun() {
    const now  = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const ymd  = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

    const LAG_HOURS = 3.5;  // how long after a run before its data is live
    const RUN_HOURS = [0, 6, 12, 18];
    const nowH      = now.getUTCHours() + now.getUTCMinutes() / 60;

    for (let i = RUN_HOURS.length - 1; i >= 0; i--) {
      if (nowH - LAG_HOURS >= RUN_HOURS[i]) {
        return { date: ymd(now), hour: pad(RUN_HOURS[i]) };
      }
    }

    // Before today's 00z + lag: use yesterday's 18z run
    const prev = new Date(now);
    prev.setUTCDate(prev.getUTCDate() - 1);
    return { date: ymd(prev), hour: '18' };
  }

  // Build a JavaScript Date from a run { date: 'YYYYMMDD', hour: 'HH' }
  function runToDate(run) {
    return new Date(Date.UTC(
      parseInt(run.date.slice(0, 4)),
      parseInt(run.date.slice(4, 6)) - 1,
      parseInt(run.date.slice(6, 8)),
      parseInt(run.hour)
    ));
  }

  // ── Layer catalogue ──────────────────────────────────────────────────────
  // Layer names follow GRIB2 naming: PARAM_LEVELTYPE_LEVELVALUE
  //   TGL  = height above ground (metres)
  //   SFC  = surface
  //   MSL  = mean sea level
  //   EATM = entire atmosphere (column total)
  //   NNN  = pressure level in mb (e.g. 500 = 500mb)
  //
  // opacity: how see-through the overlay is (0 = invisible, 1 = solid).
  // Kept around 0.6–0.75 so the base map shows through.

  const GFS_LAYERS = {
    // ── Surface / near-surface ─────────────────────────────────────────────
    TMP_TGL_2:   { label: '2m Temperature',        unit: '°C',    opacity: 0.65 },
    DPT_TGL_2:   { label: '2m Dew Point',           unit: '°C',    opacity: 0.65 },
    RH_TGL_2:    { label: '2m Relative Humidity',   unit: '%',     opacity: 0.65 },
    WIND_TGL_10: { label: '10m Wind Speed',          unit: 'm/s',   opacity: 0.70 },
    GUST_SFC_0:  { label: 'Surface Wind Gust',       unit: 'm/s',   opacity: 0.70 },
    PRMSL_MSL_0: { label: 'MSL Pressure',            unit: 'hPa',   opacity: 0.55 },

    // ── Precipitation / moisture ───────────────────────────────────────────
    APCP_SFC_0:  { label: 'Total Precipitation',     unit: 'mm',    opacity: 0.70 },
    PWAT_EATM_0: { label: 'Precipitable Water',       unit: 'kg/m²', opacity: 0.65 },
    TCDC_EATM_0: { label: 'Total Cloud Cover',         unit: '%',     opacity: 0.55 },

    // ── Severe weather ─────────────────────────────────────────────────────
    CAPE_SFC_0:  { label: 'Surface CAPE',             unit: 'J/kg',  opacity: 0.70 },
    CIN_SFC_0:   { label: 'Surface CIN',              unit: 'J/kg',  opacity: 0.65 },

    // ── Upper air ──────────────────────────────────────────────────────────
    HGT_500_0:   { label: '500mb Height',             unit: 'dm',    opacity: 0.60 },
    TMP_850_0:   { label: '850mb Temperature',         unit: '°C',    opacity: 0.60 },
    UGRD_250_0:  { label: '250mb U-Wind',              unit: 'm/s',   opacity: 0.60 },
    VGRD_250_0:  { label: '250mb V-Wind',              unit: 'm/s',   opacity: 0.60 },
  };

  // ── NomadsGFS class ──────────────────────────────────────────────────────
  class NomadsGFS {
    /**
     * @param {L.Map} map - The Leaflet map instance to add layers to.
     */
    constructor(map) {
      this._map          = map;
      this._layer        = null;   // the active Leaflet WMS layer
      this._activeVar    = null;   // current layer name e.g. 'TMP_TGL_2'
      this._run          = latestGFSRun();  // auto-detect latest run
      this._forecastHour = 0;              // 0 = analysis; max 384h
    }

    // ── Public API ─────────────────────────────────────────────────────────

    /**
     * Display a GFS variable on the map.
     * Call with no argument (or null) to hide the current layer.
     * @param {string|null} varName - A key from GFS_LAYERS, e.g. 'TMP_TGL_2'
     */
    showLayer(varName) {
      this._removeLayer();
      if (!varName) return;

      const meta = GFS_LAYERS[varName];
      if (!meta) {
        console.warn('[NomadsGFS] Unknown layer:', varName, '- valid keys:', Object.keys(GFS_LAYERS));
        return;
      }

      this._activeVar = varName;
      this._layer     = this._buildWMSLayer(varName, meta);
      this._layer.addTo(this._map);
    }

    /**
     * Change which forecast hour is displayed.
     * GFS goes from 0 (analysis) to 384 hours in 1h or 3h steps.
     * The layer will reload automatically.
     * @param {number} hours - Forecast hour offset (0–384)
     */
    setForecastHour(hours) {
      this._forecastHour = Math.max(0, Math.min(384, hours));
      if (this._activeVar) this.showLayer(this._activeVar);
    }

    /**
     * Override the model run instead of using the auto-detected latest.
     * @param {string} yyyymmdd - e.g. '20241201'
     * @param {string} hh       - '00', '06', '12', or '18'
     */
    setRun(yyyymmdd, hh) {
      this._run = { date: yyyymmdd, hour: hh };
      if (this._activeVar) this.showLayer(this._activeVar);
    }

    /** Re-detect the latest available run and reload. */
    refreshRun() {
      this._run = latestGFSRun();
      if (this._activeVar) this.showLayer(this._activeVar);
    }

    /** Remove the GFS overlay from the map. */
    hide() {
      this._removeLayer();
      this._activeVar = null;
    }

    /** Returns the current run info: { date, hour } */
    getCurrentRun() { return { ...this._run }; }

    /**
     * Returns the valid time for the currently displayed forecast hour.
     * e.g. run=12z + forecastHour=24 → valid time is next day 12z
     */
    getValidTime() {
      const init = runToDate(this._run);
      return new Date(init.getTime() + this._forecastHour * 3600 * 1000);
    }

    /** Returns a copy of the full layer catalogue. */
    getLayers() { return { ...GFS_LAYERS }; }

    // ── Internal ──────────────────────────────────────────────────────────

    _buildWMSLayer(varName, meta) {
      // NOMADS WMS 'dir' param: tells the server which model run to use.
      // Format: /gfs.YYYYMMDD/HH/atmos
      const dir = `/gfs.${this._run.date}/${this._run.hour}/atmos`;

      // TIME param: ISO 8601 valid time.  NOMADS uses this to pick the
      // right forecast hour within the run.
      const validTime = this.getValidTime();
      const timeStr   = validTime.toISOString().slice(0, 19) + 'Z'; // e.g. 2024-12-01T06:00:00Z

      // L.tileLayer.wms works just like a normal tile layer but formats
      // requests as WMS GetMap calls.  Any extra properties you pass here
      // are appended to each tile request URL as query parameters - that's
      // how 'dir' and 'TIME' reach the NOMADS server.
      return L.tileLayer.wms('https://nomads.ncep.noaa.gov/cgi-bin/wms_gfs.php', {
        layers:      varName,
        dir:         dir,
        TIME:        timeStr,
        format:      'image/png',
        transparent: true,
        version:     '1.3.0',
        opacity:     meta.opacity,
        attribution: 'NOAA NOMADS / GFS',
        // 512px tiles reduce total tile count (fewer requests to NOMADS)
        tileSize:    512,
        noWrap:      true,
      });
    }

    _removeLayer() {
      if (this._layer) {
        try { this._map.removeLayer(this._layer); } catch (e) { /* already removed */ }
        this._layer = null;
      }
    }
  }

  // ── Expose to window ─────────────────────────────────────────────────────
  window.NomadsGFS    = NomadsGFS;
  window.GFS_LAYERS   = GFS_LAYERS;
  window.latestGFSRun = latestGFSRun;

}(window));
