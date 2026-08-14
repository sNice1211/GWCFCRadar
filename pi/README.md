# Model charts on the Pi

Builds forecast map overlays on the Raspberry Pi so the browser does not have
to. The web app is a static page with no backend, and has to work in the
PlayStation 5 browser, which has no WebGL. Both rule out doing this on the
client. The Pi fetches GRIB2 from NOAA, decodes it, and writes finished PNGs
that Leaflet drops on the map as a plain image overlay.

## What it costs, measured on the target Pi

    download, per forecast hour .. 0.52 MB, about 1 second
    download, per run (41 hours) . ~21 MB, ~40 seconds
    download, per day (4 runs) ... ~83 MB
    on disk, steady state ........ ~6 MB

The disk figure is small because a rendered field is mostly flat colour and PNG
compresses it hard. Measured on CONUS-sized grids: a smooth field like MSLP is
2.6 KB, a wavy one like temperature 13.5 KB, and a sparse one like precipitation
0.4 KB. Random noise would be 125 KB, but weather is not noise.

NOAA does not meter this, so there is no quota to run out of, which was the
problem with the API the site uses now.

## Install, in one command

    bash ~/GWCFCRadar/pi/install.sh

That installs what is missing, builds the Python environment, registers three
services so it survives a reboot and a closed terminal, does a first build, and
prints the address to give the site. Safe to run again if a step fails.

    gwcfc-models   builds the images, hourly
    gwcfc-serve    serves them with the header that makes them readable
    gwcfc-tunnel   gives them a public HTTPS address

## When the site cannot read the Pi

    bash ~/GWCFCRadar/pi/diagnose.sh

Checks the chain in order and names the first thing that is wrong. The usual
answer is port 8080: if a plain `python3 -m http.server` is still holding it
from an earlier session, the CORS server could not bind, and a browser will
refuse to read anything through the tunnel even though the files are sitting
right there. The fix it prints is:

    pkill -f 'http.server 8080'
    systemctl --user restart gwcfc-serve

Is the site being told where the Pi is?

    ~/wxenv/bin/python ~/GWCFCRadar/pi/publish_url.py --check

That prints the tunnel address, the address the site currently holds, and
whether they match. If the write is being refused it says which of the two
usual causes it is: the piEndpoint rules not published, or anonymous sign-in
switched off for the project.

Afterwards:

    systemctl --user status gwcfc-models.timer
    journalctl --user -u gwcfc-models -n 50
    grep trycloudflare ~/tunnel.log      # the address changes on restart

## Install by hand

    sudo apt update
    sudo apt install -y python3-numpy python3-pillow python3-requests libeccodes-tools

The Python binding for eccodes is not packaged, so it needs pip. Current
Raspberry Pi OS refuses plain `pip install` into the system Python (PEP 668,
the "externally-managed environment" error), so use a virtual environment:

    python3 -m venv --system-site-packages ~/wxenv
    ~/wxenv/bin/pip install eccodes

`--system-site-packages` means numpy, Pillow and requests come from apt, which
is much faster than pip building them on an ARM board.

If you already made this venv and installed cfgrib into it, there is nothing to
do: cfgrib depends on eccodes, so it is already there. Nothing here imports
cfgrib or xarray any more, but leaving them installed does no harm.

Check it worked:

    ~/wxenv/bin/python -c "import eccodes, numpy, PIL, requests; print('ready')"

## Building by hand

Start it through systemd rather than running the script directly:

    systemctl --user start gwcfc-models
    journalctl --user -u gwcfc-models -f

Run from a terminal the build belongs to that terminal, so closing the window
kills a ten minute job. As a service it belongs to the machine. The second
command is only a view of it: Ctrl+C stops watching, not building.

A build that is interrupted leaves no manifest for the run it was working on,
so nothing half-finished is ever served and the next hourly run simply picks it
up again.

## Run the script directly

    ~/wxenv/bin/python ~/GWCFCRadar/pi/gfs_pipeline.py

The first run downloads and renders a full cycle, so give it a minute. It logs
each forecast hour as it goes. Output lands in `~/wxdata/models/`.

## Automate it

    crontab -e

Add:

    17 * * * * ~/wxenv/bin/python ~/GWCFCRadar/pi/gfs_pipeline.py >> ~/wxdata/models.log 2>&1

Hourly, not four times a day, on purpose. The script works out whether the
current run is already built and exits in under a second when it is, so an
hourly check costs nothing and picks a run up as soon as it publishes rather
than at a fixed guess.

Minute 17 rather than 0 because everyone's cron fires on the hour and NOAA
feels it.

## Serving it

The site is HTTPS, so it cannot read from `http://192.168.x.x`: browsers block
mixed content. The files need a public HTTPS address.

    cd ~/wxdata && nohup python3 -m http.server 8080 >/dev/null 2>&1 &
    cloudflared tunnel --url http://localhost:8080

For anything permanent, run both as services so they survive a reboot and the
tunnel keeps one hostname instead of a new random one each restart.

## What it writes

    ~/wxdata/models/
      latest.json                  <- every model that has a finished run
      gfs/20260814_12/
        manifest.json              <- written last; its presence means "finished"
        t2m_f000.png  t2m_f003.png  ...
      nam/20260814_12/ ...
      hrrr/20260814_17/ ...

