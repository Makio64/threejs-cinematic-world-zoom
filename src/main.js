import { World } from './world/World.js'
import { UI } from './ui/UI.js'
import { Venue } from './ui/Venue.js'
import { Recorder, captureSize, downloadRecording } from './record/Recorder.js'
import { LANDMARK_MAP } from './data/landmarks.js'
import {
	awaitRootTilesAuth, classifyKey, interpretTileError, rememberTileAuth,
	resolveTileAuth, verifyTileAuth,
} from './tilesAuth.js'

const canvas = document.getElementById( 'view' )
const ui = new UI()
const world = new World( canvas )
const recorder = new Recorder( world )
// after the UI, which is what builds the place list it decorates
const venue = new Venue( world )

// No credential: the renderer still comes up, with the tile pipeline held (see
// World._initTiles), so setup is answered over the globe rather than over black.
const NO_AUTH = { kind: 'ion', key: '', source: 'none' }

let currentTarget = null
let pendingLaunch = false
let launchAbort = null
let checkingKey = false
let authReady = false
let tileAuthComplaint = false
// A root load already in flight. Start pressed during it is a user who pasted
// four seconds ago, not one who has no key — see launch().
let verifying = false
// Resolves true once the renderer is up. A token pasted while the atmosphere is
// still precomputing has to wait for it before it can reauthorize anything.
let worldReady = null

boot()

async function boot() {

	// Probe a disposable canvas. Calling getContext() on the real canvas would
	// create it before WebGLRenderer can request its own context attributes.
	if ( ! document.createElement( 'canvas' ).getContext( 'webgl2' ) ) {

		ui.boot( 'This browser has no WebGL 2' )
		return

	}

	const auth = resolveTileAuth()
	const check = await verifyTileAuth( auth )

	// Ask before initializing, not after: the card is on screen while the
	// scattering tables and cloud volumes are still being built, and the globe
	// fades in behind it. Setup stays a real gate — nothing reaches the tile
	// service, and launch() refuses, until a token has verified.
	// Who gets walked through where a key comes from, and who goes straight to
	// the field. `source` answers it, and `key` does not: only `stored` proves
	// this browser once had a key of its own that worked — rememberTileAuth
	// writes it after the live root confirms — and `env` is the build's own, so
	// whoever built it knows. A `?ion=` link is someone else's key, handed over;
	// when it fails the person holding it is starting from nothing, and gets the
	// full two screens with the reason on the first one.
	ui.on.key = onKeyEntered
	if ( ! check.ok ) {

		const known = auth.source === 'stored' || auth.source === 'env'
		ui.askForKey( auth.key ? check.reason : '', {
			invalid: Boolean( auth.key ),
			quota: Boolean( check.quota ),
			stage: known ? 'paste' : 'get',
		} )

	}

	worldReady = world
		.init( { onProgress: text => ui.boot( text ), auth: check.ok ? auth : NO_AUTH } )
		.then( () => true, error => {

			console.error( error )
			ui.boot( 'Could not start the renderer' )
			// the boot line is hidden under the setup card, so a first visit
			// that fails here would otherwise show a form and no reason
			ui.keyNotice( 'The 3D view could not start in this browser.', { invalid: true } )
			return false

		} )
	if ( ! await worldReady ) return

	world.onStateChange = onWorldState
	world.onFrame = onWorldFrame
	// Ion's endpoint can stay green while Google's root returns 429 — that is
	// caught by awaitRootTilesAuth / onTileError, not by verifyTileAuth.
	world.onTileError = onTileError
	wireUI()

	// Last place the user picked, or the conference the first time.
	ui.restoreLastPlace()

	window.addEventListener( 'resize', onResize )
	onResize()

	world.start()
	// Without a key there is no root load to confirm; the prompt is already up,
	// and onKeyEntered picks the confirmation up from there.
	if ( check.ok ) await confirmLiveTileAuth( auth, ui.keyGen )
	ui.bootDone()
	ui.setState( 'idle' )

}

