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
  ok('image url carries model, region and the real run',
     added[0] && /models\/hrrr\/conus\/20260814_12\/t2m_f000\.png$/.test(added[0].url),
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
  ok('regions are not listed as models', !vals.some(v => v.includes('trop')), vals.join(','));
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


  console.log('\n15. the same model over another region');
  await _sevSetSection('pi:gfs');
  ok('region picker offers both', _hdRegionsOf('gfs').join(',') === 'conus,tropics',
     _hdRegionsOf('gfs').join(','));
  const rsel = document.getElementById('sev-region-sel');
  ok('and is shown, because there is a choice to make', rsel.style.display === '',
     rsel.style.display);
  await _hdSetRegion('tropics');
  ok('it drew the tropical crop of the same model',
     added[added.length-1].url.includes('/gfs/tropics/'), added[added.length-1].url);
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

  console.log('\n16. back to CONUS on the same model');
  await _hdSetRegion('conus');
  ok('bounds are CONUS again',
     JSON.stringify(added[added.length-1].bounds) === JSON.stringify([[20,-130],[55,-60]]),
     JSON.stringify(added[added.length-1].bounds));
  ok('and the products changed back with it',
     _hdHoursFor('mslp').length > 0, _hdField);

  console.log('\n17. a model with one region hides the picker');
  await _sevSetSection('pi:hrrr');
  ok('picker hidden', document.getElementById('sev-region-sel').style.display === 'none',
     document.getElementById('sev-region-sel').style.display);

  console.log('\n18. a nest published over four boxes is one model');
  await _sevSetSection('pi:namnest');
  await _hdSetRegion('prico');
  ok('Puerto Rico drew', added[added.length-1].url.includes('/namnest/prico/'),
     added[added.length-1].url);
  ok('with its own bounds',
     JSON.stringify(added[added.length-1].bounds) === JSON.stringify([[15,-71],[22,-60]]),
     JSON.stringify(added[added.length-1].bounds));


  console.log('\n19. an index from before regions existed');
  // Exactly the state a Pi that has not rebuilt yet is in. It must still draw
  // rather than offering a list of models that all fail to open.
  useOldIndex = true;
  _hdBase = null; _hdIndex = null; _hdIndexAt = 0;
  _hdManifest = null; _hdModel = null; _hdRegion = null; _hdOn = false;
  await _sevSetSection('pi:gfstrop');
  ok('the old-shaped entry is read as one region',
     _hdRegionsOf('gfstrop').join(',') === 'conus', _hdRegionsOf('gfstrop').join(','));
  ok('it still drew', added.length > 0 && added[added.length-1].url.includes('gfstrop/'),
     added.length ? added[added.length-1].url : 'nothing');
  ok('and followed the old path, without inventing a region directory',
     !added[added.length-1].url.includes('/conus/'), added[added.length-1].url);
  ok('the region picker stays hidden for it',
     document.getElementById('sev-region-sel').style.display === 'none',
     document.getElementById('sev-region-sel').style.display);
  useOldIndex = false;


  console.log('\n20. the hurricane model, whose regions are storms');
  ok('a storm id reads as a storm', _hdRegionLabel('05l') === 'Storm 5 (Atlantic)',
     _hdRegionLabel('05l'));
  ok('and the eastern Pacific too', _hdRegionLabel('03e') === 'Storm 3 (E Pacific)',
     _hdRegionLabel('03e'));
  ok('places still read as places', _hdRegionLabel('prico') === 'Puerto Rico',
     _hdRegionLabel('prico'));
  ok('anything else is left alone', _hdRegionLabel('mars') === 'mars');


  console.log('\n21. cyclone tracks, and the dateline');
  // A storm crossing 180 has longitudes that jump from 179 to -179, and a
  // straight line between those two goes the wrong way round the world.
  lines.length = 0;
  _cycLayers = [];
  _cycDrawTrack([{lat:10,lon:170},{lat:12,lon:176},{lat:14,lon:-178},
                 {lat:16,lon:-172}], CYC_MEMBER);
  ok('split into two legs at the dateline', lines.length === 2, lines.length);
  ok('and neither leg spans the world',
     lines.every(l => Math.abs(l.pts[0][1] - l.pts[l.pts.length-1][1]) < 180),
     lines.map(l => l.pts.map(p => p[1]).join('/')).join('  '));

  lines.length = 0; _cycLayers = [];
  _cycDrawTrack([{lat:25,lon:-71},{lat:26,lon:-72},{lat:27,lon:-73}], CYC_MEAN);
  ok('an ordinary track is one line', lines.length === 1, lines.length);
  ok('with every point on it', lines[0].pts.length === 3, lines[0].pts.length);
  ok('the mean is drawn heavier than a member',
     CYC_MEAN.weight > CYC_MEMBER.weight && CYC_MEAN.opacity > CYC_MEMBER.opacity);

  lines.length = 0; _cycLayers = [];
  _cycDrawTrack([{lat:20,lon:-60}], CYC_MEMBER);
  ok('a single point draws nothing, since one point is not a line',
     lines.length === 0, lines.length);
  _cycClear();

  // The cyclone models live in the Spaghetti Models panel now, beside every
  // other storm track. These check the panel's own controls fill from the
  // run, the toggle draws, and everything the lab publishes is reachable.
  console.log('\n21b. AI cyclones in the Spaghetti Models panel');
  await _spagCycSync();
  const cv = els['cyc-variant-sel'];
  ok('the run\'s variants fill the panel picker',
     cv.children.length === 2, cv.children.length);
  ok('named as models rather than raw keys',
     cv.children[0].value === 'OPER' &&
     cv.children[0].textContent.includes('Operational'),
     cv.children[0].value + ' / ' + cv.children[0].textContent);
  ok('the status line says what the run holds',
     /Run 2026_08_16T00_00/.test(els['cyc-lab-status'].textContent) &&
     /genesis: cumulative \+ instantaneous/.test(els['cyc-lab-status'].textContent),
     els['cyc-lab-status'].textContent);

  lines.length = 0;
  await _spagCycVariant('FNV3P2');
  await _spagCycToggle();
  ok('the toggle switches the layer on with that variant',
     _cycOn === true && _cycVariant === 'FNV3P2',
     _cycOn + '/' + _cycVariant);
  ok('and it drew tracks on the map', lines.length > 0, lines.length);
  ok('with the cumulative genesis wash underneath',
     added.some(l => l.url && l.url.includes('cumulative.png')),
     added.filter(l => l.url).map(l => l.url).join(','));

  // Both genesis fields exist and both must be reachable.
  await _spagCycGenesis('instantaneous');
  ok('switching genesis draws the instantaneous field instead',
     added.some(l => l.url && l.url.includes('instantaneous.png')) &&
     !added.some(l => l.url && l.url.includes('cumulative.png')),
     added.filter(l => l.url).map(l => l.url).join(','));
  await _spagCycGenesis('off');
  ok('genesis off draws neither wash',
     !added.some(l => l.url && (l.url.includes('cumulative.png') ||
                                l.url.includes('instantaneous.png'))),
     added.filter(l => l.url).map(l => l.url).join(','));

  // The focus readout renders the numbers riding the points: wind, pressure
  // and lead, which nothing displayed before.
  const fkey = Object.keys(_cycGroups)[0];
  _cycFocus(fkey);
  ok('focusing a line reads out its peak wind, pressure and span',
     /peak wind 85 kt/.test(els['cyc-focus-info'].textContent) &&
     /lowest pressure 962 hPa/.test(els['cyc-focus-info'].textContent) &&
     /F\+48h/.test(els['cyc-focus-info'].textContent),
     els['cyc-focus-info'].textContent);
  _cycFocus(fkey);
  ok('unfocusing clears the readout',
     els['cyc-focus-info'].textContent === '', els['cyc-focus-info'].textContent);
  _cycDisable();
  await _spagCycGenesis('cumulative');


  console.log('\n22. Pi radar, drawn from the newest volume');
  _prClear();
  _hdBase = 'https://pi.test';
  await _prEnable();
  ok('the radar layer is on', _prOn === true);
  ok('it drew one site, not every site the Pi has',
     _prLayers.length === 1, _prLayers.length);
  const rl = _prLayers[_prLayers.length-1];
  ok('from the newest frame, not the older one',
     rl && rl.url.includes('/20260815_1205/'), rl && rl.url);
  ok('and Level 2 reflectivity, the detailed product',
     rl && rl.url.endsWith('/ref.png'), rl && rl.url);
  ok('with bounds from the frame manifest',
     rl && JSON.stringify(rl.bounds) === JSON.stringify([[33,-99],[37,-95]]),
     rl && JSON.stringify(rl.bounds));
  // Velocity is a different file, not a different colour of the same one, so
  // switching product has to change the URL that gets fetched.
  await _prSetProduct('velocity');
  const vl = _prLayers[_prLayers.length - 1];
  ok('choosing velocity draws the velocity file',
     vl && vl.url.endsWith('/vel.png'), vl && vl.url);
  await _prSetProduct('reflectivity');

  // The fake Pi has Level 2 but no Level 3. Asking for Level 3 must fall back
  // rather than clear the map, since an empty map is the worse answer.
  await _prSetLevel('l3');
  ok('asking for a level the Pi has not built falls back to the one it has',
     _prLayers.length === 1, _prLayers.length);
  const fb = _prLayers[_prLayers.length - 1];
  ok('and that fallback is still Level 2',
     fb && fb.url.includes('/l2/'), fb && fb.url);
  await _prSetLevel('auto');

  // The site bubbles pick which radar. Switching has to change the picture,
  // and must not add a second one beside the first.
  await _prSetSite('KFWS');
  ok('choosing another site draws that one instead',
     _prLayers.length === 1 &&
     _prLayers[0].url.includes('/KFWS/'), _prLayers.length + ' ' +
     (_prLayers[0] && _prLayers[0].url));
  await _prSetSite('KTLX');

  // A remembered site the current run does not have must not draw nothing.
  await _prSetSite('KEMX');
  ok('a site this run does not have falls back rather than drawing nothing',
     _prLayers.length === 1, _prLayers.length);
  ok('and the remembered site is corrected to match the map',
     _prSite === 'KFWS' || _prSite === 'KTLX', _prSite);

  // The Pi's Level 3 row, against a Pi that has built all eleven products.
  // "None of L3 works" has to be checkable on our half: each product bubble
  // must fetch its own PNG out of the frame the manifest describes.
  usePiL3 = true;
  await _prSetLevel('l3');
  for (const [prod, png] of [['reflectivity','n0q'], ['velocity','n0u'],
      ['corrcoeff','n0c'], ['hydroclass','n0h'], ['stormtotal','stp'],
      ['vil','dvl'], ['echotops','eet'], ['composite','ncr']]) {
    await _prSetProduct(prod);
    const u = _prLayers[0] && _prLayers[0].url;
    ok('Level 3 ' + prod + ' draws its own image',
       u && u.includes('/l3/KTLX/20260816_0500/' + png + '.png'), u);
  }
  usePiL3 = false;
  await _prSetLevel('auto');
  await _prSetProduct('reflectivity');

  _prDisable();
  ok('turning it off clears the layer', _prOn === false && _prLayers.length === 0,
     _prLayers.length);

  console.log('\n' + (fail ? `${fail} FAILED, ${pass} passed` : `all ${pass} passed`));
  process.exit(fail ? 1 : 0);
})();