Models, each on its own cadence, with `latest.json` listing whichever ones
currently have a finished run:

    gfs      0.25 deg      to +120h   4x a day
    nam      12 km         to  +60h   4x a day
    namnest  3 km          to  +60h   4x a day
    hrrr     3 km          to  +18h   hourly
    rap      13 km         to  +21h   hourly
    nbm      2.5 km blend  to +120h   4x a day
    rtma     2.5 km        now only   hourly
    gefs     0.5 deg mean  to +168h   4x a day
    gefsspr  0.5 deg sprd  to +168h   4x a day

Three of those are worth a word. **NAM Nest** is HRRR's resolution with three
times HRRR's reach: the same 12 km model run again over a smaller box at a grid
fine enough to resolve a single storm. **NBM** is not a model at all, it is the
Weather Service's own blend of many models corrected against what actually
verified, and for a plain question like tomorrow's temperature it beats any
single model here. **RTMA** is not a forecast: it is one frame of what is
believed to be happening right now at 2.5 km, built from observations, which is
the thing to check a forecast against.

The page builds its model list from `latest.json`, so adding a model here is
enough. Nothing needs editing on the site.

NBM is taken four times a day rather than the hourly it publishes at. It is a
five day blend and does not meaningfully change in an hour, so fetching 41
forecast hours of 2.5 km data every hour would be by far the largest thing here
in exchange for almost nothing.

## Check a model before trusting it

    ~/wxenv/bin/python ~/GWCFCRadar/pi/check_models.py

A model is four strings, and a wrong one fails in a way that looks like the
model not existing: the request comes back 500 and the run is skipped. This
finds the current cycle, confirms the file is on the server, reads NOAA's index
to see which wanted fields are in it, and downloads one forecast hour to
measure the real cost. It names which of the four strings is wrong, and it does
it in about a minute rather than after a build. Run it after adding a model,
and after NOAA reorganises anything.

Take its megabytes-per-day figures seriously before adding more: the fine grids
are much heavier than the coarse ones, and this runs on a home connection.
To carry fewer, edit `DEFAULT_MODELS`, or name the ones you want:

    ~/wxenv/bin/python ~/GWCFCRadar/pi/gfs_pipeline.py gfs hrrr rtma

Spread is the useful half of an ensemble: it is how far apart the members are,
so a high value is the model saying it does not know. A single deterministic
chart cannot say that at all. It is drawn pale to dark rather than through a
rainbow, because the point is the disagreement rather than a value to read off.

Soundings are built too, as a separate product. They are the same source at
pressure levels instead of surface fields, and they are written differently:
the value is encoded into the pixel (high byte red, low byte green, alpha 0
for no data) rather than coloured, because a sounding has to be read back as
numbers. The browser draws the image to a canvas, reads one pixel per level,
and has a profile, with no endpoint to ask and nothing to run on the Pi. The
manifest carries the range each variable was scaled against.

Measured round trip: 0.0018 C worst error against a 0.0021 C quantisation
step, so nothing meaningful is lost.

    12 levels x 4 variables x 9 forecast hours = 432 images, about 10 MB

    python3 pi/gfs_pipeline.py             # all of them
    python3 pi/gfs_pipeline.py hrrr        # just one

Fields: `t2m`, `d2m`, `mslp`, `cape`, `refc`, `apcp`, `wind`.

`manifest.json` carries the bounds, the hours that succeeded per field, and the
value range, so the page can build a legend without opening any images.

The manifest is written **last**. A run that dies halfway leaves no manifest, so
the site keeps serving the previous complete run instead of a half-built set of
pictures.

## Using it from the page

    const idx  = await (await fetch(BASE + '/models/latest.json')).json();
    const man  = await (await fetch(BASE + '/models/' + idx.path)).json();
    const url  = `${BASE}/models/${man.run}/t2m_f012.png`;

    L.imageOverlay(url, man.bounds, { opacity: 0.75, interactive: false })
     .addTo(map);

One pixel is one grid cell on the coarse models, and nothing crops or pads the
image, so it lines up with `man.bounds` exactly. The fine ones are thinned to
1600 px on the long edge first, keeping the first and last cell so the extent
is unchanged: HRRR at 3 km across this box is about 2300 by 1300 cells, which
is a picture of three million pixels that the PlayStation 5 browser has to hold
in memory decoded, and it does not have much to spare. At 1600 px a pixel is
about 4 km, near enough the model's own resolution to lose nothing visible.
Thinning takes every Nth cell rather than averaging, because an average of
reflectivity smears a storm's core into the clear air around it. That is the reason these are written straight from
the array rather than through a plot: saving a matplotlib figure with
`bbox_inches='tight'` silently trims it, and the picture then no longer matches
the bounds it is given.

## When something goes wrong

**"not published yet"** is normal. NOAA publishes 3.5 to 5 hours after the
cycle time and the script waits rather than guessing.

**"another run is already going"** means a run really is going. The lock records
its process id and is checked against it, so a lock left behind by a terminal
being closed clears itself on the next run rather than blocking for hours. To
clear one by hand:

    rm -f ~/.gwcfc-models.lock

**A field missing from the manifest** means its GRIB key did not match. Look at
what is actually in a file with:

    grib_ls -p shortName,typeOfLevel,level /tmp/<the grib file>

and correct `short` / `levtype` / `level` in `FIELDS`. Those are GRIB's own keys,
which is why matching uses them: a name invented during conversion to some other
format can change between library versions, but `shortName` does not.
