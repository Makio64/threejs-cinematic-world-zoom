import {
	AgXToneMapping, Data3DTexture, HalfFloatType, LinearFilter, LinearMipMapLinearFilter,
	MathUtils, NearestFilter, NoColorSpace, PerspectiveCamera, Points, Raycaster,
	RedFormat, RepeatWrapping, Scene, SRGBColorSpace, TextureLoader, UnsignedByteType, Vector3,
	WebGLRenderer,
} from 'three'
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js'
import { TileCreasedNormalsPlugin } from './TileCreasedNormalsPlugin.js'

import { GlobeControls, TilesRenderer } from '3d-tiles-renderer'
import { CesiumIonAuthPlugin, GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins'
import { GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins'

import { EffectPass, NormalPass, SMAAEffect, SMAAPreset } from 'postprocessing'
import {
	AerialPerspectiveEffect, PrecomputedTexturesGenerator, StarsGeometry, StarsMaterial,
	getSunDirectionECEF,
} from '@takram/three-atmosphere'
import {
	CloudsEffect, CLOUD_SHAPE_TEXTURE_SIZE, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
} from '@takram/three-clouds'
import { LensFlareEffect } from '@takram/three-geospatial-effects'

import { EffectAdapter, setChainDelta } from './EffectAdapter.js'
import { CameraRig } from '../camera/Rig.js'
import { blendStates, createIdleShot, createShot, SPACE_DISTANCE } from '../camera/shots.js'
import { clamp01, damp, smootherstep } from '../camera/easing.js'
import { resolveTarget } from '../data/landmarks.js'
import { getEastNorthUpAxes } from '../geo.js'
import { bearingDelta, findDaylight, LIGHT_PRESETS, refineAgainstRenderer } from '../sun.js'
import { GOOGLE_TILES_ASSET, resolveTileAuth } from '../tilesAuth.js'
import { assetUrl, fetchAsset } from '../assets.js'

const D2R = MathUtils.DEG2RAD
const R2D = MathUtils.RAD2DEG

// altitude window, in metres, over which the cloud layer fades in on the way
// down. Above it the ray march degenerates and the clouds would pop.
const CLOUD_FADE_HIGH = 420e3
const CLOUD_FADE_LOW = 90e3

// altitude window, in metres, over which the starfield fades out on the way
// down. The stars are there for the view from space, and the fade is over well
// before the atmosphere has anything to say about them — the top of it sits
// where the frame is still all Earth, so the field leaves unseen instead of
// switching off in one frame over a sky that is still black.
const STAR_FADE_HIGH = 300e3
const STAR_FADE_LOW = 120e3
const STAR_INTENSITY = 12

const EXPOSURE_IN_ORBIT = 8

// How far off the equator the idle globe may be turned by hand. The rig builds
// its frame from the local east/north, which has no answer at the pole itself.
const MAX_SPIN_LAT = 85 * D2R

/**
 * The turn a landing settles into once it has forgotten the rate it arrived on.
 * Angular rather than tangential, so a 250 m subject and a 7 km one drift at the
 * same speed on screen.
 */
const CRUISE_RATE = 1.6 * D2R

// How long a throw of the globe keeps rolling after the pointer lets go, and
// the fastest it may leave the hand — surface radians a second. The cap matters:
// a pointer that jumps half the window in one event (a coalesced move, a tablet,
// a synthetic drag) would otherwise hand over a rate that spins the planet
// several times before it runs down.
const SPIN_GLIDE = 0.42
const MAX_SPIN_RATE = 2.5

// Bounds on how long a change of light takes to land, in seconds. The value in
// between is picked per change from how far it has to travel — see _settleTime.
const LIGHT_SETTLE_MIN = 0.1
const LIGHT_SETTLE_MAX = 0.62
const JITTER_SIZE = 128
const JITTER_DEPTH = 64

// How long one tile LOD crossfade lasts, in milliseconds. The fade is a
// screen-space Bayer stipple between two levels of the same terrain and there
// is no temporal AA to dissolve it, so it is kept short enough that the
// pattern never settles long enough to read as texture.
const TILE_FADE_MS = 420
// A seek that jumps farther than this is a cut (exposure probes, recorder
// rewinds). Live frame hitches must NOT use this path — see FADE_MAX_STEP.
const FADE_CUT_STEP = 0.5
// Cap on continuous fade advancement per pump. Tile parse spikes routinely
// produce rAF deltas well past FADE_CUT_STEP; treating those as cuts aborted
// every in-flight crossfade and read as LOD bumps. Clamping keeps the stipple
// alive across the hitch instead.
const FADE_MAX_STEP = 1 / 20

const _sun = new Vector3()
const _east = new Vector3()
const _north = new Vector3()
const _up = new Vector3()
const _pos = new Vector3()
const _probeOrigin = new Vector3()
const _fwd = new Vector3()
const _right = new Vector3()
const _camUp = new Vector3()
const _toCentre = new Vector3()

/** A repeatable [0, 1) jitter volume for the cloud and atmosphere ray marches. */
function createJitterTexture() {

	const length = JITTER_SIZE * JITTER_SIZE * JITTER_DEPTH
	const data = new Uint8Array( length )
	for ( let i = 0; i < length; i ++ ) {

		// Two integer avalanches keep neighbouring pixels and time slices from
		// sharing structure. A fixed seed makes live playback and export agree.
		let value = ( i + 0x9e3779b9 ) >>> 0
		value = Math.imul( value ^ ( value >>> 16 ), 0x21f0aaad )
		value = Math.imul( value ^ ( value >>> 15 ), 0x735a2d97 )
		data[ i ] = ( value ^ ( value >>> 15 ) ) >>> 24

	}

	const texture = new Data3DTexture( data, JITTER_SIZE, JITTER_SIZE, JITTER_DEPTH )
	texture.type = UnsignedByteType
	texture.format = RedFormat
	texture.minFilter = NearestFilter
	texture.magFilter = NearestFilter
	texture.wrapS = RepeatWrapping
	texture.wrapT = RepeatWrapping
	texture.wrapR = RepeatWrapping
	texture.colorSpace = NoColorSpace
	texture.needsUpdate = true
	return texture

}

export class World {

	constructor( canvas ) {

		this.canvas = canvas
		this.renderer = null
		this.scene = null
		this.camera = null
		this.tiles = null
		this.controls = null
		this.rig = null

		this.state = 'idle'
		this.target = null
		this.shot = null
		this.shotTime = 0
		this.idleTime = 0

		this.light = { ...LIGHT_PRESETS.golden }
		this.lightKey = 'golden'
		this.sunDate = new Date()
		this.sunAzimuth = 0
		this.sunElevation = 0

		// What the frame is actually lit by, as opposed to what was last asked
		// for. Every channel is a spring, so choosing a preset — or a place,
		// which re-solves the sun for a new latitude — swings the light round
		// instead of cutting to it.
		//
		// The sun is held as an elevation and a compass bearing over whatever
		// the rig is pointing at, not as a direction in space. Interpolating
		// the two angles keeps a low sun low as it swings across the sky, where
		// the great-circle path between two low suns on opposite sides of the
		// sky climbs through the zenith and puts a flash of noon in the middle
		// of the transition. It also means the relationship between sun and
		// subject is what carries across a change of place, so the globe can
		// turn to Tokyo without dragging the terminator over it on the way.
		this._look = {
			elevation: { value: this.light.elevation, rate: 0 },
			azimuth: { value: 0, rate: 0 },
			coverage: { value: this.light.coverage, rate: 0 },
			exposure: { value: this.light.exposure, rate: 0 },
			flare: { value: this.light.flare, rate: 0 },
		}
		this._lookTo = {
			elevation: this.light.elevation,
			azimuth: 0,
			coverage: this.light.coverage,
			exposure: this.light.exposure,
			flare: this.light.flare,
		}
		this._lookSmooth = LIGHT_SETTLE_MAX
		this._lookPrimed = false

		this.handheld = 1
		// Off by default. A cloud deck dense enough to be worth looking at also
		// shadows the subject, and the whole premise here is that the place is
		// well lit — the sun angle is solved for, and then a cloud puts it in
		// shade. Available for anyone who wants it.
		this.cloudShadows = false
		this.exposureScale = 1
		this.exposureBias = 0
		this.cloudScale = 1
		this.flareScale = 1

		// Extension points. Assign a function to any of them; nothing here calls
		// them by default. `onTileError` receives the 3d-tiles-renderer event.
		this.onStateChange = null
		this.onFrame = null
		this.onTileError = null

		this._adapters = []
		this._idleShot = createIdleShot()
		this._stateA = {}
		this._stateB = {}
		this._live = {}
		this._blendFrom = null
		this._blendTime = 0
		this._blendDuration = 0
		this._geo = { lat: 0, lon: 0 }
		this._prerollTime = 0
		this._pitchScale = 1
		this._doneState = null
		this._doneTime = 0
		this._residual = null
		this._exposureCurve = null
		// Every take eases from the exposure already on screen into its metered
		// curve. Keeping that transition on shot time makes live and capture agree.
		this._exposureBlendFrom = null
		this._exposureBlendDuration = 0
		this._targetLerp = null
		// The idle globe turns under the hand. `_spun` records that the viewer
		// has taken it off the selected place, which is what keeps a ground probe
		// or a nudge of the framing sliders from quietly pulling it back.
		this._spin = { holding: false, latRate: 0, lonRate: 0 }
		this._spun = false
		this._running = false
		this._lastTime = 0
		this._recording = false

	}

	// ---------------------------------------------------------------- setup

	async init( { onProgress, auth = resolveTileAuth() } = {} ) {

		const report = onProgress || ( () => {} )
		this.auth = auth

		const camera = this.camera = new PerspectiveCamera( 45, this._aspect(), 10, 1e6 )

		const scene = this.scene = new Scene()

		const renderer = this.renderer = new WebGLRenderer( {
			canvas: this.canvas,
			outputBufferType: HalfFloatType,
			antialias: false,
			powerPreference: 'high-performance',
		} )
		renderer.outputColorSpace = SRGBColorSpace
		renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) )
		renderer.setSize( window.innerWidth, window.innerHeight )
		renderer.toneMapping = AgXToneMapping
		renderer.toneMappingExposure = EXPOSURE_IN_ORBIT

		report( 'Connecting to the globe' )
		this._initTiles( auth )

		this.rig = new CameraRig( this.tiles.ellipsoid )

		this.controls = new GlobeControls( scene, camera, renderer.domElement )
		this.controls.setEllipsoid( this.tiles.ellipsoid, this.tiles.group )
		this.controls.enableDamping = true
		this.controls.enabled = false
		// the height-adjust raycast drifts the camera as tiles stream in; it is
		// only re-enabled once the user takes over at the end of a flight
		this.controls.adjustHeight = false

		report( 'Precomputing scattering' )
		await this._initSky()

		report( 'Loading cloud volumes' )
		await this._loadCloudTextures()
		this._loadStars()

		// seed the live state so the first hand-over has something real to blend
		// from rather than a bag of undefineds
		this._live = this._idleShot.sample( 0, {} )

		this._initGlobeDrag()
		this.resize()

		return this

	}

	_initTiles( auth ) {

		const dracoLoader = new DRACOLoader()
		dracoLoader.setDecoderPath( DRACO_GLTF_CONFIG )

		const tiles = this.tiles = new TilesRenderer()

		// The renderer comes up before a credential does — the atmosphere globe is
		// what the setup card sits on. Until one arrives there is no auth plugin,
		// so the tileset has no URL, and `_updateTiles` holds the pipeline rather
		// than let it fetch a null root. `reauthorize()` rebuilds this with a key.
		this.tilesAuthorized = Boolean( auth.key )
		if ( this.tilesAuthorized ) {

			tiles.registerPlugin( auth.kind === 'google'
				? new GoogleCloudAuthPlugin( { apiToken: auth.key, autoRefreshToken: true } )
				: new CesiumIonAuthPlugin( {
					apiToken: auth.key,
					assetId: GOOGLE_TILES_ASSET,
					autoRefreshToken: true,
				} ) )

		}
		tiles.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader } ) )
		tiles.registerPlugin( new TileCreasedNormalsPlugin( { creaseAngle: 30 * D2R } ) )

		const fade = this.tilesFade = new TilesFadePlugin( {
			fadeDuration: TILE_FADE_MS,
			// The plugin abandons every crossfade at once — pops them — as soon
			// as more tiles are fading out than this *and* the camera is moving
			// quickly, on the theory that fast motion hides the pop. A dive
			// crosses the "fast" test (0.1 scene units of camera travel in a
			// frame) from the first frame to the last, and a descent through
			// four decades of altitude passes the default fifty fading tiles
			// within seconds of leaving orbit. So the safeguard was firing
			// continuously, precisely over the part of the flight the fade
			// exists for. Lifting the cap is what actually turns the fade on.
			maximumFadeOutTiles: Infinity,
		} )
		tiles.registerPlugin( fade )

		// see _updateTiles: the fade runs on the shot's clock, not the wall's
		this._fadeManager = fade._fadeManager ?? null
		if ( ! this._fadeManager ) {

			console.warn( 'TilesFadePlugin: no _fadeManager — tile fades will run on the wall clock, and will not survive a recording.' )

		}

		// UpdateOnChangePlugin is deliberately absent: the camera moves every
		// frame of a flight, so it never saves work, and it interferes with the
		// pump-until-settled loop the recorder relies on.

		tiles.setCamera( this.camera )
		tiles.setResolutionFromRenderer( this.camera, this.renderer )

		// A long descent revisits the same tiles on the way past; a bigger cache
		// is the difference between a clean flight and one that re-downloads.
		tiles.lruCache.minBytesSize = 0.75 * 2 ** 30
		tiles.lruCache.maxBytesSize = 1.1 * 2 ** 30
		tiles.downloadQueue.maxJobs = 30
		tiles.parseQueue.maxJobs = 8

		// The Google auth plugin registers itself asynchronously once the Ion
		// endpoint resolves, and forces errorTarget to 20 when it does — so our
		// value has to be (re)applied after the root tileset lands.
		this._errorTarget = 18
		tiles.addEventListener( 'load-root-tileset', () => {

			tiles.errorTarget = this._errorTarget

		} )

		tiles.addEventListener( 'load-error', event => {

			if ( this.onTileError ) this.onTileError( event )

		} )

		this.scene.add( tiles.group )

	}

	/** Rebuilds the tile renderer against a different key, keeping the scene. */
	async reauthorize( auth ) {

		this.auth = auth
		this.scene.remove( this.tiles.group )
		this.tiles.dispose()
		this._initTiles( auth )
		this.tiles.setCamera( this.camera )
		this.tiles.setResolutionFromRenderer( this.camera, this.renderer )
		this.controls.setEllipsoid( this.tiles.ellipsoid, this.tiles.group )
		this.rig.ellipsoid = this.tiles.ellipsoid

	}

	async _initSky() {

		const { camera, renderer, scene } = this

		const aerial = this.aerialPerspective = new AerialPerspectiveEffect( camera )
		aerial.sky = true
		aerial.sun = true
		aerial.sunLight = true
		aerial.skyLight = true
		aerial.correctGeometricError = true
		aerial.correctAltitude = true

		this._skyPatched = patchSkyRayMiss( aerial, 'aerial perspective effect' )

		const normalPass = new NormalPass( scene, camera )
		aerial.normalBuffer = normalPass.texture

		const clouds = this.clouds = new CloudsEffect( camera )
		clouds.coverage = this.light.coverage
		clouds.localWeatherVelocity.set( 0.0009, 0 )
		clouds.shadow.farScale = 0.25
		clouds.shadow.maxFar = 1e5
		clouds.shadow.cascadeCount = 2
		clouds.shadow.mapSize.set( 512, 512 )
		clouds.shadow.splitMode = 'practical'
		clouds.shadow.splitLambda = 0.71

		clouds.events.addEventListener( 'change', event => {

			if ( event.property === 'atmosphereOverlay' ) aerial.overlay = clouds.atmosphereOverlay
			if ( event.property === 'atmosphereShadow' ) this._cloudShadow = clouds.atmosphereShadow
			if ( event.property === 'atmosphereShadowLength' ) this._cloudShadowLength = clouds.atmosphereShadowLength

		} )

		const lensFlare = this.lensFlare = new LensFlareEffect( { intensity: this.light.flare } )
		lensFlare.featuresMaterial.ghostAmount = 0.0016
		lensFlare.featuresMaterial.haloAmount = 0.0014

		// The clouds must share a pass with the aerial perspective: they reach the
		// screen through `aerialPerspective.overlay`, not through their own
		// composite.
		//
		// No dithering pass. It is the conventional last step, but `setEffects`
		// applies tone mapping *after* the chain, so a dither sized for the final
		// 8-bit output gets applied to linear radiance and then stretched by AgX
		// at an exposure of 12. Measured over a landed frame it tripled the
		// high-frequency energy of the image — visible colour speckle across the
		// whole frame. The half-float buffer plus AgX does not band enough to be
		// worth that.
		this._flarePass = new EffectAdapter( new EffectPass( camera, lensFlare ), { camera } )
		this._skyPass = new EffectAdapter( new EffectPass( camera, clouds, aerial ), { camera } )
		const smaa = new SMAAEffect( { preset: SMAAPreset.HIGH } )

		this._adapters = [
			new EffectAdapter( normalPass ),
			this._skyPass,
			this._flarePass,
			new EffectAdapter( new EffectPass( camera, smaa ), { camera } ),
		]
		renderer.setEffects( this._adapters )

		// One-off lookup tables for the scattering model. They depend only on the
		// atmosphere parameters, so they survive every resize.
		const generator = new PrecomputedTexturesGenerator( renderer )
		const textures = await generator.update()
		Object.assign( aerial, textures )
		Object.assign( clouds, textures )
		this._atmosphereTextures = textures
		generator.dispose( { textures: false } )

	}

	/**
	 * Cloud volumes and the sampling jitter. These are prepared during boot on
	 * purpose: without either one the failure looks like a renderer bug rather
	 * than a missing file.
	 */
	async _loadCloudTextures() {

		const { clouds, aerialPerspective } = this
		const loader = new TextureLoader()

		const load2D = async ( name, key ) => {

			const url = await assetUrl( name )
			return new Promise( ( resolve, reject ) => loader.load( url, texture => {

				texture.minFilter = LinearMipMapLinearFilter
				texture.magFilter = LinearFilter
				texture.wrapS = RepeatWrapping
				texture.wrapT = RepeatWrapping
				texture.colorSpace = NoColorSpace
				texture.needsUpdate = true
				clouds[ key ] = texture
				resolve()

			}, undefined, reject ) )

		}

		const load3D = async ( name, size, key ) => {

			const buffer = await fetchAsset( name )
			const texture = new Data3DTexture( new Uint8Array( buffer ), size, size, size )
			texture.format = RedFormat
			texture.minFilter = LinearFilter
			texture.magFilter = LinearFilter
			texture.wrapS = RepeatWrapping
			texture.wrapT = RepeatWrapping
			texture.wrapR = RepeatWrapping
			texture.colorSpace = NoColorSpace
			texture.needsUpdate = true
			clouds[ key ] = texture

		}

		const results = await Promise.allSettled( [
			load2D( 'localWeather', 'localWeatherTexture' ),
			load2D( 'turbulence', 'turbulenceTexture' ),
			load3D( 'shape', CLOUD_SHAPE_TEXTURE_SIZE, 'shapeTexture' ),
			load3D( 'shapeDetail', CLOUD_SHAPE_DETAIL_TEXTURE_SIZE, 'shapeDetailTexture' ),
		] )

		// Takram's default STBN URL ultimately packages NVIDIA's separately
		// licensed dataset. A deterministic hash volume gives both shaders the
		// uniform sampling jitter they need without adding a restricted binary or
		// making recordings depend on a network fetch.
		const jitter = createJitterTexture()
		clouds.stbnTexture = jitter
		aerialPerspective.stbnTexture = jitter

		const failed = results.filter( r => r.status === 'rejected' )
		if ( failed.length > 0 ) {

			console.warn( 'World: some sky assets failed to load', failed.map( f => f.reason ) )
		}

	}

	/**
	 * Real stars, for the view from space. They are faded back out on the way
	 * down (see _applyAltitudeLook): the shader draws each point as the sky
	 * radiance along its own ray plus the star behind that ray's transmittance,
	 * which is honest but leaves the brightest few punching through a daylight
	 * sky as speckle once the camera is inside the atmosphere.
	 */
	_loadStars() {

		fetchAsset( 'stars' )
			.then( buffer => {

				const material = new StarsMaterial( {
					pointSize: 1.4,
					intensity: STAR_INTENSITY,
					background: true,
					...this._atmosphereTextures,
				} )
				// The stars shade themselves through the atmosphere, so they carry
				// their own copy of GetSkyRadiance and need the same ray-miss fix
				// the sky got: without it a star whose ray misses the atmosphere
				// is lit as though the ray had started inside the air, and picks
				// up a wash of daylight sky that belongs to nothing.
				patchSkyRayMiss( material, 'stars material' )
				patchStarDepth( material )
				material.sunDirection.copy( this.aerialPerspective.sunDirection )
				const stars = this.stars = new Points( new StarsGeometry( buffer ), material )
				stars.frustumCulled = false
				stars.renderOrder = -1
				this.scene.add( stars )

			} )
			.catch( () => {} )

	}

	// --------------------------------------------------------------- target

	/** Points the rig at a landmark (or a parsed coordinate). */
	setTarget( source, { animate = true } = {} ) {

		const target = resolveTarget( source )
		const previous = this.target
		this.target = target

		this.rig.minHeight = target.minHeight

		if ( previous && animate && this.state === 'idle' ) {

			// Ease the globe round to the new place rather than cutting: the
			// planet turning to face your choice is most of the charm of the
			// idle screen.
			//
			// The lerp starts from wherever the rig currently *is*, not from the
			// last committed target — otherwise sweeping the cursor down the
			// place list restarts each turn from the previous entry and the
			// globe stutters instead of following. A globe the viewer has just
			// spun by hand is picked up the same way.
			this._startTargetLerp( 1.2 )

		} else {

			this.rig.setTarget( target.latRad, target.lonRad, target.aimHeight )
			this._targetLerp = null
			this._releaseSpin()

		}

		return target

	}

	/** Eases the globe from wherever it is now onto the current target. */
	_startTargetLerp( duration ) {

		this._targetLerp = {
			fromLat: this.rig.lat, fromLon: this.rig.lon,
			fromAim: this.rig.aimHeight,
			time: 0, duration,
		}
		this._releaseSpin()

	}

	/** Drops any hand-turn of the globe: it is about to be re-pointed for us. */
	_releaseSpin() {

		this._spin.latRate = 0
		this._spin.lonRate = 0
		this._spun = false

	}

	/**
	 * Puts the rig back over the current target's coordinates.
	 *
	 * A globe the viewer is holding keeps its heading and takes only the new aim
	 * height, so a ground probe landing or a framing slider moving never pulls
	 * the planet out from under their hand.
	 */
	_repoint() {

		const t = this.target
		if ( ! t || this._targetLerp ) return
		if ( this._spun ) this.rig.aimHeight = t.aimHeight
		else this.rig.setTarget( t.latRad, t.lonRad, t.aimHeight )

	}

	/** Overrides the framing of the current target without changing the place. */
	setFraming( { orbitRadius, lookAtHeight } = {} ) {

		const t = this.target
		if ( ! t ) return
		if ( orbitRadius !== undefined ) {

			t.orbitRadius = orbitRadius
			t.endDistance = orbitRadius / Math.cos( t.orbitPitch )

		}
		if ( lookAtHeight !== undefined ) {

			t.lookAtHeight = lookAtHeight
			t.aimHeight = t.groundHeight + lookAtHeight
			t.minHeight = t.groundHeight + Math.max( 40, lookAtHeight > 0 ? lookAtHeight * 0.18 : 40 )
			this.rig.minHeight = t.minHeight
			this._repoint()

		}

	}

	// ----------------------------------------------------------- globe drag

	/** The globe is only in the viewer's hands on the idle screen. */
	get canSpin() {

		return this.state === 'idle' && ! this._recording

	}

	/**
	 * Lets the idle globe be turned by hand.
	 *
	 * The gesture moves the point the camera is *over* — the rig's own lat/lon —
	 * rather than orbiting the camera around a fixed one, which is what keeps
	 * north at the top of the frame however far the planet is turned. Turning it
	 * this way also carries the light with it, since the sun is held as an angle
	 * over the ground under the rig: the viewer can spin the Earth without
	 * dragging the terminator across it.
	 */
	_initGlobeDrag() {

		const element = this.canvas
		let held = -1
		let lastX = 0
		let lastY = 0
		let lastTime = 0

		element.addEventListener( 'pointerdown', event => {

			if ( held !== -1 || event.button !== 0 || ! this.canSpin ) return

			held = event.pointerId
			lastX = event.clientX
			lastY = event.clientY
			lastTime = event.timeStamp
			this._spin.holding = true
			this._spin.latRate = 0
			this._spin.lonRate = 0
			element.setPointerCapture( held )
			this._setCursor()

		} )

		element.addEventListener( 'pointermove', event => {

			if ( event.pointerId !== held ) return
			if ( event.clientX === lastX && event.clientY === lastY ) return

			// The hand wins, from the first pixel of movement: a globe still
			// easing towards a place the cursor passed over stops where it is
			// rather than fighting the drag. A press that never moves is left
			// alone entirely, so a stray click does not pin the planet.
			this._targetLerp = null
			this._spun = true

			const scale = this._spinScale()
			// north is up and east is right, so pulling the planet down brings
			// what was above the middle — northward — under the camera, and
			// pulling it right brings what was to the west
			const dLat = ( event.clientY - lastY ) * scale
			const dLon = -( event.clientX - lastX ) * scale
			const dt = Math.max( ( event.timeStamp - lastTime ) / 1000, 1 / 120 )
			lastX = event.clientX
			lastY = event.clientY
			lastTime = event.timeStamp

			const turned = this._turnGlobe( dLat, dLon )

			// Throw velocity, smoothed across a couple of events: the last move
			// before a release is as often a one-pixel twitch as it is the throw.
			const spin = this._spin
			spin.latRate += ( turned.lat / dt - spin.latRate ) * 0.5
			spin.lonRate += ( turned.lon / dt - spin.lonRate ) * 0.5
			spin.latRate = MathUtils.clamp( spin.latRate, -MAX_SPIN_RATE, MAX_SPIN_RATE )
			spin.lonRate = MathUtils.clamp( spin.lonRate, -MAX_SPIN_RATE, MAX_SPIN_RATE )

		} )

		const release = event => {

			if ( event.pointerId !== held ) return
			held = -1
			this._spin.holding = false
			this._setCursor()

		}

		element.addEventListener( 'pointerup', release )
		element.addEventListener( 'pointercancel', release )

		this._setCursor()

	}

	/**
	 * Surface radians per pixel of drag.
	 *
	 * Calibrated off the globe's apparent radius rather than a fixed gain, so
	 * the planet tracks the pointer one to one at the middle of the disc
	 * whatever the distance, the lens and the size of the window — and turns
	 * short of the pointer out towards the limb, which is what a hand on a real
	 * globe does too.
	 */
	_spinScale() {

		const height = this.canvas.clientHeight || window.innerHeight
		const focal = ( height / 2 ) / Math.tan( 0.5 * this.camera.fov * D2R )
		const radius = this.tiles.ellipsoid.radius.x
		const centre = Math.max( this.camera.position.length(), radius * 1.001 )
		const limb = Math.asin( MathUtils.clamp( radius / centre, 0, 1 ) )
		// floored, so a window that reports no size — a page still in a
		// background tab — cannot turn one pixel into a hemisphere
		return 1 / Math.max( focal * Math.tan( limb ), 64 )

	}

	/**
	 * Turns the globe by an increment of surface angle, in radians, and reports
	 * back what was actually applied — less than was asked for once the latitude
	 * clamp bites, so a throw at the pole runs down instead of grinding along it.
	 */
	_turnGlobe( dLat, dLon ) {

		const { rig } = this
		const lat = MathUtils.clamp( rig.lat + dLat, -MAX_SPIN_LAT, MAX_SPIN_LAT )
		// a stride along a parallel covers more longitude the nearer the pole it
		// is taken; the clamp stops the last few degrees before the limit from
		// whipping the planet round
		const lon = rig.lon + dLon / Math.max( Math.cos( rig.lat ), 0.25 )
		const applied = { lat: lat - rig.lat, lon: dLon }
		rig.setTarget( lat, wrapAngle( lon ), rig.aimHeight )
		return applied

	}

	/** Runs the throw down after the pointer lets go. */
	_advanceSpin( dt ) {

		const spin = this._spin
		if ( spin.holding || ! ( dt > 0 ) ) return
		if ( Math.abs( spin.latRate ) + Math.abs( spin.lonRate ) < 1e-5 ) {

			spin.latRate = 0
			spin.lonRate = 0
			return

		}

		this._turnGlobe( spin.latRate * dt, spin.lonRate * dt )
		if ( Math.abs( this.rig.lat ) >= MAX_SPIN_LAT - 1e-9 ) spin.latRate = 0

		const decay = Math.exp( -dt / SPIN_GLIDE )
		spin.latRate *= decay
		spin.lonRate *= decay

	}

	/** Grab affordance, for the one state where the globe answers to a drag. */
	_setCursor() {

		this.canvas.style.cursor = this.canSpin
			? ( this._spin.holding ? 'grabbing' : 'grab' )
			: ''

	}

	// ------------------------------------------------------------------ sun

	/**
	 * Chooses the moment in time that lights this place the way the preset asks
	 * for, and returns the compass bearing the camera should finish on so the
	 * sun lands at the requested angle off the lens axis.
	 *
	 * The elevation is solved exactly and the camera is rotated to suit, rather
	 * than the other way round — a given (elevation, azimuth) pair is often
	 * simply unreachable at a latitude, whereas any elevation the sun can reach
	 * there is reachable from *some* direction.
	 *
	 * The answer is a target rather than a cut. `animate: false` is for the
	 * callers that need the light already there on the very next frame.
	 */
	solveLight( { key = this.lightKey, elevation, gamma, animate = true } = {} ) {

		const preset = LIGHT_PRESETS[ key ] || LIGHT_PRESETS.golden
		this.lightKey = key
		this.light = { ...preset }
		if ( elevation !== undefined ) this.light.elevation = elevation
		if ( gamma !== undefined ) this.light.gamma = gamma

		const t = this.target
		const solved = findDaylight( {
			lat: t.lat,
			lon: t.lon,
			elevation: this.light.elevation,
		} )

		// Reconcile with the ephemeris the shaders actually use, so the light on
		// screen is the light we solved for.
		const measure = date => this._measureSunElevation( date )
		const date = refineAgainstRenderer( solved.date, measure, this.light.elevation )

		this.sunDate = date
		const measured = this._measureSun( date )
		this.sunElevation = measured.elevation
		this.sunAzimuth = measured.azimuth

		// gamma = sunAzimuth - viewAzimuth, and the camera sits opposite the way
		// it looks, so the bearing of the camera from the subject is:
		const endAzimuth = ( measured.azimuth - 180 - this.light.gamma ) * D2R

		this._retargetLook( measured, animate )

		return {
			date,
			elevation: measured.elevation,
			azimuth: measured.azimuth,
			endAzimuth,
			exact: Math.abs( measured.elevation - this.light.elevation ) < 0.6,
		}

	}

	_measureSun( date ) {

		const { ellipsoid } = this.tiles
		const t = this.target
		getEastNorthUpAxes( ellipsoid, t.latRad, t.lonRad, _east, _north, _up )
		getSunDirectionECEF( date, _sun )
		const elevation = R2D * Math.asin( MathUtils.clamp( _sun.dot( _up ), -1, 1 ) )
		const azimuth = ( R2D * Math.atan2( _sun.dot( _east ), _sun.dot( _north ) ) + 360 ) % 360
		return { elevation, azimuth }

	}

	_measureSunElevation( date ) {

		return this._measureSun( date ).elevation

	}

	/**
	 * Nudges the look of the current light without re-solving the sun — what the
	 * advanced sliders drive. Goes through the same springs as everything else,
	 * so a drag is smooth rather than stepped.
	 */
	tuneLight( { coverage, exposure, flare } = {} ) {

		if ( coverage !== undefined ) this.light.coverage = this._lookTo.coverage = coverage
		if ( exposure !== undefined ) this.light.exposure = this._lookTo.exposure = exposure
		if ( flare !== undefined ) this.light.flare = this._lookTo.flare = flare
		this._lookSmooth = this._settleTime()

	}

	/** Points the live light at a freshly solved sun. */
	_retargetLook( measured, animate ) {

		const to = this._lookTo
		to.elevation = measured.elevation
		to.azimuth = measured.azimuth
		to.coverage = this.light.coverage
		to.exposure = this.light.exposure
		to.flare = this.light.flare

		// The first solve of the session has nothing to travel from, and a
		// caller that asked for no animation is about to meter or record the
		// frame it gets.
		if ( ! animate || ! this._lookPrimed ) {

			this._lookPrimed = true
			this._commitLook()
			return

		}

		this._lookSmooth = this._settleTime()

	}

	/** Resolves every light spring at its target before metering or capture. */
	_commitLook() {

		const to = this._lookTo
		for ( const key in this._look ) {

			this._look[ key ].value = to[ key ]
			this._look[ key ].rate = 0

		}
		this.applySun()

	}

	/** True once committing the selected look would no longer make a visible cut. */
	_isLookSettled() {

		const look = this._look
		const to = this._lookTo
		return Math.max(
			Math.abs( to.elevation - look.elevation.value ) / 40,
			Math.abs( bearingDelta( to.azimuth, look.azimuth.value ) ) / 110,
			Math.abs( to.coverage - look.coverage.value ) / 0.3,
			Math.abs( to.exposure - look.exposure.value ) / 5,
			Math.abs( to.flare - look.flare.value ) / 0.03,
		) < 0.002

	}

	/**
	 * How long this change should take.
	 *
	 * A nudge of a slider wants to land at once; a jump from noon to last light
	 * is a piece of choreography. One number cannot serve both, so the settle
	 * time is scaled by how far the light actually has to travel — the largest
	 * of the channel moves, each measured against a move that is plainly a
	 * change of preset rather than a tweak. Held for the whole of that change,
	 * not recomputed per frame, or the spring would stiffen as it closed in and
	 * snap the last few degrees.
	 */
	_settleTime() {

		const look = this._look
		const to = this._lookTo
		const travel = Math.max(
			Math.abs( to.elevation - look.elevation.value ) / 40,
			Math.abs( bearingDelta( to.azimuth, look.azimuth.value ) ) / 110,
			Math.abs( to.coverage - look.coverage.value ) / 0.3,
			Math.abs( to.exposure - look.exposure.value ) / 5,
		)
		return MathUtils.clamp(
			LIGHT_SETTLE_MIN + travel * LIGHT_SETTLE_MAX,
			LIGHT_SETTLE_MIN,
			LIGHT_SETTLE_MAX,
		)

	}

	/** Advances every light channel one frame and hands the result to the sky. */
	_advanceLook( dt ) {

		const look = this._look
		const to = this._lookTo
		const smooth = this._lookSmooth

		damp( look.elevation, to.elevation, smooth, dt )
		// round the short way, then wrapped back into range so a bearing that
		// has crossed north a few dozen times never drifts out of it
		damp( look.azimuth, look.azimuth.value + bearingDelta( to.azimuth, look.azimuth.value ), smooth, dt )
		look.azimuth.value = ( look.azimuth.value % 360 + 360 ) % 360
		damp( look.coverage, to.coverage, smooth, dt )
		damp( look.exposure, to.exposure, smooth, dt )
		damp( look.flare, to.flare, smooth, dt )

		this.applySun()

	}

	/**
	 * Rebuilds the sun direction from the live elevation and bearing.
	 *
	 * Every frame, because the frame those angles are measured in is the ground
	 * under the rig — which is itself moving whenever the globe is turning to a
	 * new place.
	 */
	applySun() {

		if ( ! this.rig ) return

		const { ellipsoid } = this.tiles
		getEastNorthUpAxes( ellipsoid, this.rig.lat, this.rig.lon, _east, _north, _up )

		const elevation = this._look.elevation.value * D2R
		const azimuth = this._look.azimuth.value * D2R
		const horizon = Math.cos( elevation )

		_sun.set( 0, 0, 0 )
			.addScaledVector( _east, horizon * Math.sin( azimuth ) )
			.addScaledVector( _north, horizon * Math.cos( azimuth ) )
			.addScaledVector( _up, Math.sin( elevation ) )
			.normalize()

		this.aerialPerspective.sunDirection.copy( _sun )
		this.clouds.sunDirection.copy( _sun )
		if ( this.stars ) this.stars.material.sunDirection.copy( _sun )

	}

	// ----------------------------------------------------------------- shot

	/** Builds the flight but does not start it. */
	prepareShot( { preset = 'descent', duration, lightKey = this.lightKey, animate = true } = {} ) {

		// Replay can arrive straight from `done`, where the previous curve is
		// still active. Hold its currently displayed multiplier, then invalidate
		// the old take before loading rewinds shotTime to zero.
		const usesScalarExposure = (
			( this.state === 'idle' || this.state === 'free' ) && ! this._recording
		)
		this.exposureScale = usesScalarExposure ? this.exposureScale : this._exposureAt( this.shotTime )
		this._exposureCurve = null
		this._exposureBlendFrom = null
		this._exposureBlendDuration = 0

		// The whole shot is described in the subject's own frame, so a globe the
		// viewer has turned away from it has to come back before the flight is
		// built. Eased, and under the preroll, so leaving the idle screen still
		// reads as one move — `seek` resolves it outright for a recording, which
		// has no clock to ease against.
		if ( this._spun ) this._startTargetLerp( 1.4 )

		// Visible starts ease the sun during preroll. A caller without a running
		// clock can request a commit; the recorder commits inside autoExpose(),
		// after it has stopped the interactive loop.
		const light = this.solveLight( { key: lightKey, animate } )

		// A landmark with `faceToward` pins the landing bearing to geography
		// (e.g. the conference venue looking toward the Eiffel Tower) instead of
		// whatever the sun solve would have chosen for the light preset.
		const endAzimuth = this.target.endAzimuth ?? light.endAzimuth
		light.endAzimuth = endAzimuth

		this.shot = createShot( {
			preset,
			endAzimuth,
			endDistance: this.target.endDistance,
			startDistance: SPACE_DISTANCE,
			duration,
			handheld: this.handheld,
			seed: hashString( this.target.id ),
		} )

		// Backlit presets want the horizon in frame, which means a shallower
		// final approach than the shot would otherwise take.
		this._pitchScale = this.light.pitchScale ?? 1

		this.shotTime = 0
		return { shot: this.shot, light }

	}

	/**
	 * Eases the camera to the shot's starting pose and holds there while the
	 * first tiles arrive. Pressing launch therefore begins moving immediately
	 * instead of staring at a progress bar, and the flight itself starts from a
	 * camera that is already travelling.
	 */
	preroll() {

		if ( ! this.shot ) return
		this._blendFrom = { ...this._live }
		this._blendTime = 0
		this._blendDuration = 1.9
		this._prerollTime = 0
		this._takeCameraBack()
		this._setState( 'loading' )

	}

	play() {

		if ( ! this.shot ) return
		// any hand-over blend started by preroll() keeps running straight into
		// the flight, which is what makes the launch read as an acceleration
		if ( ! this._blendFrom ) {

			this._blendFrom = { ...this._live }
			this._blendTime = 0
			this._blendDuration = 1.6

		}
		this.shotTime = 0
		this._takeCameraBack()
		this._setState( 'flying' )

	}

	abort() {

		if ( this.state !== 'flying' ) return
		this.finish()

	}

	finish( state = this._live ) {

		// Land from wherever the flight actually got to, which is the shot's end
		// for one that ran out and the abort point for one the viewer stopped
		// halfway down. Every channel leaves at the rate it had there and relaxes
		// from it, so arriving reads as the flight settling rather than as the film
		// stopping. The shot owns that maths, because it is the thing that knows
		// its own exit rates.
		this._doneTime = 0
		this._residual = this.shot
			? this.shot.settle( Math.min( this.shotTime, this.shot.duration ), { cruise: CRUISE_RATE } )
			: null
		this._doneState = this._residual ? null : { ...state }

		// Arm the controls now rather than on the pointerdown that hands over:
		// their own listener drops events while they are disabled, and enabling
		// them mid-gesture resets the pointer tracker — either way the first
		// drag after a flight would be swallowed. They cannot move anything
		// until `free`, because that is the only state that calls update().
		this.controls.enabled = true
		this._setState( 'done' )

	}

	returnToIdle() {

		this._takeCameraBack()
		// Back to north-up. The blend takes the long climb and the swing round
		// together, so by the time the bearing has gone anywhere the camera is
		// already most of the way out to space.
		this._idleShot = createIdleShot()
		this.idleTime = 0
		this._blendFrom = { ...this._live }
		this._blendTime = 0
		this._blendDuration = 2.2
		this._exposureCurve = null
		this._exposureBlendFrom = null
		this.exposureScale = 1
		this._setState( 'idle' )

	}

	/** Hands the camera to the user, keeping the current framing. */
	releaseToUser() {

		if ( this.state !== 'done' ) return
		this.controls.enabled = true
		// Safe from here on: the camera has stopped, so the height-adjust
		// raycast lands on tiles that are already resolved instead of dragging
		// the camera around after every stream-in.
		this.controls.adjustHeight = true
		this._setState( 'free' )

	}

	/** Ends free-look, if it is running, and puts the rig back in charge. */
	_takeCameraBack() {

		this.controls.enabled = false
		this.controls.adjustHeight = false

	}

	_setState( state ) {

		if ( this.state === state ) return
		this.state = state
		this._setCursor()
		if ( this.onStateChange ) this.onStateChange( state )

	}

	// ----------------------------------------------------------------- loop

	start() {

		if ( this._running ) return
		this._running = true
		this._lastTime = performance.now()
		this.renderer.setAnimationLoop( time => {

			const dt = Math.min( ( time - this._lastTime ) / 1000, 0.1 )
			this._lastTime = time
			this.frame( dt )

		} )

	}

	stop() {

		this._running = false
		this.renderer.setAnimationLoop( null )

	}

	frame( dt ) {

		this.advance( dt )
		this.render( dt )
		if ( this.onFrame ) this.onFrame( this.readout() )

	}

	/** Advances every clock by `dt` seconds and resolves the camera. */
	advance( dt ) {

		this._ensureSized()
		if ( this._targetLerp ) this._advanceTargetLerp( dt )
		if ( this.state === 'idle' ) this._advanceSpin( dt )

		if ( this.state === 'free' ) {

			// The user owns the camera here, so the rig only reads it back —
			// resolving a shot state would *drive* the camera instead, and the
			// idle shot would haul it straight back out to the globe. Keeping
			// `_live` in step with where they left it is what lets a replay, or
			// a return to idle, blend out of the free view rather than cut.
			this.controls.update( dt )
			this._live = this.rig.readFromCamera( this.camera, this._stateA )
			this.rig.altitude = this.rig.ellipsoid.getPositionElevation( this.camera.position )

		} else {

			const state = this._resolveCameraState( dt )
			this.rig.apply( this.camera, state )
			// GlobeControls owns the near/far maths — it derives them from the
			// globe and the horizon, which is the only thing that stays sane
			// across a twelve-thousand-kilometre range. It is safe to call with
			// the controls disabled, and with adjustHeight off it will not move
			// the camera.
			this.controls.adjustCamera( this.camera )
			this._live = state

		}

		this._advanceLook( dt )
		this._applyAltitudeLook()

		this._updateTiles( dt )

	}

	/**
	 * Pumps the tile pipeline, advancing the LOD crossfades by `dt` shot
	 * seconds first.
	 *
	 * `TilesFadePlugin` steps its fades off `performance.now()`, which is right
	 * for a live loop and wrong for both of the other ways this app drives the
	 * world. A recorded frame takes far longer to render than it lasts, so
	 * every fade would clamp to complete inside one captured frame — smooth on
	 * screen, popping in the file. `settle()` has the opposite problem: it
	 * pumps the pipeline for seconds of wall time while the shot stands still,
	 * which would run out the fades of tiles that have not been seen yet.
	 *
	 * The manager derives its step from `now - _lastTick` and clamps it to the
	 * fade duration, so backdating that stamp hands it whatever delta we want
	 * and leaves the rest of the plugin's logic upstream's.
	 *
	 * @param {number} dt Seconds to advance the fade. Negative is always a cut.
	 * @param {boolean} [cut=false] Resolve every in-flight fade before pumping.
	 *   Only `seek()` sets this, and only for discontinuous jumps — never the
	 *   live loop, where a long frame is a hitch rather than a cut.
	 */
	_updateTiles( dt = 0, cut = false ) {

		// No credential yet: there is no root to pump, and pumping anyway would
		// send the base renderer after a null URL. The atmosphere still renders,
		// which is the whole point of coming up before setup is answered.
		if ( ! this.tilesAuthorized ) return

		const manager = this._fadeManager
		if ( manager ) {

			if ( cut || ! ( dt >= 0 ) ) {

				manager.completeAllFades()
				dt = 0

			} else if ( dt > FADE_MAX_STEP ) {

				dt = FADE_MAX_STEP

			}

			manager._lastTick = performance.now() - dt * 1000

		}

		this.tiles.update()

	}

	_advanceTargetLerp( dt ) {

		const lerp = this._targetLerp
		lerp.time += dt
		const u = smootherstep( clamp01( lerp.time / lerp.duration ) )
		const t = this.target

		// spherical interpolation across the surface so the globe turns along a
		// great circle instead of drifting through the poles
		const geo = slerpLatLon( lerp.fromLat, lerp.fromLon, t.latRad, t.lonRad, u, this._geo )
		this.rig.setTarget( geo.lat, geo.lon, lerp.fromAim + ( t.aimHeight - lerp.fromAim ) * u )

		if ( lerp.time >= lerp.duration ) {

			this.rig.setTarget( t.latRad, t.lonRad, t.aimHeight )
			this._targetLerp = null

		}

	}

	_resolveCameraState( dt ) {

		let state

		if ( this.state === 'flying' ) {

			this.shotTime += dt
			const over = this.shotTime - this.shot.duration

			if ( over >= 0 ) {

				const end = this.shot.sample( this.shot.duration, this._stateA )
				if ( this._pitchScale !== 1 ) end.pitch *= this._pitchScale
				this.finish( end )

				// The frame that crosses the end is already a landing frame, `over`
				// seconds in. Resolving it at the shot's clamped end pose instead
				// would repeat the previous frame exactly — `shotTime` accumulates to
				// 23.99999…, so the frame before this one already sampled t=1 — and
				// render one dead frame. That went unnoticed while the landing froze
				// on the next frame anyway; it is the one hitch a landing that
				// carries its velocity through cannot hide.
				this._doneTime = over
				state = this._residual ? this._sampleLanding( over ) : end

			} else {

				state = this.shot.sample( this.shotTime, this._stateA )
				if ( this._pitchScale !== 1 ) state.pitch *= this._pitchScale

			}

		} else if ( this.state === 'loading' ) {

			state = this.shot.sample( this._prerollTime, this._stateA )
			if ( this._pitchScale !== 1 ) state.pitch *= this._pitchScale

		} else if ( this.state === 'done' ) {

			this._doneTime += dt
			state = this._residual
				? this._sampleLanding( this._doneTime )
				: Object.assign( this._stateA, this._doneState )

		} else {

			this.idleTime += dt
			state = this._idleShot.sample( this.idleTime, this._stateA )
			this._centreGlobe( state )

		}

		if ( this._blendFrom ) {

			this._blendTime += dt
			const alpha = clamp01( this._blendTime / this._blendDuration )
			state = blendStates( this._blendFrom, state, alpha, this._stateB )
			if ( alpha >= 1 ) this._blendFrom = null

		}

		return state

	}

	/**
	 * The landing pose `tau` seconds after the flight ended.
	 *
	 * On the same terms as `flying`: the residual reads the shot's own unscaled
	 * pitch, so a backlit preset's shallower approach still applies — and applies
	 * to the rate it hands over, not only to the pose it hands over from.
	 */
	_sampleLanding( tau ) {

		const state = this._residual.sample( tau, this._stateA )
		if ( this._pitchScale !== 1 ) state.pitch *= this._pitchScale
		return state

	}

	/**
	 * Frames the planet rather than the subject.
	 *
	 * The rig always puts the subject dead centre, which is right for a shot and
	 * wrong for the idle screen — it hangs the globe off to one side by however
	 * far the place is from the sub-camera point. Here the residual angle to the
	 * Earth's centre is measured and cancelled with the rig's own look-away
	 * offsets, leaving the subject slightly off-axis and the planet composed.
	 */
	_centreGlobe( state, bias = 0.04 ) {

		state.yaw = 0
		state.tilt = 0
		this.rig.apply( this.camera, state )

		_fwd.set( 0, 0, -1 ).applyQuaternion( this.camera.quaternion )
		_right.set( 1, 0, 0 ).applyQuaternion( this.camera.quaternion )
		_camUp.set( 0, 1, 0 ).applyQuaternion( this.camera.quaternion )
		_toCentre.copy( this.rig.position ).negate().normalize()

		const depth = _toCentre.dot( _fwd )
		if ( depth <= 0 ) return state

		// pan right to bring something on the right back to the middle, tilt up
		// to bring something high back down; the bias leaves the globe sitting a
		// little above centre, clear of the bar
		state.yaw = -Math.atan2( _toCentre.dot( _right ), depth )
		state.tilt = Math.atan2( _toCentre.dot( _camUp ), depth ) - bias

		return state

	}

	/**
	 * Everything that has to change with altitude. Clouds in particular need
	 * this: their ray march degenerates above a few hundred kilometres, so
	 * without a fade they simply blink into existence on the way down.
	 */
	_applyAltitudeLook() {

		const altitude = this.rig.altitude
		const cloudFade = 1 - clamp01( ( altitude - CLOUD_FADE_LOW ) / ( CLOUD_FADE_HIGH - CLOUD_FADE_LOW ) )
		const eased = smootherstep( cloudFade )

		// the live values, not `this.light` — the preset is where the light is
		// heading, these are where it has got to
		const look = this._look

		this.clouds.coverage = look.coverage.value * eased * this.cloudScale
		this.clouds.lightShafts = altitude < 60e3
		this.clouds.haze = altitude < 60e3

		// Cloud shadows are only worth having when the sun is high enough for
		// them to read as shadows. Below about twenty degrees a single deck
		// throws a shadow tens of kilometres long, so the subject we just spent
		// a solve lighting ends up in shade — and the cascade resolution over
		// that distance is poor enough that the penumbra arrives as noise.
		const wantShadow = this.cloudShadows && this.sunElevation >= 18 && altitude < 40e3
		this.aerialPerspective.shadow = wantShadow ? ( this._cloudShadow || null ) : null
		this.aerialPerspective.shadowLength = wantShadow && this.clouds.lightShafts
			? ( this._cloudShadowLength || null )
			: null

		// A single exposure across the whole range either blows out the lit limb
		// from orbit or leaves the ground muddy. Ramp it, then apply the
		// scene-measured correction and the user's bias in stops.
		const near = smootherstep( 1 - clamp01( Math.log10( Math.max( altitude, 100 ) / 1e3 ) / Math.log10( 12e3 ) ) )
		const exposure = EXPOSURE_IN_ORBIT + ( look.exposure.value - EXPOSURE_IN_ORBIT ) * near
		// Capture never enters `flying` — the recorder drives seek/render under
		// `_recording` while state stays idle — so the metered curve has to
		// apply there too, or the file locks the landing exposure for the whole
		// descent (white limb from orbit).
		const metered = ( this.state === 'idle' || this.state === 'free' ) && ! this._recording
			? this.exposureScale
			: this._exposureAt( this.shotTime )
		this.renderer.toneMappingExposure = exposure * metered * Math.pow( 2, this.exposureBias )

		// The flare is screen-space: it thresholds bright pixels and blooms them.
		// From orbit the bright limb of the Earth is the brightest thing on
		// screen, so the ghost lands as an enormous soft disc floating in space.
		// There is no lens flare in a vacuum anyway — switch the pass off until
		// the camera is inside the atmosphere.
		this._flarePass.enabled = altitude < 140e3

		// If the sky shader could not be patched (see patchSkyRayMiss) the only
		// remaining defence against the whole-hemisphere blue field is to stop
		// asking for sky once the camera is above the atmosphere.
		if ( this._skyPatched === false ) {

			this.aerialPerspective.sky = altitude < 90e3

		}
		this.lensFlare.intensity = look.flare.value * this.flareScale * ( 0.35 + 0.65 * near )

		// The starfield is part of the view from space, not of the flight. Left
		// on, the brightest few survive their own transmittance and speckle the
		// daylight sky all the way to the ground, so it dims out high up where
		// the frame is full of Earth and nobody is looking at the sky.
		if ( this.stars ) {

			const starlight = smootherstep( clamp01( ( altitude - STAR_FADE_LOW ) / ( STAR_FADE_HIGH - STAR_FADE_LOW ) ) )
			this.stars.visible = starlight > 0
			this.stars.material.intensity = STAR_INTENSITY * starlight

		}

		// Loosen the detail budget while moving fast and high, tighten it on
		// approach. Cheap, and it keeps the download queue from thrashing.
		if ( ! this._recording ) {

			this._errorTarget = 26 - 12 * near
			this.tiles.errorTarget = this._errorTarget

		}

	}

	/**
	 * Meters the shot and builds an exposure curve for it.
	 *
	 * A single number cannot work. A white desert under a 66-degree sun and a
	 * harbour in cloud shadow are several stops apart, so a fixed value per light
	 * preset blows out one and buries the other. Neither can a single number work
	 * across one flight: at a couple of hundred kilometres the view looks down
	 * through the entire atmospheric column and, with a low sun, the forward
	 * scattering is far brighter than either the planet above it or the city
	 * below — hold the landing exposure through that and the middle of every
	 * descent is a white smear.
	 *
	 * So the shot is sampled at a handful of times, each one solved for the
	 * multiplier that lands it on a cinematic mid-tone, and the result is
	 * smoothed into a curve the flight reads back by time. It is solved once, up
	 * front, which keeps it deterministic — a live auto-exposure would pump, and
	 * the recording would not match the preview.
	 *
	 * The probe frames are drawn and read back inside a single task, so none of
	 * them ever reaches the screen.
	 */
	autoExpose( { target = 0.44, iterations = 4, samples = 5, blend = false } = {} ) {

		if ( ! this.shot ) return null

		const { renderer } = this
		const gl = renderer.getContext()
		const width = renderer.domElement.width
		const height = renderer.domElement.height
		if ( width < 8 || height < 8 ) return null

		// Metering has to see the exact light the flight will fly under. Live
		// launch waits until this commit is visually negligible; recording calls
		// it while the interactive loop is stopped, before its first rendered frame.
		this._commitLook()

		// Sample a band that skips the sky: the subject and the ground are what
		// the exposure has to serve, and a bright sky would drag it dark.
		const y0 = Math.floor( height * 0.12 )
		const rows = Math.max( 1, Math.floor( height * 0.72 ) )
		const size = width * rows * 4
		if ( ! this._exposureBuffer || this._exposureBuffer.length !== size ) {

			this._exposureBuffer = new Uint8Array( size )

		}
		const buffer = this._exposureBuffer

		const savedTime = this.shotTime
		const usesScalarExposure = (
			( this.state === 'idle' || this.state === 'free' ) && ! this._recording
		)
		const fromScale = usesScalarExposure ? this.exposureScale : this._exposureAt( savedTime )
		const curve = []
		this._exposureCurve = null
		this._exposureBlendFrom = null
		this._exposureBlendDuration = 0

		for ( let i = 0; i < samples; i ++ ) {

			// weight the samples towards the end, where the subject is
			const u = samples === 1 ? 1 : Math.pow( i / ( samples - 1 ), 0.8 )
			const time = u * this.shot.duration
			let scale = 1

			for ( let step = 0; step < iterations; step ++ ) {

				this.exposureScale = scale
				this.seek( time )
				this.render( 1 / 30 )
				renderer.setRenderTarget( null )
				gl.readPixels( 0, y0, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, buffer )

				// stride by a prime so the sample never lines up with the tile grid
				let sum = 0
				let count = 0
				for ( let p = 0; p < size; p += 4 * 23 ) {

					sum += ( 0.2126 * buffer[ p ] + 0.7152 * buffer[ p + 1 ] + 0.0722 * buffer[ p + 2 ] ) / 255
					count ++

				}
				const measured = sum / Math.max( count, 1 )
				if ( ! ( measured > 0.002 ) ) break

				// damped, because AgX compresses — a full correction overshoots
				scale = MathUtils.clamp( scale * Math.pow( target / measured, 0.7 ), 0.12, 10 )
				if ( Math.abs( measured - target ) < 0.012 ) break

			}

			curve.push( { time, scale } )

		}

		// One smoothing pass. The samples are solved independently, so without it
		// a single hazy probe puts a visible dip in the middle of the flight.
		const smoothed = curve.map( ( point, i ) => {

			const prev = curve[ Math.max( i - 1, 0 ) ].scale
			const next = curve[ Math.min( i + 1, curve.length - 1 ) ].scale
			return { time: point.time, scale: ( prev + point.scale * 2 + next ) / 4 }

		} )

		this._exposureCurve = smoothed
		this.exposureScale = smoothed[ smoothed.length - 1 ].scale
		// The blend is part of shot time, so live playback and capture make the
		// same move from the already-visible exposure into the metered curve.
		if ( blend ) {

			this._exposureBlendFrom = fromScale
			this._exposureBlendDuration = 1.4

		}
		this.seek( savedTime )
		return smoothed

	}

	/** Reads the metered exposure curve at a shot time, with an optional live ease-in. */
	_exposureAt( time ) {

		const scale = this._exposureCurveAt( time )
		if ( this._exposureBlendFrom == null || ! ( this._exposureBlendDuration > 0 ) ) {

			return scale

		}

		const u = smootherstep( clamp01( time / this._exposureBlendDuration ) )
		return this._exposureBlendFrom * Math.pow( scale / this._exposureBlendFrom, u )

	}

	/** Raw metered curve, ignoring the live ease-in. */
	_exposureCurveAt( time ) {

		const curve = this._exposureCurve
		if ( ! curve || curve.length === 0 ) return this.exposureScale
		if ( time <= curve[ 0 ].time ) return curve[ 0 ].scale

		for ( let i = 1; i < curve.length; i ++ ) {

			if ( time > curve[ i ].time ) continue
			const a = curve[ i - 1 ]
			const b = curve[ i ]
			const u = smootherstep( ( time - a.time ) / Math.max( b.time - a.time, 1e-6 ) )
			return a.scale * Math.pow( b.scale / a.scale, u )

		}

		return curve[ curve.length - 1 ].scale

	}

	render( dt = 0 ) {

		setChainDelta( this._adapters, dt )
		this.renderer.render( this.scene, this.camera )

	}

	// ------------------------------------------------------------- readouts

	readout() {

		const altitude = this.rig.altitude
		return {
			state: this.state,
			altitude,
			progress: this.state === 'flying' && this.shot
				? clamp01( this.shotTime / this.shot.duration )
				: this.state === 'done' ? 1 : 0,
			loadProgress: this.tiles.loadProgress,
			fadingTiles: this.tilesFade?.fadingTiles ?? 0,
			fov: this.camera.fov,
		}

	}

	/**
	 * True when the pipeline has gone completely quiet. The three queues have to
	 * be checked as well as the counters: a tile can be mid-flight through node
	 * processing without yet showing up as queued, downloading or parsing.
	 */
	isSettled() {

		const { tiles } = this
		const s = tiles.stats
		return tiles.root !== null
			&& tiles.isLoading === false
			&& tiles.downloadQueue.running === false
			&& tiles.parseQueue.running === false
			&& tiles.processNodeQueue.running === false
			&& s.queued === 0 && s.downloading === 0 && s.parsing === 0

	}

	/**
	 * Pumps the tile pipeline until the current view stops changing.
	 * A finished parse can enqueue its children, so the quiet state has to hold
	 * for several passes before it counts. Live launch also waits for its light
	 * spring, so the exact metering commit is too small to read as a cut.
	 */
	async settle( { maxWaitMs = 6000, stableFrames = 3, signal, waitForLook = false } = {} ) {

		const started = performance.now()
		let stable = 0
		for ( ;; ) {

			if ( signal?.aborted ) return false

			// dt 0: the shot is not moving while we wait, so neither is the fade
			this._updateTiles( 0 )
			if ( this.isSettled() && ( ! waitForLook || this._isLookSettled() ) ) {

				if ( ++ stable >= stableFrames ) return true

			} else {

				stable = 0

			}
			if ( performance.now() - started > maxWaitMs ) return false
			await new Promise( resolve => setTimeout( resolve, 16 ) )

		}

	}

	/**
	 * Reads the true ground height under the target off the loaded tiles.
	 *
	 * Only for pasted coordinates. The curated landmarks carry a hand-checked
	 * ground height and a deliberate look-at offset, and a probe would override
	 * both — a ray dropped on the Eiffel Tower hits the Eiffel Tower, not Paris,
	 * and lifts the whole shot 250 metres.
	 *
	 * Even for an arbitrary point, one ray is not enough: it might land on a
	 * roof. A ring of samples around the point, reduced by median, gives the
	 * local terrain and shrugs off both buildings and stray misses.
	 */
	probeGround( { radius, samples = 8, minHits = 5 } = {} ) {

		const t = this.target
		if ( ! t || ! t.needsGroundProbe ) return null

		const { ellipsoid } = this.tiles
		const raycaster = this._raycaster || ( this._raycaster = new Raycaster() )
		raycaster.firstHitOnly = true

		const ring = radius ?? Math.max( 80, ( t.orbitRadius || 600 ) * 0.35 )
		const hits = []
		ellipsoid.getCartographicToPosition( t.latRad, t.lonRad, 14000, _probeOrigin )
		getEastNorthUpAxes( ellipsoid, t.latRad, t.lonRad, _east, _north, _up )

		for ( let i = 0; i <= samples; i ++ ) {

			// index 0 is the point itself; the rest are a ring around it
			const angle = i === 0 ? 0 : ( i - 1 ) / samples * Math.PI * 2
			const offset = i === 0 ? 0 : ring
			_pos.copy( _probeOrigin )
				.addScaledVector( _north, offset * Math.cos( angle ) )
				.addScaledVector( _east, offset * Math.sin( angle ) )
			ellipsoid.getPositionToNormal( _pos, _up )
			raycaster.set( _pos, _up.multiplyScalar( -1 ) )

			const hit = raycaster.intersectObject( this.tiles.group, true )[ 0 ]
			if ( hit ) hits.push( ellipsoid.getPositionElevation( hit.point ) )

		}

		// A single hit on the coarse shell is how pasted coords used to clear
		// the probe and bury the camera. Demand a real ring of samples.
		if ( hits.length < minHits ) return null

		hits.sort( ( a, b ) => a - b )
		const ground = hits[ hits.length >> 1 ]
		if ( ! isFinite( ground ) ) return null

		const delta = ground - t.groundHeight
		t.groundHeight = ground
		t.aimHeight = ground + t.lookAtHeight
		t.minHeight = ground + Math.max( 40, t.lookAtHeight > 0 ? t.lookAtHeight * 0.18 : 40 )
		this.rig.minHeight = t.minHeight
		this._repoint()

		return { groundHeight: ground, delta, samples: hits.length }

	}

	// --------------------------------------------------------------- resize

	_aspect() {

		return window.innerWidth / Math.max( window.innerHeight, 1 )

	}

	resize( width = window.innerWidth, height = window.innerHeight, pixelRatio ) {

		const w = Math.max( 1, Math.floor( width ) )
		const h = Math.max( 1, Math.floor( height ) )
		this._sizedTo = w * 100000 + h

		this.camera.aspect = w / h
		this.camera.updateProjectionMatrix()
		if ( pixelRatio !== undefined ) this.renderer.setPixelRatio( pixelRatio )
		this.renderer.setSize( w, h, true )
		this.tiles.setResolutionFromRenderer( this.camera, this.renderer )

	}

	/**
	 * A page that starts life in a background tab reports a viewport of zero,
	 * which leaves the tile renderer with no screen-space error budget and so no
	 * tiles at all — permanently, because nothing else would ever re-measure.
	 * Re-checking the size costs two property reads a frame and makes that
	 * unrecoverable state impossible.
	 */
	_ensureSized() {

		if ( this._recording ) return
		const w = window.innerWidth
		const h = window.innerHeight
		if ( w < 1 || h < 1 ) return
		if ( this._sizedTo === w * 100000 + h ) return
		this.resize( w, h )

	}

	/**
	 * Switches to an exact pixel size for capture, ignoring the CSS box.
	 *
	 * `pixelRatio` supersamples the drawing buffer the way a retina preview does
	 * — capture used to force 1, which dropped that free AA and left SMAA alone
	 * against stair-stepped tile silhouettes. The recorder downsamples back to
	 * `width`×`height` before encoding when the ratio is above one.
	 */
	setCaptureSize( width, height, pixelRatio = 1 ) {

		this._restore = {
			pixelRatio: this.renderer.getPixelRatio(),
			width: window.innerWidth,
			height: window.innerHeight,
		}
		this._recording = true
		this.renderer.setPixelRatio( pixelRatio )
		this.camera.aspect = width / height
		this.camera.updateProjectionMatrix()
		this.renderer.setSize( width, height, false )
		this.tiles.setResolutionFromRenderer( this.camera, this.renderer )

	}

	restoreSize() {

		if ( ! this._restore ) return
		const { pixelRatio, width, height } = this._restore
		this._restore = null
		this._recording = false
		this.renderer.setPixelRatio( pixelRatio )
		this.resize( width, height )

	}

	/** Jumps the flight to an absolute time. Used by the frame-locked recorder. */
	seek( time ) {

		this._ensureSized()
		// A seek has no clock to ease against, and the recorder only ever seeks —
		// so a globe still swinging back onto the subject is resolved here rather
		// than left parked wherever the viewer had turned it.
		if ( this._targetLerp ) this._advanceTargetLerp( this._targetLerp.duration )

		// The fade runs on shot time, so a run of consecutive recorder frames
		// steps it forward by exactly one frame each, a re-seek to the same
		// instant leaves it alone, and anything else is a cut.
		const dt = time - this.shotTime
		this.shotTime = time
		const state = this.shot.sample( time, this._stateA )
		if ( this._pitchScale !== 1 ) state.pitch *= this._pitchScale
		this.rig.apply( this.camera, state )
		this.controls.adjustCamera( this.camera )
		this._live = state
		this._applyAltitudeLook()
		const cut = ! ( dt >= 0 ) || dt > FADE_CUT_STEP
		this._updateTiles( cut ? 0 : dt, cut )

	}

}

