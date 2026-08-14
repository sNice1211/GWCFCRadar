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
    id, tagName: tag || 'div', innerHTML: '', textContent: '', value: '',
    style: {}, dataset: {}, children: [], classList: { add(){}, remove(){}, toggle(){} },
    appendChild(c) { this.children.push(c); },
    querySelector() { return mkEl('sub'); },
    querySelectorAll() { return []; },
    scrollIntoView() {},
  };
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
 'sev-playbar-fill','sev-playbar-thumb','sev-model-sel'].forEach(id => els[id] = mkEl(id));

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
}});
const MANIFESTS = () => ({
  gfs: { model:'gfs', label:'GFS', res:'0.25 deg', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,3,6,9,12],min:-40,max:45},
                   apcp:{hours:[3,6,9,12],min:0,max:50},
                   mslp:{hours:[0,3,6,9,12],min:960,max:1050} } },
  hrrr:{ model:'hrrr', label:'HRRR', res:'3 km', run: RUN, bounds:[[20,-130],[55,-60]],
         fields: { t2m:{hours:[0,1,2,3],min:-40,max:45},
                   refc:{hours:[0,1,2,3],min:-10,max:75} } },
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
const checks = `let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
}

(async () => {
  console.log('\\n1. picking a Pi model');
  await _sevSetSection('pi:hrrr');
  ok('base resolved from Firestore', _hdBase === 'https://pi.test', _hdBase);
  ok('model is the one asked for, not the first listed', _hdModel === 'hrrr', _hdModel);
  ok('section recorded', _sevSection === 'pi:hrrr', _sevSection);
  ok('an image went on the map', added.length === 1, added.length);
  ok('image url points at hrrr and the real run',
     added[0] && /models\\/hrrr\\/20260814_12\\/t2m_f000\\.png$/.test(added[0].url),
     added[0] && added[0].url);
  ok('IEM branch never ran', iemRendered === 0, iemRendered);

  console.log('\\n2. the hour grid is the model\\'s own');
  ok('max frame follows HRRR t2m (4 hours -> 3)', _sevMaxFrameFor('pi:hrrr') === 3, _sevMaxFrameFor('pi:hrrr'));
  const h = _sevFcastDateTime(2);
  ok('header reads the hour out of the list', h.flbl === 'F+002', h.flbl);
  ok('header valid time is run + that hour', h.date.includes('14:00z'), h.date);

  console.log('\\n3. scrubbing');
  _sevSetFrame(3);
  ok('frame 3 drew hour 3', added[added.length-1].url.includes('t2m_f003.png'), added[added.length-1].url);
  ok('still no IEM render', iemRendered === 0, iemRendered);
  ok('only one overlay is live once loads fire', (Array.from(added).forEach(l=>l._h.load&&l._h.load()), added.length === 1), added.length);

  console.log('\\n4. the playbar drag path (calls _sevRender directly)');
  const before = iemRendered;
  _sevFrame = 2; _sevRender();
  ok('drag render stayed on the Pi', iemRendered === before, iemRendered);
  ok('drag render drew hour 2', added[added.length-1].url.includes('t2m_f002.png'), added[added.length-1].url);

  console.log('\\n5. switching product');
  _sevSetVar('refc');
  ok('field switched', _hdField === 'refc', _hdField);
  ok('drew refc', added[added.length-1].url.includes('refc_f000.png'), added[added.length-1].url);

  console.log('\\n6. switching to a model with different hours');
  await _sevSetSection('pi:gfs');
  ok('model switched', _hdModel === 'gfs', _hdModel);
  ok('refc is gone from GFS, so the field fell back', _hdField !== 'refc', _hdField);
  ok('max frame is now GFS t2m (5 hours -> 4)', _sevMaxFrameFor('pi:gfs') === 4, _sevMaxFrameFor('pi:gfs'));
  ok('frame reset to 0', _sevFrame === 0, _sevFrame);

  console.log('\\n7. a product whose hours do not start at zero');
  _sevSetVar('apcp');
  const u = added[added.length-1].url;
  ok('precip starts at F+003, not F+000', u.includes('apcp_f003.png'), u);
  ok('header agrees', _sevFcastDateTime(0).flbl === 'F+003', _sevFcastDateTime(0).flbl);

  console.log('\\n8. leaving the Pi');
  await _sevSetSection('hrrr');
  ok('Pi turned off', _hdOn === false, _hdOn);
  ok('picker flag cleared', _hdFromPicker === false, _hdFromPicker);
  ok('Pi image removed from the map', added.length === 0, added.length);
  _sevUpdateProducts();
  ok('product list is the normal fixed one again',
     document.getElementById('sev-var-sel').innerHTML === 'FIXED-LIST',
     document.getElementById('sev-var-sel').innerHTML);

  console.log('\\n9. the pill turning it off mid-Pi');
  await _sevSetSection('pi:gfs');
  _hdDisable();
  ok('picker flag cleared by the pill too', _hdFromPicker === false, _hdFromPicker);
  const n = iemRendered; _sevRender();
  ok('render goes back to the normal path', iemRendered === n + 1, iemRendered);

  console.log('\\n10. a new run appearing on the Pi');
  await _sevSetSection('pi:gfs');
  const oldUrl = added[added.length-1].url;
  RUN = '20260814_18';
  _hdIndexAt = 0;                       // pretend the TTL expired
  await _hdPickModel('gfs');
  _hdShow();
  const newUrl = added[added.length-1].url;
  ok('picked up the new run', newUrl.includes('20260814_18'), newUrl);
  ok('and it is a different url than before', newUrl !== oldUrl);

  console.log('\\n11. the Pi being unreachable');
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok:false });
  _hdBase = null; _hdIndex = null; _hdIndexAt = 0; _hdManifest = null; _hdModel = null; _hdOn = false;
  await _sevSetSection('pi:gfs');
  _sevUpdateProducts();
  const sel = document.getElementById('sev-var-sel');
  ok('no fake product list is offered', sel.innerHTML !== 'FIXED-LIST', sel.innerHTML);
  global.fetch = realFetch;

  console.log('\\n' + (fail ? \`\${fail} FAILED, \${pass} passed\` : \`all \${pass} passed\`));
  process.exit(fail ? 1 : 0);
})();
`;
eval(block + "\n" + checks);
