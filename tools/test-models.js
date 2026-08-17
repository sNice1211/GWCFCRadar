#!/usr/bin/env node
/*
 * Exercises the Pi-models block in index.html without a browser.
 *
 *     node tools/test-models.js
 *
 * The block is lifted straight out of the page between two markers and run
 * against stubs: a fake DOM, a fake Leaflet, a fake map, and a fake Pi that
 * answers with an index and manifests. Nothing is copied, so the code under
 * test is the code that ships.
 *
 * This exists because every bug in this area has been the same kind: the
 * picture on the map disagreeing with the panel next to it. That is invisible
 * to a syntax check and tedious to catch by clicking, and it kept coming back.
 */

const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(
  path.join(__dirname, '..', 'index.html'), 'utf8').split('\n');
const from = page.findIndex(l => l.includes('const HD_BASE_KEY'));
const to   = page.findIndex(l => l.includes('POLYGON SPATIAL FILTER'));
if (from < 0 || to < 0) {
  console.error('Could not find the Pi-models block in index.html. If it moved, '
              + 'update the two markers at the top of this file.');
  process.exit(2);
}
const block = page.slice(from, to - 2).join('\n');

// ── Stubs ──────────────────────────────────────────────────────────────────
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const els = {};
function mkEl(id, tag) {
  const e = {
    id, tagName: tag || 'div', textContent: '', value: '',
    style: {}, dataset: {}, children: [], classList: { add(){}, remove(){}, toggle(){} },
    appendChild(c) { this.children.push(c); },
    querySelector() { return mkEl('sub'); },
    querySelectorAll() { return []; },
    scrollIntoView() {},
  };
  // Assigning innerHTML replaces the children, the way a real element does.
  // A plain property let the stub accumulate them instead, so a list that was
  // correctly rebuilt from scratch looked like a list that had grown, and the
  // test reported a bug that was only in the test.
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); e.children.length = 0; },
  });
  return e;
}
global.document = {
  getElementById: (id) => els[id] || null,
  createElement: (t) => mkEl('new', t),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild(){} },
};
['sev-var-sel','sev-run-sel','sev-frame-grid','sev-fcast-date','sev-fcast-flbl',
 'sev-playbar-fill','sev-playbar-thumb','sev-model-sel','sev-pi-group',
 'sev-region-sel','cyc-variant-sel','cyc-genesis-sel','cyc-lab-btn',
 'cyc-lab-status','cyc-focus-info'].forEach(id => els[id] = mkEl(id));
// The <select> reports the options its optgroup holds, the way a real one does.
els['sev-model-sel'].options = els['sev-pi-group'].children;

global.localStorage = { _d:{}, getItem(k){return this._d[k]??null;}, setItem(k,v){this._d[k]=v;}, removeItem(k){delete this._d[k];} };

// Leaflet + map
const added = [];
const lines = [];
global.L = {
  imageOverlay(url, bounds, opts) {
    return { url, bounds, opts, _h:{}, on(ev,fn){this._h[ev]=fn;}, addTo(m){ added.push(this); return this; } };
  },
  polyline(pts, opts) {
    return { pts, opts, options: opts,
             setStyle(s){ Object.assign(this.options, s); },
             addTo(m){ lines.push(this); added.push(this); return this; } };
  },
  // Enough marker surface for the spaghetti name tags: an element with the
  // label text, click wiring, and addTo/remove bookkeeping.
  divIcon(opts) { return { _div: opts }; },
  marker(ll, opts) {
    const el = { textContent: String((opts?.icon?._div?.html || ''))
                   .replace(/<[^>]*>/g, ''), style: {} };
    return { ll, opts, _h: {},
             on(ev, fn){ this._h[ev] = fn; return this; },
             fire(ev){ if (this._h[ev]) this._h[ev](); return this; },
             getElement(){ return el; },
             addTo(m){ added.push(this); return this; } };
  },
};
global.map = { removeLayer(l){ const i = added.indexOf(l); if(i>=0) added.splice(i,1); } };
global.showToast = () => {};

