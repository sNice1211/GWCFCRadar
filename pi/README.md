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

    gwcfc-models    builds the model images, hourly
    gwcfc-radar     decodes Level 2 and Level 3 radar, every five minutes
    gwcfc-cyclones  DeepMind cyclone tracks and genesis, every three hours
    gwcfc-serve     serves them with the header that makes them readable
    gwcfc-tunnel    gives them a public HTTPS address
    gwcfc-publish   tells the site where the tunnel is
    gwcfc-update    pulls new code every fifteen minutes

The last one is why nothing here needs a `git pull` by hand. The pipelines are
oneshot units fired by timers, so they read the files fresh on every run and
pick up new code by themselves; only serve.py holds code in memory, so that is
the one the updater restarts, and only when serve.py itself changed. It
fast-forwards or it does nothing: if the Pi has local commits it says so and
leaves them, rather than deciding on your behalf that they do not matter.

Everything updates itself. Radar is the fast one, because a new volume lands
every four to six minutes and an hourly check would draw weather that had
already moved. Cyclones run twice a day because that is how often they are
published, and the timer checks every three hours so a run is picked up soon
after it lands rather than at a fixed guess. Each has its own lock, so a slow
one never holds up the others.

    systemctl --user list-timers 'gwcfc-*'

## When something is wrong

Two scripts, and the difference between them is whether they touch anything.

    cd ~/GWCFCRadar; git pull; bash pi/fix.sh

`fix.sh` runs every repair, in the order that matters: newest code first
(because every other fix ships inside it), then the missing packages, then
the restarts, then it says where things stand. It installs and restarts, and
it deletes nothing. On its first run it leaves two shortcuts behind, so after
that the whole thing is `gwfix`, and `gwdoc` to look without changing
anything.

    bash ~/GWCFCRadar/pi/doctor.sh

`doctor.sh` only looks. It walks every feature's chain - packages installed,
timer registered, timer firing, files written, files served - and for each
break it prints the exact command that repairs it. It reads the last error
lines out of the journal too, so an empty feature says why it is empty rather
than only that it is.

## When the tunnel carries no traffic

    ~/wxenv/bin/python ~/GWCFCRadar/pi/tunnel_doctor.py

`fix.sh` runs this by itself whenever the address does not work, so it is
rarely typed. It exists because a tunnel that carries nothing has three quite
different causes that look identical from the browser, and the tell that
separates them is not an error message: it is the absence of one line.

cloudflared asks for its address over port 443, like any web page, and then
connects on port **7844**, which almost nothing else uses and home filtering
software blocks more often than any other port. When that happens cloudflared
is given a perfectly real address, never connects, prints no error at all,
and every request to that address gets an edge error. The Pi looks broken, is
not broken, and nothing done on the Pi will help. So the port is knocked on
directly, and a silent drop is told apart from a refusal.

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

## A tunnel address that stops changing

    bash ~/GWCFCRadar/pi/tunnel-permanent.sh pi.yourdomain.com

A quick tunnel is anonymous, which is why it is free and why it hands out a
new random hostname every restart. A named tunnel belongs to a Cloudflare
account and keeps its hostname for good. Also free, but it needs a domain on
that account, because the hostname has to be a name Cloudflare may answer for.

What to have first: a Cloudflare account, and a domain pointed at it. If you
own one already, move its nameservers in the Cloudflare dashboard. If not, the
cheapest are a few pounds a year and Cloudflare sells them at cost.

The script logs in, creates the tunnel, points the hostname at it, writes a
config that exposes port 8080 and refuses everything else, replaces the
gwcfc-tunnel service, and tells the site the address once. After that the
address survives reboots and power cuts, and nothing has to be republished.

## What it writes

    ~/wxdata/models/
      latest.json                  <- every model that has a finished run
      gfs/20260814_12/
        manifest.json              <- written last; its presence means "finished"
        t2m_f000.png  t2m_f003.png  ...
      nam/20260814_12/ ...
      hrrr/20260814_17/ ...

