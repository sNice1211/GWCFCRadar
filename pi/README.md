# Model charts on the Pi

Builds forecast map overlays on the Raspberry Pi so the browser does not have
to. The web app is a static page with no backend, and has to work in the
PlayStation 5 browser, which has no WebGL. Both rule out doing this on the
client. The Pi fetches GRIB2 from NOAA, decodes it, and writes finished PNGs
that Leaflet drops on the map as a plain image overlay.

## What it costs, measured on the target Pi

    per forecast hour ....... 0.52 MB, about 1 second
    per run (41 hours) ...... ~21 MB, ~40 seconds
    per day (4 runs) ........ ~83 MB
    on disk, steady state ... ~155 MB

NOAA does not meter this, so there is no quota to run out of, which was the
problem with the API the site uses now.

## Install

    sudo apt update
    sudo apt install -y python3-numpy python3-pillow python3-requests libeccodes-tools

cfgrib is not packaged, so it needs pip. Current Raspberry Pi OS refuses plain
`pip install` into the system Python (PEP 668, the "externally-managed
environment" error), so use a virtual environment:

    python3 -m venv --system-site-packages ~/wxenv
    ~/wxenv/bin/pip install cfgrib

`--system-site-packages` means numpy, Pillow and requests come from apt, which
is much faster than pip building them on an ARM board.

Check it worked:

    ~/wxenv/bin/python -c "import cfgrib, numpy, PIL, requests; print('ready')"

## Run it once by hand

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
      latest.json                  <- points at the newest finished run
      20260814_12/
        manifest.json              <- written last; its presence means "finished"
        t2m_f000.png  t2m_f003.png  ...
        refc_f000.png ...

Fields: `t2m`, `d2m`, `mslp`, `cape`, `refc`, `apcp`, `wind`.
Hours: 0 to 120 in steps of 3.

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

One pixel is one grid cell and nothing crops or pads the image, so it lines up
with `man.bounds` exactly. That is the reason these are written straight from
the array rather than through a plot: saving a matplotlib figure with
`bbox_inches='tight'` silently trims it, and the picture then no longer matches
the bounds it is given.

## When something goes wrong

**"not published yet"** is normal. NOAA publishes 3.5 to 5 hours after the
cycle time and the script waits rather than guessing.

**"another run is already going"** means a lock file is held. A lock left by a
crash is ignored after three hours.

**A field missing from the manifest** means its GRIB key did not match. Look at
what is actually in a file with:

    grib_ls -p shortName,typeOfLevel,level /tmp/<the grib file>

and correct `short` / `levtype` / `level` in `FIELDS`. Matching is done on those
GRIB keys rather than on the variable name cfgrib invents, because those names
change between versions.