// The rest of the model panel, stubbed.
let _sevSection = 'dwd', _sevVar = 't2m', _sevRun = '', _sevFrame = 0;
let _iemModelLayer = null, _sevOverlayLayer = null, _sevCompareOn = false;
let slotsRendered = 0;
function _sevRenderAllSlots(){ slotsRendered++; }
let iemRendered = 0;
function _sevRender(){ iemRendered++; }                 // stands in for the IEM branch
function _sevSetSection(s){ _sevSection = s; }
function _sevUpdateProducts(){ els['sev-var-sel'].innerHTML = 'FIXED-LIST'; }
function _sevSetVar(v){ _sevVar = v; }
function _sevMaxFrameFor(section){ return 6; }
function _sevMaxFrame(){ return _sevMaxFrameFor(_sevSection); }
function _sevFcastDateTime(frame){ return { date:'ORIG', flbl:'F+000' }; }
function _sevUpdatePlaybar(){}
function _sevUpdateFcastHeader(){ lastHeader = _sevFcastDateTime(_sevFrame); }
let lastHeader = null;
function _sevSetFrame(v){ _sevFrame = parseInt(v); _sevUpdatePlaybar(); _sevUpdateFcastHeader(); _sevRender(); }
function toggleOverlayPill(id){}
function _soundingPanelIsOpen(){ return false; }
function closeSoundingPanel(){} function openSoundingPanel(){}

// ── the fake Pi ─────────────────────────────────────────────────────────────
let RUN = '20260814_12';
const reg = (m, r) => ({ run: RUN, path: `${m}/${r}/${RUN}/manifest.json` });
const INDEX = () => ({ models: {
  // GFS is one model over two regions now, not two models.
  gfs:  { label:'GFS', res:'0.25 deg',
          regions: { conus: reg('gfs','conus'), tropics: reg('gfs','tropics') } },
  hrrr: { label:'HRRR', res:'3 km', regions: { conus: reg('hrrr','conus') } },
  nbm:  { label:'NBM', res:'2.5 km blend', regions: { conus: reg('nbm','conus') } },
  rtma: { label:'RTMA (now)', res:'2.5 km analysis',
          regions: { conus: reg('rtma','conus') } },
  namnest: { label:'NAM Nest', res:'3 km',
             regions: { conus: reg('namnest','conus'),
                        prico: reg('namnest','prico') } },
}});
const MANIFESTS = () => ({
  'gfs/conus': { model:'gfs', label:'GFS', res:'0.25 deg', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,3,6,9,12],min:-40,max:45},
                   apcp:{hours:[3,6,9,12],min:0,max:50},
                   mslp:{hours:[0,3,6,9,12],min:960,max:1050} } },
  'hrrr/conus':{ model:'hrrr', label:'HRRR', res:'3 km', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,1,2,3],min:-40,max:45},
                   refc:{hours:[0,1,2,3],min:-10,max:75} } },
  'nbm/conus': { model:'nbm', label:'NBM', res:'2.5 km blend', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,3,6],min:-40,max:45},
                   wind:{hours:[0,3,6],min:0,max:80} } },
  'rtma/conus':{ model:'rtma', label:'RTMA (now)', res:'2.5 km analysis', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0],min:-40,max:45} } },
  // A tropical model, whose whole point is that it is somewhere else: its
  // bounds must come from its own manifest, not from the last model shown.
  'gfs/tropics':{ model:'gfs', label:'GFS', res:'0.25 deg', run: RUN,
            bounds:[[0,-165],[45,-10]],
            fields: { pwat:{hours:[0,6,12],min:0,max:80},
                      shear:{hours:[0,6,12],min:0,max:60},
                      sst:{hours:[0,6,12],min:16,max:34} } },
  'namnest/conus': { model:'namnest', label:'NAM Nest', res:'3 km', run: RUN,
            bounds:[[20,-130],[55,-60]],
            fields: { refc:{hours:[0,3],min:-10,max:75} } },
  'namnest/prico': { model:'namnest', label:'NAM Nest', res:'3 km', run: RUN,
            bounds:[[15,-71],[22,-60]],
            fields: { refc:{hours:[0,3],min:-10,max:75} } },
});
// An index written before regions existed, which is what a Pi that has not
// rebuilt yet is still serving.
const OLD_INDEX = () => ({ models: {
  gfstrop: { label:'GFS Tropical', res:'0.25 deg', run: RUN,
             path:'gfstrop/'+RUN+'/manifest.json' },
}});
let useOldIndex = false;
let usePiL3 = false;

