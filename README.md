# GWCFCRadar

A free weather site that runs in a browser:
**https://ralphhtml.github.io/GWCFCRadar/**

Radar, satellite, alerts, lightning, tropical guidance and 45 forecast model
and region combinations. No account, nothing to install.

## Folders

    index.html    the whole site, in one file
    sw.js         service worker, for notifications and offline use
    studio.html   the cyclone track editor

    assets/       images, audio and data the page loads
    icons/        app icons and notification badges

    pi/           the Raspberry Pi pipelines: models, radar, cyclones
    services/     the parts deployed elsewhere
                    bot/          Discord bot
                    chat-bridge/  Discord messages onto the live chat
                    discord-auth/ Discord sign-in
                    worker/       fetches raw radar volumes
    firebase/     Firestore security rules
    tools/        checks that run without a browser
    archive/      kept for reference, unused

`index.html` and `sw.js` stay at the top level. Pages serves the first as the
site, and a service worker only controls the folder it sits in, so moving it
would shrink its reach to nothing.

## How it works

Most layers are fetched straight from the agencies by the browser. Level 2
radar is decoded in the browser too, from one station at a time.

Forecast models are too big for that, so a Raspberry Pi at home downloads only
the bytes it needs from NOAA, renders them to PNGs, and serves them through a
Cloudflare tunnel. It publishes its own address, so nothing needs pasting after
a reboot. See `pi/README.md`.

No WebGL is used anywhere, on purpose. The PlayStation 5 browser does not have
it, and people open this on one.

## Checks

    node tools/test-models.js               # model panel, against a fake Pi
    node services/bot/test-map-command.mjs  # the bot's /map command
    python3 pi/check_models.py              # every model address, against NOAA
    python3 pi/radar_pipeline.py --check    # both radar levels, per site

The first two need no network and take a second.