/**
 * Fixes an upstream sky artifact that only shows up from orbit.
 *
 * `GetSkyRadiance` decides whether a view ray meets the atmosphere with
 *
 *   distance = -rmu - SafeSqrt(rmu² - r² + top²)
 *   if (distance > 0) { move the camera to the shell }
 *   else if (r > top) { return 0 }
 *
 * `SafeSqrt` clamps a negative discriminant to zero, so for a ray that misses
 * the shell entirely the expression collapses to `-rmu`, which is positive for
 * any ray angled towards the planet. The camera is then teleported onto the
 * atmosphere boundary and the shader returns the sky as seen from inside it —
 * so from twenty thousand kilometres out, the entire planet-facing half of the
 * frame fills with daylight blue and the Earth floats in the middle of it.
 *
 * The `r > top` guard was meant to catch exactly this case and is unreachable.
 * Restoring the discriminant test to the branch condition costs nothing and
 * changes no in-atmosphere behaviour, since there the discriminant is positive
 * by construction.
 *
 * Everything that reads the sky carries its own copy of the function, so both
 * the aerial perspective effect and the stars have to be patched.
 *
 * Patches the shader source rather than the compiled program: postprocessing
 * reassembles an effect's material whenever the pass updates, which silently
 * reverts anything written there. A material keeps the source it was given and
 * only needs flagging for a recompile.
 *
 * Returns whether the patch matched, so the caller can fall back if a future
 * version of the package rewrites this function.
 */