Thirteen models over twenty model and region combinations, each on its own
cadence, with `latest.json` listing whichever have a finished run:

    hrrr      3 km           to  +18h   hourly     CONUS, Alaska
    rtma      2.5 km         now only   hourly     CONUS
    rap       13 km          to  +21h   hourly     CONUS
    gfs       0.25 deg       to +120h   4x a day   CONUS, Tropics
    nam       12 km          to  +60h   4x a day   CONUS
    namnest   3 km           to  +60h   4x a day   CONUS, Alaska, Hawaii, PR
    nbm       2.5 km blend   to +120h   4x a day   CONUS
    gefs      0.5 deg mean   to +168h   4x a day   CONUS, Tropics
    gefsspr   0.5 deg spread to +168h   4x a day   CONUS
    gfswave   0.16 deg       to +120h   4x a day   Tropics
    ecmwf     0.25 deg       to +144h   2x a day   CONUS, Tropics
    hireswarw 5 km           to  +48h   2x a day   CONUS
    hireswfv3 5 km           to  +48h   2x a day   CONUS
    hireswarw2 5 km          to  +48h   2x a day   CONUS
    href      3 km ens       to  +48h   4x a day   CONUS
    rrfs      3 km           to  +18h   hourly     CONUS
    hrrrsub   3 km 15-min    to   +6h   hourly     CONUS
    ecmwfaifs 0.25 deg AI    to +144h   2x a day   CONUS, Tropics
    ecmwfens  0.25 deg ens   to +240h   2x a day   CONUS, Tropics

HREF is the convection allowing ensemble: HRRR, NAM Nest and the window models
run together and averaged. For "will a storm actually happen here" it beats any
single one of them, which is the blend's argument applied to tomorrow rather
than to next week.

ECMWF AIFS is their machine learned model, running beside the physical one and
on several measures beating it. Same files and same index, one word different
in the address.

    gem       0.24 deg       to +168h   2x a day   CONUS, Tropics
    icon      0.125 deg      to +120h   2x a day   CONUS, Tropics
    hafs      storm grid     to  +72h   4x a day   one per active storm
    hafsb     storm grid     to  +72h   4x a day   one per active storm

## Three that do not work like the rest

**GEM** and **ICON** publish one file per field per forecast hour with no index
beside it, so there is nothing to range-request and nothing to crop server
side. Each wanted field is its own request and they are glued together, which
is valid because GRIB is a sequence of self describing messages. A field that
is missing is skipped rather than failing the hour, since neither server
publishes everything at every step.

ICON is awkward twice over: every file is bz2 compressed, and the grid is
icosahedral, triangles on a sphere rather than rows and columns. The regridder
already handles a grid that is not rows and columns, because HRRR is not one
either, so that part came free.

**HAFS** is not published on a fixed domain at all. There is one run per active
storm, on a grid that follows it, and when nothing is out there it does not run.
So its regions are worked out at build time from the Hurricane Center's own
list, and are storms rather than places: `05l` is the fifth Atlantic storm of
the season, `03e` the third eastern Pacific one. The page writes those out.

When the tropics are quiet HAFS simply has no regions, builds nothing, and does
not appear. That is the correct behaviour rather than an error.

    hwrf      storm grid     to  +72h   4x a day   one per active storm
    hmon      storm grid     to  +72h   4x a day   one per active storm

## Radar, from the raw data

    ~/wxenv/bin/pip install metpy
    ~/wxenv/bin/python ~/GWCFCRadar/pi/radar_pipeline.py --check
    ~/wxenv/bin/python ~/GWCFCRadar/pi/radar_pipeline.py

The site shows radar as tiles somebody else rendered, which is fine until you
want a product they do not offer, a colour scale of your own, or a frame from
four minutes ago rather than whenever their cache turned over.