/**
 * Google root requests are billable and uncacheable. The credential has already
 * been checked by the time it gets here; confirm it against the renderer's
 * single root load instead of probing root.json again. Only a credential that
 * survives this is remembered.
 */
async function confirmLiveTileAuth( auth, gen ) {

	verifying = true
	let live
	try {

		live = await awaitRootTilesAuth( world.tiles )

	} finally {

		verifying = false

	}

	if ( ! live.ok ) {

		authReady = false
		// the card is about to say it; leave the latch open so a leaf 403 in the
		// same breath does not write a second message over the first
		tileAuthComplaint = false
		ui.askForKey( live.reason, { invalid: true, quota: Boolean( live.quota ) } )
		return false

	}

	if ( auth.source === 'url' || auth.source === 'user' ) rememberTileAuth( auth )
	authReady = true
	ui.keyAccepted( gen )
	ui.status( '' )

	// Once the globe under the target has resolved, take the real ground height
	// off the mesh — the preset table is only good to a few metres, and a pasted
	// coordinate has no table at all.
	world.settle( { maxWaitMs: 25000 } ).then( () => probeGround() )
	return true

}

/**
 * The one path a typed token takes, on the first visit and on every later
 * rejection alike: verify it, hand it to the renderer, then confirm it against
 * the live root load.
 */
function onKeyEntered( raw ) {

	verifyEnteredKey( raw, async candidate => {

		tileAuthComplaint = false
		// Dismiss first: the check below waits on the root tileset, which is a
		// long time to hold a card that has already been answered. Carry the
		// generation so a success that lands after a *later* failure reopened
		// setup cannot close that one too.
		const gen = ui.keyGen
		ui.keyAccepted( gen )
		if ( ! await worldReady ) return

		await world.reauthorize( candidate )
		ui.flashStatus( 'Key accepted — loading the globe' )
		await confirmLiveTileAuth( candidate, gen )

	} )

}

/** Fully checks a newly entered key before it can replace the current renderer. */
async function verifyEnteredKey( raw, accept ) {

	const candidate = classifyKey( raw )
	if ( ! candidate || checkingKey ) return

	checkingKey = true
	ui.keyChecking( true )

	try {

		// A typed key gets the full root probe. It is worth the one extra request:
		// a rejected or quota-dead key must never dispose a working tileset.
		const check = await verifyTileAuth(
			{ ...candidate, source: 'user' },
			{ probeRoot: true },
		)
		if ( ! check.ok ) {

			ui.keyRejected( check.reason, { quota: Boolean( check.quota ) } )
			return

		}

		await accept( { ...candidate, source: 'user' } )

	} catch ( error ) {

		console.error( error )
		ui.keyRejected( 'Could not use that key. Check the network and try again.' )

	} finally {

		checkingKey = false
		ui.keyChecking( false )

	}

}

/** Surfaces quota / auth failures from the live tile pipeline once, not per tile. */
function onTileError( event ) {

	if ( tileAuthComplaint ) return
	const interpreted = interpretTileError( event )
	if ( ! interpreted ) return

	tileAuthComplaint = true
	authReady = false
	ui.askForKey( interpreted.reason, { invalid: true, quota: Boolean( interpreted.quota ) } )

}

// ------------------------------------------------------------------ wiring