function patchSkyRayMiss( target, subject ) {

	const FROM = 'if (distance_to_top_atmosphere_boundary > 0.0 * m) {'
	const TO = 'if (rmu * rmu + atmosphere.top_radius * atmosphere.top_radius >= r * r && '
		+ 'distance_to_top_atmosphere_boundary > 0.0 * m) {'

	const source = target.fragmentShader
	if ( typeof source !== 'string' || ! source.includes( FROM ) ) {

		console.warn( `World: could not patch the ray-miss guard on the ${subject}.` )
		return false

	}

	target.fragmentShader = source.split( FROM ).join( TO )
	if ( target.isMaterial ) target.needsUpdate = true
	return true

}

/**
 * Pins the starfield to the far end of the depth range.
 *
 * The stars are points on a sphere of radius `cameraFar` drawn around the
 * camera — and the shader normalises a vec4 rather than a vec3, so the radius
 * actually lands at 1/√2 of that. Inside the atmosphere the near plane is
 * metres away and none of it matters. From orbit it decides the whole view:
 * GlobeControls fits the planes tightly around the globe — at the idle distance
 * near is about two thirds of far — the sphere falls between them, and every
 * star more than ~18° off axis is in front of the near plane and clipped. The
 * survivors sit in a narrow cone around the view axis, which is precisely where
 * the Earth is, and the shader's own ground test discards those. The result is
 * a sky with a handful of stars in it, all of them hugging the limb.
 *
 * Writing a constant clip-space depth is the usual skybox answer: it takes both
 * planes out of the question while still leaving a depth for the aerial
 * perspective pass to read, which is what stops the sky compositing over the
 * stars. Their distance is a fiction anyway — the field is a backdrop.
 */