Level 2 is what the radar itself produces: every gate of every sweep, about
6 MB a volume and a new one every four to six minutes. Level 3 is what the
Weather Service makes from it, one product on a coarser grid, about 30 KB.
Both are free on public S3 buckets with no account and no key.

Only the lowest sweep is decoded. A volume holds a dozen elevations and a map
shows one, and the 0.5 degree scan is what radar means to almost everyone
looking at one.

A sweep is polar, a map is not, so each gate's position is worked out from its
azimuth and range with the beam tilt taken off the ground distance. The result
goes through the same regridder the models use: a radar sweep and a Lambert
model grid have nothing in common meteorologically and exactly one thing in
common here, which is that neither is rows of latitude and columns of
longitude.

    GWCFC_RADAR_SITES="KTLX KFWS KLOT"    which radars
    GWCFC_RADAR_FRAMES=6                  how many past volumes per run

Twelve frames per site are kept, which is about an hour of animation. Five
sites at two products is roughly 30 MB on disk.

Velocity gets its own colour ramp, and it is the one that has to be symmetric:
the number means towards the radar on one side of zero and away on the other,
and the thing worth seeing is the two sitting next to each other, which is
rotation. Green towards, red away, nothing at all at the middle, because a
colour at zero fills the map with air that is not moving.

## Cyclones, from DeepMind

    ~/wxenv/bin/python ~/GWCFCRadar/pi/cyclones_pipeline.py --check
    ~/wxenv/bin/python ~/GWCFCRadar/pi/cyclones_pipeline.py

Two different things arrive from WeatherLab, and neither is a model chart.

Tracks come as CSV: where each storm goes, one row per point, for every member
of an ensemble. Drawn as lines, which is the spaghetti plot people mean when
they say spaghetti plot, except from a model that has been beating the physical
ones at track error.

Cyclogenesis probability comes as NetCDF: a grid of how likely a storm is to
form where none exists yet. That is a genuinely different question from where
an existing one is going, and the harder half of a tropical forecast.

Five variants are published. OPER is what they run operationally, FNV3P0
through P2 are versions of the experimental model, and FNV3_LARGE_ENSEMBLE is
the same with far more members and the only one carrying genesis.

The CSV column names are not written down here and are not worth guessing at,
so each wanted value lists the spellings it might arrive under and the first
present wins. A file with none of them still parses, and `--check` prints the
header, so a missing spelling is a line to add rather than something to hunt.

The genesis grids are base64 inside gzip inside NetCDF, three wrappers each
there for a good reason on their side and simply in the way on ours. Read with
h5py, since NetCDF4 is HDF5 underneath and h5py is packaged for the Pi where
netCDF4 wants building:

    sudo apt install -y python3-h5py

## Finding out what else NOAA publishes

    ~/wxenv/bin/python ~/GWCFCRadar/pi/scan_sources.py --new

Every model here started as four strings written from memory, and several were
wrong in ways that look identical to the model not existing. The file server
has a plain directory listing, so this walks it: every model family NOAA
publishes, the newest dated directory inside, and a sample filename with the
forecast hour picked out ready to paste into MODELS.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/scan_sources.py hur

That one answers what HWRF and HMON are really called, which is the part of
those two most likely to be wrong.

    rrfssub   3 km 15-min    to   +6h   hourly     CONUS
    rrfsfire  3 km fire nest to  +36h   4x a day   moves with the fire
    gefswave  0.25 deg ens   to +120h   4x a day   Tropics
    ecmwfwave 0.25 deg       to +144h   2x a day   Tropics
    aqm       5 km           now only   4x a day   CONUS, air quality
    etss      surge grid     now only   4x a day   CONUS, storm surge
    hrdps     2.5 km         to  +48h   4x a day   CONUS
    rdps      10 km          to  +84h   4x a day   CONUS
    iconeu    0.0625 deg     to  +78h   4x a day   Europe
    icond2    2.2 km         to  +27h   8x a day   Germany