function wireUI() {

	ui.on.select = target => {

		currentTarget = world.setTarget( target )
		ui.showTarget( currentTarget )
		venue.setTarget( currentTarget )
		applyLight( ui.selection.light )
		if ( world.state === 'done' || world.state === 'free' ) world.returnToIdle()
		// Pasted coordinates still need a landing-pose probe — idle is from
		// orbit, so a ray here would only hit the coarse shell. Launch and
		// record both call calibrateGround() once the end frame is loaded.

	}

	// Hovering an entry in the place list turns the globe to it. Nothing is
	// committed until the click, so leaving the list swings it back.
	ui.on.preview = target => {

		world.setTarget( target )
		applyLight( ui.selection.light )

	}

	ui.on.previewEnd = () => {

		const target = ui.currentTarget()
		if ( ! target ) return
		world.setTarget( target )
		applyLight( ui.selection.light )

	}

	ui.on.shot = () => applyLight( ui.selection.light )
	ui.on.light = key => applyLight( key )
	ui.on.duration = () => {}

	ui.on.go = () => launch()
	ui.on.abort = () => {

		if ( launchAbort ) {

			launchAbort.abort()
			ui.flashStatus( 'Cancelled' )
			return

		}

		if ( recorder.active ) {

			recorder.cancel()
			ui.flashStatus( 'Stopping the export…' )

		} else if ( world.state === 'flying' ) {

			world.abort()

		} else if ( world.state === 'done' || world.state === 'free' ) {

			world.returnToIdle()

		}

	}

	ui.on.record = armed => {

		if ( armed ) {

			const { width, height } = captureSize( {
				resolution: ui.advancedValues.resolution,
				aspect: ui.advancedValues.aspect,
			} )
			const gear = '<svg class="status-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/></svg>'
			ui.flashStatus(
				`Recorder armed — <b>${width} × ${height}</b> at ${ui.advancedValues.fps} fps · changes in settings ${gear}`,
				3600,
				{ html: true },
			)

		}

	}

	ui.on.replay = () => launch()
	ui.on.change = () => world.returnToIdle()
	ui.on.save = () => downloadRecording( recorder.result, recordingName() )

	ui.on.advanced = ( key, value ) => onAdvanced( key, value )

	// The moment the user touches the canvas after a flight, hand them the
	// controls. They keep them — orbiting wherever they like — until they pick
	// replay, another place, or back out.
	for ( const event of [ 'pointerdown', 'wheel' ] ) {

		canvas.addEventListener( event, () => world.releaseToUser(), { passive: true } )

	}

}

/**
 * Settings-panel changes. The recording keys (resolution, fps, aspect, quality)
 * are read straight off `ui.advancedValues` when a take starts, so they need no
 * case here.
 */
function onAdvanced( key, value ) {

	if ( key === 'cloudShadows' ) world.cloudShadows = Boolean( value )

}

// -------------------------------------------------------------------- light

function applyLight( key ) {

	if ( ! world.target ) return
	ui.syncLight( world.solveLight( { key } ) )

}

// ------------------------------------------------------------------- flight

