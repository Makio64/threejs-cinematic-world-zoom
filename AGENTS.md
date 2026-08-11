# Working on this codebase

A three.js app that flies a camera from orbit onto a landmark on Google's
photorealistic 3D tiles and records the flight to MP4. Read the
[README](README.md) first for what it does; this file is how it is built.

No framework, no build step beyond Vite, no state library. Plain ES modules,
plain DOM.

## Commands

```bash
pnpm install          # also vendors the sky binaries into public/assets
pnpm dev              # vite on :5180
pnpm build            # -> dist/
pnpm assets           # re-vendor public/assets by hand
```

There is no test suite and no linter. Verify by running it: the flight is the
test, and `world.seek( t )` will step it without a clock (see *Verifying a
change*).

## Layout

```
src/
  main.js                 wiring only: UI ↔ world ↔ recorder. No logic.
  sun.js                  NOAA solar position, the daylight solve, light presets
  assets.js               local-first asset resolution, CDN fallback
  tilesAuth.js            Cesium Ion / Google Maps key resolution + verification
  camera/
    Rig.js                geographic camera rig, singularity-free
    shots.js              the five moves
    easing.js             curves
  world/
    World.js              renderer, tiles, atmosphere, clouds, the loop
    EffectAdapter.js      pmndrs postprocessing → renderer.setEffects()
    TileCreasedNormalsPlugin.js  local three addon — minify-safe worker alias
  record/Recorder.js      frame-locked WebCodecs capture
  data/landmarks.js       the landmark table, plus text → target
  data/mapLinks.js        pasted map links and codes → lat/lon, offline
  ui/UI.js                all of the DOM
  ui/Venue.js             the conference mark, and its card over the venue
scripts/copy-assets.mjs   vendors the atmosphere and cloud binaries into public/
```

## How a flight works

```
UI.on.go
  └─ main.launch()
       ├─ world.prepareShot()      solve the sun → derive the end bearing →
       │                           build the shot sampler
       ├─ world.preroll()          ease to the top of the shot while tiles stream
       ├─ world.settle()           pump the tile pipeline until quiet
       ├─ world.autoExpose()       meter 5 points, build an exposure curve
       └─ world.play()             state = 'flying'; the rAF loop samples the
                                   shot by shotTime and applies it to the rig
```

Recording replaces the last three steps with `Recorder.record()`, which drives
`world.seek( frame / fps )` + `world.render()` itself on a virtual clock.

The state machine is `idle → loading → flying → done → free`, and `returnToIdle`
from any of them. `free` is the only state where the user owns the camera; there
the rig reads the camera back instead of driving it.

## The load-bearing decisions

Change these only on purpose.

**`three` is pinned to `0.185.1`.** Later builds lost the depth texture on the
output render target, and the atmosphere reconstructs world position from depth.
It fails silently — the sky just goes wrong.

**Two upstream shaders are patched at runtime**, in `patchSkyRayMiss` and
`patchStarDepth` at the bottom of `World.js`. Both patch *source strings*, not
compiled programs, because `postprocessing` reassembles an effect's material
whenever the pass updates. Both return whether the match succeeded, and
`_applyAltitudeLook` has a fallback for the sky one. If a takram upgrade
rewrites those functions the console says so — do not let it fail quietly.

**Distance is always interpolated geometrically** (`mixLog`), never linearly.
Over four decades a linear interpolation reads as a stall followed by a slam.

**The camera basis is built analytically, not with `lookAt`.** The interesting
shots point straight down, which is exactly where `lookAt` degenerates. See the
header of `Rig.js`.

**Azimuth is derived from the sun, not chosen.** A given (elevation, azimuth)
pair is usually unreachable at a latitude; any elevation the sun visits there is
reachable from *some* direction. So `sun.js` solves elevation exactly and the
camera's final bearing falls out of the preset's `gamma`.

**The bearing is held north-up while the Earth is still a globe**, then released
over all the time that is left. `createShot` solves the `t` at which the shot
crosses `NORTH_HOLD_DISTANCE` and multiplies the authored azimuth progress by a
gate delayed to there. The hold is keyed to *distance* because `t` does not know
how high the camera is — the same t=0.2 is 5 000 km into a descent and 200 km
into an orbit. The release is keyed to *time* because the suppressed sweep has to
be given back somewhere, and handing it back over a second distance band spends
it crossing a few hundred kilometres: a whip pan, measured at 0.8-1.3 frame
widths a second, high up where there is nothing to whip past. Multiplying rather
than overlaying a counter-turn is what keeps the sweep from reversing mid shot;
the gate is exactly 1 with slope 0 at t=1, so the landing bearing and the exit
rate both survive.

**Shots end with live rates, and the landing carries them.** Do not "fix" a
non-zero terminal rate — it is the hand-off. `shot.settle( baseTime )` reads the
exit rate of every channel and relaxes it, azimuth easing into a perpetual
cruise and the rest coming to rest, so arriving reads as the flight settling
rather than as the film stopping. Excursions are bounded by *shortening the time
constant*, never by clamping the accumulated value: a clamp on the span puts a
hard rate kink about half a second into every aborted landing.