function patchStarDepth( material ) {

	const FROM = 'vec4(cameraPosition + worldDirection * cameraFar, 1.0);'
	const TO = FROM + '\n  gl_Position.z = gl_Position.w * 0.999;'

	const source = material.vertexShader
	if ( typeof source !== 'string' || ! source.includes( FROM ) ) {

		console.warn( 'World: could not pin the star depth; the field will be clipped from orbit.' )
		return false

	}

	material.vertexShader = source.split( FROM ).join( TO )
	material.needsUpdate = true
	return true

}

function hashString( text ) {

	let hash = 0
	for ( let i = 0; i < String( text ).length; i ++ ) hash = ( hash * 31 + text.charCodeAt( i ) ) | 0
	return Math.abs( hash % 1000 ) / 1000

}

/** Folds an angle back into (-PI, PI], so a spun globe never runs out of range. */
function wrapAngle( angle ) {

	const TAU = Math.PI * 2
	return ( ( angle + Math.PI ) % TAU + TAU ) % TAU - Math.PI

}

function slerpLatLon( lat0, lon0, lat1, lon1, t, out ) {

	const x0 = Math.cos( lat0 ) * Math.cos( lon0 )
	const y0 = Math.cos( lat0 ) * Math.sin( lon0 )
	const z0 = Math.sin( lat0 )
	const x1 = Math.cos( lat1 ) * Math.cos( lon1 )
	const y1 = Math.cos( lat1 ) * Math.sin( lon1 )
	const z1 = Math.sin( lat1 )

	const dot = MathUtils.clamp( x0 * x1 + y0 * y1 + z0 * z1, -1, 1 )

	// The usual weighted form divides by sin(omega), which collapses at an
	// antipode. Use a tangent basis there; an exact antipode gets a deterministic
	// great circle through a stable Cartesian axis.
	if ( dot < -0.999999 ) {

		let tx = x1 - dot * x0
		let ty = y1 - dot * y0
		let tz = z1 - dot * z0
		let tangentLength = Math.hypot( tx, ty, tz )
		let omega

		if ( tangentLength < 1e-12 ) {

			if ( Math.abs( x0 ) > Math.abs( z0 ) ) {

				tx = -y0
				ty = x0
				tz = 0

			} else {

				tx = 0
				ty = -z0
				tz = y0

			}

			tangentLength = Math.hypot( tx, ty, tz )
			omega = Math.PI

		} else {

			omega = Math.atan2( tangentLength, dot )

		}

		tx /= tangentLength
		ty /= tangentLength
		tz /= tangentLength
		const c = Math.cos( omega * t )
		const s = Math.sin( omega * t )
		const x = x0 * c + tx * s
		const y = y0 * c + ty * s
		const z = z0 * c + tz * s

		out.lat = Math.atan2( z, Math.hypot( x, y ) )
		out.lon = Math.atan2( y, x )
		return out

	}

	const omega = Math.acos( dot )

	let a = 1 - t
	let b = t
	if ( omega > 1e-6 ) {

		const s = Math.sin( omega )
		a = Math.sin( ( 1 - t ) * omega ) / s
		b = Math.sin( t * omega ) / s

	}

	const x = x0 * a + x1 * b
	const y = y0 * a + y1 * b
	const z = z0 * a + z1 * b

	out.lat = Math.atan2( z, Math.hypot( x, y ) )
	out.lon = Math.atan2( y, x )
	return out

}