let fetchLog = [];
global.fetch = async (url) => {
  fetchLog.push(url);
  if (url.includes('firestore')) return { ok:true, json: async () => ({ fields:{ url:{ stringValue:'https://pi.test' } } }) };
  // The page cache-busts this with a query parameter, so match the path
  // rather than the whole string.
  // models/, not just latest.json: the radar and cyclone indexes are also
  // called latest.json, and a matcher that only looked at the filename
  // answered the cyclone request with the model list.
  if (url.split('?')[0].endsWith('models/latest.json'))
    return { ok:true, json: async () => (useOldIndex ? OLD_INDEX() : INDEX()) };
  const old = url.match(/models\/gfstrop\/[\d_]+\/manifest\.json/);
  if (old) return { ok:true, json: async () => MANIFESTS()['gfs/tropics'] };
  const m = url.match(/models\/(\w+)\/(\w+)\/[\d_]+\/manifest\.json/);
  if (m) { const man = MANIFESTS()[m[1] + '/' + m[2]];
           return man ? { ok:true, json: async()=>man } : { ok:false }; }
  // A fake Pi radar: Level 2 has two frames, Level 3 is absent, so the
  // fallback and the newest-frame pick are both exercised.
  // A cyclone run, so the model picker has something to offer. Two variants,
  // each with a mean and its members, which is the shape the Pi writes.
  if (url.split('?')[0].endsWith('cyclones/latest.json'))
    return { ok:true, json: async () => ({ run:'2026_08_16T00_00',
      path:'2026_08_16T00_00/manifest.json' }) };
  if (url.split('?')[0].endsWith('2026_08_16T00_00/manifest.json'))
    return { ok:true, json: async () => ({ run:'2026_08_16T00_00',
      genesis:{
        cumulative:    { png:'cumulative.png',
                         bounds:[[0,-120],[60,-10]], unit:'%' },
        instantaneous: { png:'instantaneous.png',
                         bounds:[[0,-120],[60,-10]], unit:'%' },
      },
      tracks:{
        OPER_ensemble_mean:   { variant:'OPER',   kind:'ensemble_mean',
                                path:'tracks_OPER_ensemble_mean.json',
                                storms:1, lines:1 },
        OPER_ensemble:        { variant:'OPER',   kind:'ensemble',
                                path:'tracks_OPER_ensemble.json',
                                storms:1, lines:1 },
        FNV3P2_ensemble_mean: { variant:'FNV3P2', kind:'ensemble_mean',
                                path:'tracks_FNV3P2_ensemble_mean.json',
                                storms:1, lines:1 },
      } }) };
  if (url.includes('tracks_') && url.includes('.json'))
    return { ok:true, json: async () => ({ tracks:{
      'AL05|0':[{lat:25,lon:-71,wind:60,mslp:990,lead:0},
                {lat:26,lon:-72,wind:85,mslp:962,lead:24},
                {lat:27,lon:-73,wind:70,mslp:975,lead:48}] } }) };
  // Two sites, because radar is a single site product and drawing both at once
  // was the bug: one antenna, one picture, and the overlapping edges of two
  // stacked on each other where they met.
  if (url.split('?')[0].endsWith('radar/latest_l2.json'))
    return { ok:true, json: async () => ({ level:2, sites:{
      KTLX:{ frames:['20260815_1200','20260815_1205'],
             path:'l2/KTLX/{frame}/manifest.json' },
      KFWS:{ frames:['20260815_1201','20260815_1206'],
             path:'l2/KFWS/{frame}/manifest.json' } } }) };
  if (url.split('?')[0].endsWith('radar/latest_l3.json'))
    return usePiL3
      ? { ok:true, json: async () => ({ level:3, sites:{
          KTLX:{ frames:['20260816_0500'],
                 path:'l3/KTLX/{frame}/manifest.json' } } }) }
      : { ok:false };
  const r3 = url.split('?')[0].match(/radar\/l3\/(\w+)\/([\d_]+)\/manifest\.json/);
  if (r3) return { ok:true, json: async () => ({ site:r3[1], level:3, time:r3[2],
     bounds:[[33,-99],[37,-95]],
     // Every product the Pi builds, which is what the row offers.
     fields: Object.fromEntries(['n0q','n0u','n0c','n0x','n0k','n0h',
       'ohp','stp','dvl','eet','ncr'].map(f => [f, {min:0,max:1}])) }) };
  const rm = url.split('?')[0].match(/radar\/l2\/(\w+)\/([\d_]+)\/manifest\.json/);
  if (rm) return { ok:true, json: async () => ({ site:rm[1], level:2, time:rm[2],
     bounds:[[33,-99],[37,-95]],
     // Both moments, because the product picker is only meaningfully tested
     // against a site that actually carries more than one.
     fields:{ ref:{min:-10,max:75}, vel:{min:-40,max:40} } }) };
  return { ok:false };
};

// ── Checks ─────────────────────────────────────────────────────────────────

// The checks live next door rather than in here, because they have to run in
// the same scope as the block that was just lifted out of the page: the whole
// point is that they see the real variables, not a copy. Concatenating and
// evaluating the two together is what puts them in that scope.
const checks = fs.readFileSync(path.join(__dirname, 'model-checks.js'), 'utf8');
eval(block + '\n' + checks);