Air quality and storm surge brought three products with them. Ozone and fine
particulate are scaled to where the health advisories change rather than to the
range the data happens to span, so the colour changing means something. Surge
is water above the normal tide, which is the number that floods a coast: a
storm's wind is what it gets named for and this is what does most of the
damage.

    hireswnssl 5 km         to  +48h   2x a day   CONUS
    cmce      0.5 deg ens    to +240h   2x a day   CONUS, Tropics
    iconeps   0.25 deg ens   to +120h   2x a day   CONUS, Tropics
    ecmwfaifsens 0.25 deg AI to +240h   2x a day   CONUS, Tropics

CMCE is the Canadian ensemble, carried on NOAA's own server as half of NAEFS.
Worth having beside GEFS for the same reason two deterministic models beat one:
when two ensembles from different centres agree, that is a stronger statement
than either makes alone.

## Not carried, and why

    HRRRCast          a research server, not NOMADS
    NSSL MPAS-HTPO    a research server, not NOMADS
    NSSL MPAS-RN      the same, and down for everyone
    AI GFS, AI ICON   no public GRIB feed
    Hybrid GFS        no public GRIB feed
    REFS, NAVGEM      no public GRIB feed
    GSL MPAS-RRFSA    a research server, not NOMADS
    NSSL MPAS-RN3     a research server, not NOMADS
    UKMET, MOGREPS-G  the Met Office publishes these as NetCDF on AWS
                      rather than as GRIB, so they are a different reader
    SREF              on NOMADS, but every forecast hour is in one file,
                      which the per-hour design here cannot address

Free, but a different kind of work:

    RTOFS, GLO12      NetCDF rather than GRIB
    IOPS, DKSS        NetCDF rather than GRIB
    CFS, CanSIPS      seasonal: monthly means, not forecast hours
    SEAS5, SubC       the same, and behind a Copernicus account
    HYSPLIT-Dust      trajectories rather than a grid
    GEPS, REPS        Canadian ensembles, published as probabilities
    GDWPS, GEWPS      Canadian waves, addable the same way as HRDPS
    RDWPS, REWPS      the same
    GLWU              Great Lakes waves, on NOMADS, addable

Free only with an account and a key:

    AROME, ARPEGE     Meteo-France portal key
    MF-WAM, MF-WW3    the same key
    CAMS x3           Copernicus ADS key
    HARMONIE          differs per country, DMI and KNMI are not the same feed
    SILAM, IS4FIRES   national research feeds
    uEMEP, LOTOS      the same
    WRF-Chem, CHIMERE the same

The keyed ones are all possible. They need somewhere to keep a secret, which
nothing here has needed so far, and that is a decision rather than a line of
code.

## A model and a region, not two models

GFS over the tropics is not a different model from GFS. It is the same
forecast cut somewhere else, and having it in the list as "GFS Tropical" said
otherwise. So a model now declares the regions it is built for, and the page
offers the region beside the model rather than buried in its name.

    REGIONS = conus, tropics, alaska, hawaii, prico

A region contributes its box, and may override anything else the model says.
That covers both kinds of case at once: the tropical crop of GFS is the same
file with a longer reach and the shear field, while HRRR Alaska and the three
NAM nests are genuinely different files, so their region replaces the address
as well as the box. NOAA publishes the NAM nest as one model run over four
domains, and it is now carried that way rather than as four models.

Output is `models/<model>/<region>/<run>/`, and `latest.json` groups the
regions under the model.

The High Resolution Window pair, ARW and FV3, are worth having precisely
because they are not HRRR. When all three put a storm in the same place that is
worth more than any one model saying it twice.

Alaska, Hawaii and Puerto Rico each get their own box, because the main one
would crop them to nothing. Puerto Rico earns its place twice over: a populated
domain the CONUS box misses, sitting in the path of most Atlantic hurricanes.

## ECMWF, which does not work like the others

Generally the best global model there is, and free at 0.25 degrees since 2024.
It is fetched differently: there is no service to crop it, so the whole world
arrives and the box is cut out here after decoding.

