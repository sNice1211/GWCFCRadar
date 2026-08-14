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
 'sev-playbar-fill','sev-playbar-thumb','sev-model-sel','sev-pi-group'].forEach(id => els[id] = mkEl(id));
// The <select> reports the options its optgroup holds, the way a real one does.
els['sev-model-sel'].options = els['sev-pi-group'].children;

global.localStorage = { _d:{}, getItem(k){return this._d[k]??null;}, setItem(k,v){this._d[k]=v;}, removeItem(k){delete this._d[k];} };

// Leaflet + map
const added = [];
global.L = { imageOverlay(url, bounds, opts) {
  return { url, bounds, opts, _h:{}, on(ev,fn){this._h[ev]=fn;}, addTo(m){ added.push(this); return this; } };
}};
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
const INDEX = () => ({ models: {
  gfs:  { label:'GFS', res:'0.25 deg', run: RUN, path:'gfs/'+RUN+'/manifest.json' },
  hrrr: { label:'HRRR', res:'3 km',    run: RUN, path:'hrrr/'+RUN+'/manifest.json' },
  nbm:  { label:'NBM', res:'2.5 km blend', run: RUN, path:'nbm/'+RUN+'/manifest.json' },
  rtma: { label:'RTMA (now)', res:'2.5 km analysis', run: RUN, path:'rtma/'+RUN+'/manifest.json' },
}});
const MANIFESTS = () => ({
  gfs: { model:'gfs', label:'GFS', res:'0.25 deg', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,3,6,9,12],min:-40,max:45},
                   apcp:{hours:[3,6,9,12],min:0,max:50},
                   mslp:{hours:[0,3,6,9,12],min:960,max:1050} } },
  hrrr:{ model:'hrrr', label:'HRRR', res:'3 km', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,1,2,3],min:-40,max:45},
                   refc:{hours:[0,1,2,3],min:-10,max:75} } },
  nbm: { model:'nbm', label:'NBM', res:'2.5 km blend', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,3,6],min:-40,max:45},
                   wind:{hours:[0,3,6],min:0,max:80} } },
  rtma:{ model:'rtma', label:'RTMA (now)', res:'2.5 km analysis', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0],min:-40,max:45} } },
});
let fetchLog = [];
global.fetch = async (url) => {
  fetchLog.push(url);
  if (url.includes('firestore')) return { ok:true, json: async () => ({ fields:{ url:{ stringValue:'https://pi.test' } } }) };
  if (url.endsWith('latest.json')) return { ok:true, json: async () => INDEX() };
  const m = url.match(/models\/(\w+)\/[\d_]+\/manifest\.json/);
  if (m) { const man = MANIFESTS()[m[1]]; return man ? { ok:true, json: async()=>man } : { ok:false }; }
  return { ok:false };
};

// ── Checks ─────────────────────────────────────────────────────────────────

// The checks live next door rather than in here, because they have to run in
// the same scope as the block that was just lifted out of the page: the whole
// point is that they see the real variables, not a copy. Concatenating and
// evaluating the two together is what puts them in that scope.
const checks = fs.readFileSync(path.join(__dirname, 'model-checks.js'), 'utf8');
eval(block + '\n' + checks);