**Heights are ellipsoidal.** `landmarks.js` stores orthometric `groundH` plus the
geoid undulation `geoidN`, and the rig wants the sum. New York, San Francisco
and Dubai sit ~30 m *below* the WGS84 ellipsoid; using `groundH` alone buries the
camera underground.

**`UpdateOnChangePlugin` is deliberately not registered.** The camera moves every
frame of a flight, so it never saves work, and it breaks the pump-until-settled
loop the recorder depends on.

**The renderer comes up before the credential does.** Setup is answered over the
globe rather than over black, so `boot()` initializes the world whether or not
the key verified. Without one, `_initTiles` registers no auth plugin — the
tileset then has no URL — and `_updateTiles` returns before pumping, so nothing
reaches the tile service until `reauthorize()` hands it a token that passed
`verifyTileAuth`. The gate is still real: `launch()` refuses, and the modal is
inert over everything else. A first visit and a rejected key take the same path
through `onKeyEntered`.

**`TilesFadePlugin` runs on the shot's clock, not the wall's.** Everything goes
through `World._updateTiles( dt )`, which backdates the fade manager's
`_lastTick` before pumping the tiles. Upstream steps its crossfades off
`performance.now()`, which would collapse every fade into a single frame of a
recording — a recorded frame takes far longer to render than it lasts — and run
them out during `settle()`, which pumps for seconds while the shot stands still.
`seek()` treats a negative step or a jump past `FADE_CUT_STEP` as a cut;
the live loop only clamps to `FADE_MAX_STEP` so a tile-parse hitch cannot
abort every in-flight crossfade. `maximumFadeOutTiles` is `Infinity` for the
same reason the plugin is here at all: see the comment in `_initTiles`.

**Exposure metering happens inside a single task.** `autoExpose()` renders and
reads back probe frames synchronously so none of them reaches the screen. Do not
`await` inside that loop.

**The recorder owns the render loop while capturing.** `world.stop()` first —
two loops fighting over the drawing buffer produces torn frames. Nothing may
`await` between `world.render()` and `source.add()`, or the buffer is already
cleared.

**Every shot channel is a pure function of `t`.** That is what makes the
frame-locked recording possible. Do not introduce per-frame state into a shot.

## Recipes

**A new landmark** — one entry in `LANDMARKS` in `data/landmarks.js`. Required:
`id`, `name`, `place`, `country`, `cat` (emoji), `lat`, `lon`, `groundH`,
`geoidN`, `lookAtHeight`, `orbitRadius`, `orbitPitch`. Then fly it and look at
it: Google's mesh is missing or draped-terrain in more places than you would
expect, and `coverage` records the verdict.

**A new shot** — one entry in `SHOTS` in `camera/shots.js`. Give each channel
(`distance`, `pitch`, `azimuth`, `fov`, `roll`, optional `yaw`/`tilt`) its own
curve; that offset between channels is what makes a move read as authored. Use
`smoothTrack` for multi-beat moves — it passes interior keys at speed, where
`track` stalls at every key.

**A new light preset** — one entry in `LIGHT_PRESETS` in `sun.js`. `gamma` is the
angle between sun and lens axis at the camera: 0 shoots into it, 90 is cross
light. Add `pitchScale` below 1 if the preset needs the horizon in frame.

**A new settings control** — add the input to `index.html`, a `bind()` line in
`UI._bindAdvanced`, and a case in `onAdvanced` in `main.js`. Most of the look is
deliberately *not* exposed; it lives on `world` for the console instead
(`exposureBias`, `handheld`, `cloudShadows`, `tuneLight()`, `setFraming()`).

## Verifying a change

`window.cinematicWorld` exposes `{ world, ui, venue, recorder, LANDMARK_MAP }`.

To exercise a whole flight without waiting for it — and without depending on
`requestAnimationFrame`, which is paused in a background tab:

```js
const w = cinematicWorld.world
for ( let i = 0; i <= 10; i ++ ) {
	w.seek( i / 10 * w.shot.duration )
	console.log( i, Math.round( w.rig.altitude ), w.rig.state.pitch * 57.3 )
}
```

Worth asserting after a rig or shot change: nothing is `NaN`, altitude never
drops below `rig.minHeight`, and `camera.quaternion` stays unit length.

## Style

three.js house style (`eslint-config-mdcs`), enforced by eye rather than by a
linter:

- tabs for indentation
- a space inside every bracket: `foo( a, b )`, `arr[ i ]`, `{ a: 1 }`
- a blank line after an opening `{` of a function/block body, and before the
  closing `}`
- `! value`, not `!value`
- no semicolons
- `_privateMethod` by convention; there are no `#private` fields

Comments explain *why*, and are worth their length when the reason is not
recoverable from the code — most of the ones here document a decision that has a
plausible-looking wrong alternative. Do not add comments that restate the line
below them.