What makes that affordable is the index file published beside each forecast
hour, giving a byte offset and length per field. Only the wanted fields are
requested, by range, and glued together. GRIB is a sequence of self describing
messages, so a handful of them concatenated is a valid GRIB file and the
decoder cannot tell. Measured on the index structure: about 0.2 percent of the
file for the fields this draws.

Adjacent ranges are merged, because several small requests over one connection
cost more in round trips than the few wasted bytes between them, but only when
they are genuinely close: merging across a large gap would download the gap.

A range request must come back 206. A 200 means the server ignored the range
and is sending the whole file, which would quietly turn a few megabytes into a
hundred, so that is treated as a failure rather than a slow success.

## The build has a time budget

    TIME_BUDGET_S = 40 * 60

With twenty models a bad afternoon at NOAA could otherwise run past the hour,
and the next run cannot start while this one holds the lock, so one slow build
would swallow the following one. After forty minutes no new model is started;
whatever is already built is kept and listed, and the rest are picked up next
time.

Anything that has never produced a picture is built first, whatever its place
in the list, and is allowed three hours rather than forty minutes. The budget
exists to protect the hourly rhythm, and a first build has no rhythm to
protect: nothing is on the map yet, and stopping after forty minutes leaves
most of the list missing until several more hours have gone by. Only the hourly
refreshing of models that already have a picture is held to the shorter figure. Without that the tail starves: the hourly models come first by
design, they rebuild every hour, and they are the expensive ones, so they would
take the budget every single time and a model at the end would never get built
at all. From the outside that looks like a site showing the first six models
and never the other seven, no matter how long you leave it.

After that, `DEFAULT_MODELS` order decides, so what gets dropped is long range
material nobody minds being an hour old. Models named on the command line
ignore the budget: asking for one by name means meaning it.

Among the never-built ones the cheap go first, using the megabytes per forecast
hour that check_models.py measured. A cold start otherwise spends twenty
minutes on the single most expensive model before anything at all reaches the
site, which looks like nothing is happening. Cheapest first puts nine of the
twenty on the map for seven percent of the bytes and lets the big ones fill in
behind.

`latest.json` is written before anything is built and again after every model,
never only at the end. The site reads that file and nothing else, so while it
is absent there is no map at all: after a reset the whole thing is missing
until the first model finishes. It is also filled in from whatever is on disk
rather than only from what this run reached, so a model never disappears from
the site between runs.

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

## The tropical ones are cropped somewhere else

The main box stops at 20 north, which is north of almost everywhere Atlantic
storms form. The main development region runs roughly 10 to 20 north between
Africa and the Caribbean, so a chart cropped to the United States shows a
hurricane only once it is nearly ashore. The tropical box reaches from the
equator to 45 north and from the central Pacific to west Africa, holding both
basins the Hurricane Center forecasts, the Gulf, the Caribbean, and the wave
that is going to be next week's storm.

A tropical chart is also not a CONUS chart moved south. Different questions get
asked, so different fields are built:

    pwat    all the water vapour in the column, as the depth of rain it would
            make. A storm moving into dry air weakens whatever else is in its
            favour, so this is the first thing to look at.
    shear   how much the wind changes between 850 and 200 mb. About 20 knots is
            enough to tear a storm apart. No model publishes this, so it is
            worked out from the four component fields.
    sst     sea temperature. A hurricane runs on warm water and needs about
            26 C to keep going, so the scale is narrow and centred there
            instead of running from freezing.
    gust    the number that takes the roof off, as opposed to the sustained
            wind the storm is named for.
    swh     wave height, and `perpw` wave period. Swell reaches a coast days
            ahead of the storm that made it, while the sky is still clear.

Shear is the length of the difference between the two wind vectors, not the
difference between the two speeds. Those are not the same thing, and the
distinction is the point: 40 knots at both levels blowing in opposite
directions is 80 knots of shear and shreds a storm, where subtracting the
speeds would call it zero and say the storm was fine.