async function launch() {

	if ( pendingLaunch || recorder.active ) return
	if ( ! authReady ) {

		// A key already in flight is the common case here — the card dismisses
		// optimistically, so Start lands in the window where the root load is
		// still running. Re-gating the app on it would tell someone who pasted
		// four seconds ago to do the thing that is in progress.
		if ( verifying || checkingKey ) ui.flashStatus( 'Still checking your key — one moment' )
		else ui.askForKey( 'The globe needs a key before a flight can start.' )
		return

	}
	if ( ! world.target ) return

	const ac = new AbortController()
	launchAbort = ac
	pendingLaunch = true
	ui.setState( 'loading' )
	ui.boot( 'Framing the shot' )

	try {

		const recording = ui.armed
		if ( ! recording ) recorder.result = null
		const { light } = world.prepareShot( {
			preset: ui.selection.shot,
			duration: ui.selection.duration,
			lightKey: ui.selection.light,
		} )
		ui.syncLight( light )

		// Pasted map links have no geoid table — read the mesh at the landing pose
		// before the flight, or the camera finishes under the terrain.
		const ground = await calibrateGround( { signal: ac.signal } )
		if ( ac.signal.aborted ) {

			ui.boot( '' )
			ui.setState( 'idle' )
			return

		}
		if ( world.target.needsGroundProbe && ! ground ) {

			ui.boot( '' )
			ui.setState( 'idle' )
			ui.flashStatus( 'Could not read the ground here — try another place or wait for the tiles', 6000 )
			return

		}

		if ( recording ) {

			launchAbort = null
			await runRecording()
			return

		}

		// Ease to the top of the shot while the first tiles arrive — the camera is
		// already moving, so this never reads as a wait.
		world.preroll()
		ui.boot( 'Finding the light' )
		await world.settle( {
			maxWaitMs: 3500,
			stableFrames: 2,
			signal: ac.signal,
			waitForLook: true,
		} )
		if ( ac.signal.aborted ) {

			ui.boot( '' )
			world.returnToIdle()
			ui.setState( 'idle' )
			return

		}

		// Meter the landing frame and lock an exposure for the whole flight. The
		// probe frames never reach the screen — the whole measurement happens inside
		// one task. Blend the correction in so the globe does not flash on Start.
		world.autoExpose( { blend: true } )

		ui.boot( '' )
		world.play()

	} catch ( error ) {

		console.error( error )
		ui.boot( '' )
		world.returnToIdle()
		ui.setState( 'idle' )
		ui.flashStatus( error.message || 'Could not start the flight', 6000 )

	} finally {

		if ( launchAbort === ac ) launchAbort = null
		pendingLaunch = false

	}

}

function onWorldState( state ) {

	if ( state === 'flying' ) {

		ui.setState( 'flying' )

	} else if ( state === 'done' ) {

		ui.setState( 'done' )
		setTimeout( () => {

			// still worth showing if they have already grabbed the camera — the
			// card is how they get back out of free-look
			if ( world.state === 'done' || world.state === 'free' ) ui.showFinish( Boolean( recorder.result ) )

		}, 800 )

	} else if ( state === 'idle' ) {

		ui.setState( 'idle' )

	} else if ( state === 'free' ) {

		ui.setState( 'free' )

	}

}

function onWorldFrame( info ) {

	ui.tickFps()
	venue.update( info.state )

	// free-look is included: the corner readouts stay up after the landing, so
	// the altitude has to keep up with a camera the user is now flying
	if ( info.state === 'flying' || info.state === 'done' || info.state === 'free' ) {

		ui.setFlightReadout( info )

	} else if ( info.state === 'loading' ) {

		ui.setLoad( info.loadProgress )

	}

}

// ----------------------------------------------------------------- recording

async function runRecording() {

	const values = ui.advancedValues
	const { width, height } = captureSize( { resolution: values.resolution, aspect: values.aspect } )

	// Stop the interactive loop: the recorder drives render() itself, one frame
	// at a time, so two loops would fight over the drawing buffer.
	world.stop()
	ui.setState( 'flying' )
	ui.setCapturing( true )
	// Drop the previous take's clock before warmup — otherwise the pill still
	// shows the last export until the first frame commits.
	ui.setCaptureProgress( {
		shotTime: 0,
		duration: ui.selection.duration,
		rate: 0,
	} )
	sizeCanvasForCapture( width, height )
	ui.boot( 'Warming up the tiles' )

	try {

		const result = await recorder.record( {
			resolution: values.resolution,
			fps: values.fps,
			aspect: values.aspect,
			quality: values.quality,
			onProgress: info => {

				ui.setCaptureProgress( info )
				ui.setFlightReadout( {
					progress: info.frame / info.totalFrames,
					altitude: world.rig.altitude,
				} )
				ui.boot( '' )

			},
		} )

		if ( result ) {

			// The encode finishes long after the click that started it, so some
			// browsers still need a fresh gesture — Save video stays for that.
			downloadRecording( result, recordingName() )
			ui.flashStatus(
				`Saved <b>${result.width} × ${result.height}</b> ${result.codec.toUpperCase()} · ${( result.blob.size / 1048576 ).toFixed( 1 )} MB — use Save video if the download did not start`,
				7000,
				{ html: true },
			)

		} else {

			ui.flashStatus( 'Export cancelled' )

		}

	} catch ( error ) {

		console.error( error )
		ui.flashStatus( error.message || 'The export failed', 6000 )

	} finally {

		ui.boot( '' )
		ui.setCapturing( false )
		clearCanvasCaptureSize()
		world.start()
		world.finish()

	}

}

