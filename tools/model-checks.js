let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
}

(async () => {
  console.log('\n1. picking a Pi model');
  await _sevSetSection('pi:hrrr');
  ok('base resolved from Firestore', _hdBase === 'https://pi.test', _hdBase);
  ok('model is the one asked for, not the first listed', _hdModel === 'hrrr', _hdModel);
  ok('section recorded', _sevSection === 'pi:hrrr', _sevSection);
  ok('an image went on the map', added.length === 1, added.length);
  ok('image url points at hrrr and the real run',
     added[0] && /models\/hrrr\/20260814_12\/t2m_f000\.png$/.test(added[0].url),
     added[0] && added[0].url);
  ok('IEM branch never ran', iemRendered === 0, iemRendered);

  console.log('\n2. the hour grid is the model\'s own');
  ok('max frame follows HRRR t2m (4 hours -> 3)', _sevMaxFrameFor('pi:hrrr') === 3, _sevMaxFrameFor('pi:hrrr'));
  const h = _sevFcastDateTime(2);
  ok('header reads the hour out of the list', h.flbl === 'F+002', h.flbl);
  ok('header valid time is run + that hour', h.date.includes('14:00z'), h.date);

  console.log('\n3. scrubbing');
  _sevSetFrame(3);
  ok('frame 3 drew hour 3', added[added.length-1].url.includes('t2m_f003.png'), added[added.length-1].url);
  ok('still no IEM render', iemRendered === 0, iemRendered);
  ok('only one overlay is live once loads fire', (Array.from(added).forEach(l=>l._h.load&&l._h.load()), added.length === 1), added.length);

  console.log('\n4. the playbar drag path (calls _sevRender directly)');
  const before = iemRendered;
  _sevFrame = 2; _sevRender();
  ok('drag render stayed on the Pi', iemRendered === before, iemRendered);
  ok('drag render drew hour 2', added[added.length-1].url.includes('t2m_f002.png'), added[added.length-1].url);

  console.log('\n5. switching product');
  _sevSetVar('refc');
  ok('field switched', _hdField === 'refc', _hdField);
  ok('drew refc', added[added.length-1].url.includes('refc_f000.png'), added[added.length-1].url);

  console.log('\n6. switching to a model with different hours');
  await _sevSetSection('pi:gfs');
  ok('model switched', _hdModel === 'gfs', _hdModel);
  ok('refc is gone from GFS, so the field fell back', _hdField !== 'refc', _hdField);
  ok('max frame is now GFS t2m (5 hours -> 4)', _sevMaxFrameFor('pi:gfs') === 4, _sevMaxFrameFor('pi:gfs'));
  ok('frame reset to 0', _sevFrame === 0, _sevFrame);

  console.log('\n7. a product whose hours do not start at zero');
  _sevSetVar('apcp');
  const u = added[added.length-1].url;
  ok('precip starts at F+003, not F+000', u.includes('apcp_f003.png'), u);
  ok('header agrees', _sevFcastDateTime(0).flbl === 'F+003', _sevFcastDateTime(0).flbl);

  console.log('\n8. leaving the Pi');
  await _sevSetSection('hrrr');
  ok('Pi turned off', _hdOn === false, _hdOn);
  ok('picker flag cleared', _hdFromPicker === false, _hdFromPicker);
  ok('Pi image removed from the map', added.length === 0, added.length);
  _sevUpdateProducts();
  ok('product list is the normal fixed one again',
     document.getElementById('sev-var-sel').innerHTML === 'FIXED-LIST',
     document.getElementById('sev-var-sel').innerHTML);

  console.log('\n9. the pill turning it off mid-Pi');
  await _sevSetSection('pi:gfs');
  _hdDisable();
  ok('picker flag cleared by the pill too', _hdFromPicker === false, _hdFromPicker);
  const n = iemRendered; _sevRender();
  ok('render goes back to the normal path', iemRendered === n + 1, iemRendered);

  console.log('\n10. a new run appearing on the Pi');
  await _sevSetSection('pi:gfs');
  const oldUrl = added[added.length-1].url;
  RUN = '20260814_18';
  _hdIndexAt = 0;                       // pretend the TTL expired
  await _hdPickModel('gfs');
  _hdShow();
  const newUrl = added[added.length-1].url;
  ok('picked up the new run', newUrl.includes('20260814_18'), newUrl);
  ok('and it is a different url than before', newUrl !== oldUrl);

  console.log('\n11. the Pi being unreachable');
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok:false });
  _hdBase = null; _hdIndex = null; _hdIndexAt = 0; _hdManifest = null; _hdModel = null; _hdOn = false;
  await _sevSetSection('pi:gfs');
  _sevUpdateProducts();
  const sel = document.getElementById('sev-var-sel');
  ok('no fake product list is offered', sel.innerHTML !== 'FIXED-LIST', sel.innerHTML);

  // A failed lookup must not be permanent. Enabling leaves itself on even when
  // it could not find an address, so the section wrapper has to notice there
  // is still no address and try again rather than assume it is set up.
  global.fetch = realFetch;
  await _sevSetSection('pi:gfs');
  ok('it recovers on the next pick, without a page reload',
     _hdBase === 'https://pi.test' && added.length > 0, _hdBase + ' / ' + added.length);


  console.log('\n12. the Model list builds itself from the Pi');
  _hdIndexAt = 0;
  await _hdFreshIndex();
  const group = document.getElementById('sev-pi-group');
  const vals = group.children.map(o => o.value);
  ok('every model the Pi has is offered', vals.length === 5, vals.join(','));
  ok('models added on the Pi appeared with no edit to the page',
     vals.includes('pi:nbm') && vals.includes('pi:rtma'), vals.join(','));
  ok('labels carry the resolution',
     group.children.find(o => o.value === 'pi:nbm').textContent === 'NBM (Pi, 2.5 km blend)',
     group.children.find(o => o.value === 'pi:nbm').textContent);

  console.log('\n13. an analysis, which has only one frame');
  await _sevSetSection('pi:rtma');
  ok('one hour only', _sevMaxFrameFor('pi:rtma') === 0, _sevMaxFrameFor('pi:rtma'));
  ok('it still drew', added[added.length-1].url.includes('/rtma/'), added[added.length-1].url);
  _sevSetFrame(5);                          // past the end, as the playbar can go
  ok('a frame past the end draws the only hour there is',
     added[added.length-1].url.includes('t2m_f000.png'), added[added.length-1].url);

  console.log('\n14. a model with a different product list again');
  await _sevSetSection('pi:nbm');
  _sevUpdateProducts();
  const nbmOpts = document.getElementById('sev-var-sel').children.map(o => o.value);
  ok('NBM offers wind and not reflectivity',
     nbmOpts.includes('wind') && !nbmOpts.includes('refc'), nbmOpts.join(','));


  console.log('\n15. a tropical model, which lives somewhere else');
  await _sevSetSection('pi:gfstrop');
  ok('it drew', added[added.length-1].url.includes('/gfstrop/'), added[added.length-1].url);
  ok('bounds came from its own manifest, not the last model shown',
     JSON.stringify(added[added.length-1].bounds) === JSON.stringify([[0,-165],[45,-10]]),
     JSON.stringify(added[added.length-1].bounds));
  _sevUpdateProducts();
  const tOpts = document.getElementById('sev-var-sel').children.map(o => o.value);
  ok('tropical products are offered',
     tOpts.includes('pwat') && tOpts.includes('shear') && tOpts.includes('sst'),
     tOpts.join(','));
  ok('and CONUS-only products are not',
     !tOpts.includes('refc') && !tOpts.includes('t2m'), tOpts.join(','));
  ok('the field fell to one this model has', _hdField === 'pwat', _hdField);
  _sevSetVar('shear');
  ok('switching to shear drew shear',
     added[added.length-1].url.includes('shear_f000.png'), added[added.length-1].url);

  console.log('\n16. going back to a CONUS model restores its bounds');
  await _sevSetSection('pi:hrrr');
  ok('bounds are CONUS again',
     JSON.stringify(added[added.length-1].bounds) === JSON.stringify([[20,-130],[55,-60]]),
     JSON.stringify(added[added.length-1].bounds));

  console.log('\n' + (fail ? `${fail} FAILED, ${pass} passed` : `all ${pass} passed`));
  process.exit(fail ? 1 : 0);
})();