The shear levels are fetched only by models that build the field. Asking every
model for 200 and 850 mb would be paying for data nothing draws.

NBM is taken four times a day rather than the hourly it publishes at. It is a
five day blend and does not meaningfully change in an hour, so fetching 41
forecast hours of 2.5 km data every hour would be by far the largest thing here
in exchange for almost nothing.

## How a model is fetched, and why it matters

Two ways, chosen per model.

**By filter** is the original: NOAA's service takes a list of variables and a
list of levels, crops to the box and sends the result. Cropping is the whole
win for a global model, so GFS, GEFS and the wave model still use it.

The catch is that the service takes those two lists as a **cross product**.
Asking HRRR for 11 variables at 5 levels returns up to 55 messages to draw 7
fields. Measured: 26 MB per forecast hour, just under 12 GB a day, about two
thirds of it thrown away on arrival.

**By range** names the messages instead. The index beside each file gives a
byte offset per message, so the wanted ones are asked for by range and glued
together, since GRIB is a sequence of self describing messages and a handful
concatenated is a valid file. No cross product, and no filter service at all,
which matters because that service is a separate program per model with names
that are not guessable: three models were failing on a 404 from it while their
data sat on the file server perfectly reachable.

Regional models use it, because their own domain is already about the size of
the box and cropping was buying them almost nothing.

    measured, per forecast hour
    HRRR by filter .......... 26.2 MB
    HRRR by range, 9 fields .. 10.8 MB
    HRRR by range, 6 fields ... 7.2 MB

A model may also name the fields it carries. HRRR does, because hourly at 3 km
makes it the largest line on the bill by a factor of three, and nobody opens
HRRR to read a dewpoint. It carries reflectivity, temperature, wind, gust,
precipitation and CAPE, and leaves the rest to coarse models that cost almost
nothing.

Measured on the Pi across all twenty combinations: about 8.9 GB a day, down
from 17.2. The fine models are most of what is left, which is why they are the
ones that name their fields.

## Grids that are not latitude and longitude

HRRR, RAP, NAM and every nest are on a Lambert Conformal grid. The rows are
not lines of latitude and the columns are not lines of longitude, they are
straight lines on a cone wrapped around the earth.

Reading only the first and last corner and assuming even spacing between them,
which is what this used to do, puts the picture in roughly the right part of
the world and wrong everywhere inside it. On a test grid the top row came out
at 25 N when it was really 55 N.

So for those the real coordinate of every point is read and the values are
dropped into whichever cell of a plain latitude and longitude mesh they land
in, averaging where several land in one and leaving a gap where none do. Worst
placement error on the test grid afterwards: 0.09 degrees, about 10 km, which
is three pixels at the size these are drawn.

The bounds written into the manifest now come from the data in every case
rather than from the box that was asked for. A grid has a spacing, the edges
land on the nearest cell, and stretching a picture into a rectangle it does
not fill is how everything in it ends up displaced.

## Check a model before trusting it

    ~/wxenv/bin/python ~/GWCFCRadar/pi/check_models.py

A model is four strings, and a wrong one fails in a way that looks like the
model not existing: the request comes back 500 and the run is skipped. This
finds the current cycle, confirms the file is on the server, reads NOAA's index
to see which wanted fields are in it, and downloads one forecast hour to
measure the real cost. It names which of the four strings is wrong, and it does
it in about a minute rather than after a build. Run it after adding a model,
and after NOAA reorganises anything.

When a path fails it now prints the HTTP status, since a 404 is a wrong
address and a 403 is being refused and those need opposite fixes, and then
asks the server what that directory really contains. A 404 on its own is still
a guess.

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

Fields: `t2m`, `d2m`, `mslp`, `cape`, `refc`, `apcp`, `wind`, `gust`, and on
the tropical models `pwat`, `shear`, `sst`, `swh`, `perpw`. A model only builds
the ones its source actually contains, and only those appear in the manifest,
so the page offers exactly what exists.

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
