# Cinematic Zoom

Fly from orbit to anywhere on Earth, and record it.

Pick a place, pick a shot, press start. The camera falls twenty thousand
kilometres onto a landmark on Google's photorealistic 3D tiles, lit by a sun
placed where the light actually looks good, and hands you an MP4.

Built on the three.js [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS)
example by Garrett Johnson, streaming the tiles through
[Cesium Ion](https://cesium.com/platform/cesium-ion/), with
[@takram/three-geospatial](https://github.com/takram-design-engineering/three-geospatial)
for the atmosphere and clouds.

## Running it

```bash
pnpm install
pnpm dev
```

Needs Node 22.12+ and a browser with WebGL 2 — without it the app says so instead
of booting. Recording additionally needs WebCodecs with a hardware video
encoder; where that is missing the flights still fly and only the export fails,
with a message rather than silently.

`pnpm install` also vendors the atmosphere and cloud binaries into `public/`,
because the upstream packages otherwise fetch them from a GitHub LFS URL at
runtime, and a slow fetch there does not fail loudly — it just quietly produces
a sky with no clouds.

The globe needs a 3D Tiles key. The token in the three.js example is registered
to threejs.org and returns 403 anywhere else, so on first run the app asks for
one — a free [Cesium Ion](https://ion.cesium.com/tokens) token, or a Google Maps
Platform key with the Map Tiles API enabled. It is stored in the browser.

To avoid the prompt in local development, copy `.env.example` to `.env.local`:

```bash
VITE_ION_TOKEN=your-token-here
```

`?ion=…` or `?google=…` in the URL also works.

## Four buttons

Everything sits in one bar at the bottom. **Light** and **Length** cycle to the
next option; **Place** and **Shot** open lists. Hovering a place turns the globe
to it, so you choose by looking rather than by reading. Leave without clicking
and it swings back.

| Button | |
|---|---|
| **Place** | Seventeen landmarks and [one conference](#threejs-conf-paris), or type a name, a coordinate pair (`48.8582, 2.2945`), a DMS pair, or paste a link from any map ([below](#pasting-a-map-link)). Defaults to Threejs Conf Paris. |
| **Shot** | Dive · Descent · Orbit · Flyby · Hyperzoom |
| **Light** | Golden · Contre-jour · Morning · Noon · Last light · Cross light |
| **Length** | 7s · 10s · 15s · 20s |

Then **Start**. Arm **REC** first and it becomes **Record**.

The five moves differ in more than speed: each channel of the camera (distance,
bearing, pitch, lens, roll) runs on its own curve, which is most of what
separates a shot from an interpolation.

| | |
|---|---|
| **Dive** | Hangs high, plunges, pulls up at the last moment |
| **Descent** | A long fall out of orbit at a steady zoom rate, settling into a drift |
| **Orbit** | Drops hard through the first half, then circles the subject |
| **Flyby** | Comes in low and fast, overshoots, banks back around |
| **Hyperzoom** | Barely moves. The lens does all the work — 62° down to 11° |

The recording settings, and the moment the sun was solved for, are behind the
gear, top right.

## Threejs Conf Paris

One entry in the list is not a landmark. **Threejs Conf Paris** sits at the head
of it under the conference's own wordmark — which stands in for the name rather
than sitting next to it, since it already says it — and flies to the Maison de
la Chimie: 48.8603° N, 2.3166° E, the centroid of the building's footprint
rather than its door on rue Saint-Dominique, because the hall sits back behind
the street wall and orbiting the door frames the neighbour.

Land there and a card arrives over the roof: the name, **10 & 11 Sept 2026**,
and a link to [threejs.paris](https://threejs.paris). It is pinned to the
building rather than to the frame, so it holds through the slow orbit that
closes every flight and keeps holding if you take the camera yourself — and it
goes when the venue does, whether that is round the back of the planet or simply
out of shot.

It is a DOM overlay, so it is not in the export. The recording is the flight.

Everything it needs is a `featured` block on the landmark, so a second event is
a second entry, not a second code path.

## Pasting a map link

Open **Place** and paste into the search box, or into either coordinate field.
The link is read on the spot — no Enter, no API, no network call — and the
coordinate it produces is shown back to you before the flight.

| | |
|---|---|
| **Google Maps** | `/maps/@lat,lon,17z`, `/maps/place/…!3d…!4d…`, `?q=`, `?ll=`, `api=1&query=`, embeds, Street View, Google Earth |
| **Apple Maps** | `?ll=`, `?coordinate=`, `?daddr=` |
| **OpenStreetMap** | `#map=17/lat/lon`, `?mlat=&mlon=`, and `osm.org/go/…` short links |
| **Bing · Waze · HERE · Mapy** | `cp=lat~lon`, `ll.lat,lon`, `map=lat,lon,z`, `x=&y=` |
| **Yandex · 2GIS** | `ll=` and `m=`, longitude first, as those two write it |
| **Any slippy map** | a `#15/lat/lon` hash — geojson.io, Felt, kepler.gl, Mapbox and MapLibre demos |
| **Anything else** | a `lat=`/`lng=` pair, or a `ll=`-style parameter, in any URL |
| **Not links** | `geo:` URIs, Plus Codes (`8FW4V75V+8Q`), `geohash:u09tunquc`, DMS |

Google's place links carry two coordinates — the `@` is where the map was
looking, the `!3d…!4d…` in the data blob is the pin. They can sit a street
apart when the map was panned before sharing, so the pin wins.

Three things can't be resolved without somebody's API, and say so rather than
failing quietly: shortened links (`maps.app.goo.gl`, `bit.ly`), what3words
addresses, and short Plus Codes, which are relative to a town name. Open a
short link first and paste where it lands.

## What it does that a naive version would not

**The subject is never in the dark.** Pick a light preset and the app solves for
a moment in the year when the sun over that coordinate is at exactly that
elevation — then checks its answer against the ephemeris the shaders actually
use and corrects it. At 78° north and 78° south alike, elevation is hit to a
hundredth of a degree. Where the requested elevation is unreachable, it returns
the brightest achievable moment rather than a plausible-looking midnight.

**The sun's direction drives the camera, not the other way round.** A given
(elevation, azimuth) pair is usually unreachable at a latitude, while any
elevation the sun visits there is reachable from *some* direction. So elevation
is solved exactly and the camera's final bearing is derived from it, placing the
sun at the angle off the lens axis the preset asks for — 46° for a rim-lit
golden hour, 13° to shoot into it, 92° for pure cross light.

**Exposure is measured, not guessed.** A white desert under a high sun and a
harbour in shadow are several stops apart, and one flight crosses that range on
its own: at a couple of hundred kilometres the view looks down through the whole
atmospheric column and the forward scattering outshines both the planet above
and the city below. Before each flight the shot is sampled at five times, each
solved for the multiplier that lands it on a cinematic mid-tone, and smoothed
into a curve. It happens inside a single task, so none of the probe frames ever
reaches the screen.

**Distance is interpolated geometrically.** What reads as a constant zoom rate is
a constant rate of change of *log* distance. Linear interpolation over four
decades reads as a stall followed by a slam.

**The camera rig has no singularity.** Shots that look straight down at the
subject are exactly where `lookAt` degenerates. The basis is built analytically
from the orbit parameters instead, so it stays continuous through 90° of pitch —
verified at 0.0000° of aim error and unit determinant across the range.

**Recording is frame-locked.** The flight is re-run on a virtual clock: the world
is seeked to frame N, the tile pipeline is given time to catch up, the frame is
rendered and handed straight to a hardware H.264 encoder. The export is smooth at
exactly the requested frame rate no matter how long any individual frame took,
and every frame gets the geometry it deserves instead of whatever had streamed in
by the time the clock reached it. Expect it to run slower than real time — the
`REC` readout shows shot time and the ratio.

## Settings

Behind the gear, and deliberately short. The look is what the light and shot
presets are *for*, and a panel of sliders next to them is an invitation to
undo them.

| | |
|---|---|
| **Light** | The moment the daylight solve landed on, read back — the date, and the elevation it actually hit. On a polar coordinate this is where you find out the elevation was unreachable. |
| **Atmosphere** | Cloud shadows, off by default. |
| **Recording** | Resolution, frame rate, aspect, and how long to let tiles settle per frame. |

The letterbox in the preview is the export frame, not decoration — change the
aspect and the matte follows.

The rest is live on the console instead, where nobody reaches for it by
accident:

```js
cinematicWorld.world.exposureBias = -0.5      // stops, on top of the metering
cinematicWorld.world.handheld = 0             // kill the camera drift
cinematicWorld.world.tuneLight( { coverage: 0.6, flare: 0.04 } )
cinematicWorld.world.setFraming( { orbitRadius: 900, lookAtHeight: 120 } )
```

## Keyboard

`Space` start or abort · `Esc` back out · `P` `S` `L` `T` cycle place / shot /
light / time · `←` `→` previous / next place · `R` arm the recorder ·
`H` hide the interface · `F` fullscreen · `?` shortcuts

After a flight lands, drag to look around.

## Notes on the data

Every landmark was rendered at its landing frame and looked at. A few candidates
were cut on that evidence: Teotihuacán is draped terrain, downtown Dubai has no
building geometry at all, and neither Hagia Sophia nor Christ the Redeemer
exists as mesh. Machu Picchu is the same draped-terrain class — kept anyway,
marked `moderate`. Google's coverage is also thin or absent over China, India
and Russia, so nothing from there is included.

Heights are ellipsoidal, which matters more than it sounds: New York, San
Francisco and Dubai all sit around thirty metres *below* the WGS84 ellipsoid, and
using the orthometric height alone buries the camera underground.

## Layout

```
src/
  main.js                 wiring: UI ↔ world ↔ recorder
  sun.js                  solar position, the daylight solve, light presets
  assets.js               local-first asset resolution
  tilesAuth.js            Cesium Ion / Google Maps key resolution
  camera/
    Rig.js                geographic camera rig, singularity-free
    shots.js              the five moves
    easing.js             curves
  world/
    World.js              renderer, tiles, atmosphere, clouds, the loop
    EffectAdapter.js      pmndrs postprocessing → renderer.setEffects()
  record/Recorder.js      frame-locked WebCodecs capture
  data/landmarks.js       the seventeen and the conference, plus text-to-target
  data/mapLinks.js        pasted map links and codes → lat/lon, offline
  ui/UI.js                all of the DOM
  ui/Venue.js             the conference mark, and its card over the venue
scripts/copy-assets.mjs   vendors the atmosphere and cloud binaries into public/
```

`three` is pinned to `0.185.1` on purpose: in later builds the output render
target lost its depth texture, and the atmosphere reconstructs world position
from depth. It fails silently.

[AGENTS.md](AGENTS.md) has the rest — the flight's control flow, the decisions
that are load-bearing, and how to add a landmark, a shot or a light preset.

## Building

```bash
pnpm build                    # -> dist/, without local tile credentials
pnpm preview                  # serve it
```

`dist/` is static and can go on any host. If you deploy it somewhere other than
the domain root, set Vite's `base` — the asset paths in `src/assets.js` are built
from `import.meta.env.BASE_URL`.

The normal build deliberately ignores `VITE_ION_TOKEN` and
`VITE_GOOGLE_API_KEY`, including values in `.env.local`, so local credentials do
not leak into a deployment. By default the app asks each visitor for their own
key and stores it in their browser.

If a deployment intentionally supplies its own referrer-restricted key, opt in
explicitly with `pnpm build:with-credentials`. That command embeds the key in
the JavaScript in plain text; apply origin restrictions, minimal scope, and a
quota before publishing it.

## Contributing

Issues and pull requests are welcome. There is no linter; match the surrounding
style, which is three.js house style (tabs, and a space inside every bracket) —
see the end of [AGENTS.md](AGENTS.md).

New landmarks need to have been *looked at*: fly there, check the mesh is real
geometry rather than draped imagery, and record the verdict in `coverage`.

## Credits

- [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) by NASA-AMMOS — the tile pipeline, and the example this grew out of
- [@takram/three-geospatial](https://github.com/takram-design-engineering/three-geospatial) by Takram — precomputed atmospheric scattering, volumetric clouds, lens flare
- [postprocessing](https://github.com/pmndrs/postprocessing) by pmndrs
- [mediabunny](https://github.com/Vanilagy/mediabunny) — the WebCodecs muxer
- Google Photorealistic 3D Tiles, served through Cesium Ion or the Map Tiles API

Tiles are subject to [Google's terms](https://cloud.google.com/maps-platform/terms),
which govern what you may do with what you record. The attribution string the
tile renderer supplies must stay visible if you redistribute the imagery.

## License

[MIT](LICENSE) © David Ronai ([@makio64](https://github.com/Makio64))

The licence covers this source. It does not cover the map tiles, which are
Google's, or the sky assets vendored from the takram packages, which carry their
own licences. Runtime dependency details are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); every production build also
includes that notice and the complete license texts.