/**
 * The drawing buffer is forced to the export size, so the CSS box has to match
 * its aspect or the preview would be stretched and misleading.
 */
function sizeCanvasForCapture( width, height ) {

	const scale = Math.min( window.innerWidth / width, window.innerHeight / height, 1 )
	canvas.style.width = `${Math.round( width * scale )}px`
	canvas.style.height = `${Math.round( height * scale )}px`

}

function clearCanvasCaptureSize() {

	canvas.style.width = ''
	canvas.style.height = ''

}

// --------------------------------------------------------------------- misc

function probeGround() {

	if ( ! world.target ) return null
	const probe = world.probeGround()
	if ( probe ) ui.setCustomGround( probe.groundHeight )
	if ( probe && Math.abs( probe.delta ) > 3 ) {

		// The framing sliders are relative to the ground, so only the readout
		// needs refreshing — the numbers themselves are unchanged.
		ui.showTarget( world.target )

	}
	return probe

}

/**
 * For a pasted coordinate, park on the landing frame long enough for the
 * photorealistic tiles to replace the coarse shell, then read the real ground
 * height off the mesh. The animation loop has to be stopped first — otherwise
 * it overwrites the seek every frame with the idle/preroll pose and the probe
 * never sees the subject.
 */
async function calibrateGround( { signal } = {} ) {

	if ( ! world.target?.needsGroundProbe || ! world.shot ) return null

	ui.boot( 'Reading the ground' )
	world.stop()

	try {

		world.seek( world.shot.duration )
		const settled = await world.settle( { maxWaitMs: 15000, signal } )
		if ( signal?.aborted ) return null
		// Ignore a first hit on the coarse shell unless the pipeline actually
		// went quiet — otherwise ellipsoid-draped LOD can clear the probe.
		let probe = settled ? probeGround() : null

		// Re-seek with the corrected aim so the next quiet spell refines around
		// the real subject height, not the ellipsoid-zero guess we landed on.
		world.seek( world.shot.duration )
		const refined = await world.settle( { maxWaitMs: 6000, stableFrames: 2, signal } )
		if ( signal?.aborted ) return null
		probe = ( refined && probeGround() ) || probe

		if ( probe ) world.target.needsGroundProbe = false
		return probe

	} finally {

		world.seek( 0 )
		world.start()

	}

}

function onResize() {

	if ( recorder.active ) return
	world.resize( window.innerWidth, window.innerHeight, Math.min( window.devicePixelRatio, 2 ) )

}

function slug( text ) {

	return String( text ).toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' )

}

function recordingName() {

	const place = slug( currentTarget?.name ) || 'cinematic-world'
	const shot = slug( ui.selection.shot ) || 'shot'
	const duration = Math.round( ui.selection.duration )
	return `${place}-${shot}-${duration}s`

}

/**
 * The tinkering surface, for the console.
 *
 * Everything the settings panel does not expose is live on `world`:
 *
 *   cinematicWorld.world.exposureBias = -0.5      stops, on top of the metering
 *   cinematicWorld.world.handheld = 0             kill the camera drift
 *   cinematicWorld.world.tuneLight( { coverage: 0.6, flare: 0.04 } )
 *   cinematicWorld.world.setFraming( { orbitRadius: 900, lookAtHeight: 120 } )
 *   cinematicWorld.world.solveLight( { key: 'golden', elevation: 30 } )
 */
window.cinematicWorld = { world, ui, venue, recorder, LANDMARK_MAP }
