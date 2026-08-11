import {
	BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality,
	WebMOutputFormat, canEncodeVideo, getFirstEncodableVideoCodec,
} from 'mediabunny'

/**
 * Frame-locked capture.
 *
 * The flight is re-run on a virtual clock rather than the wall clock: the world
 * is seeked to frame N/fps, the tile pipeline is given a chance to catch up,
 * the frame is rendered and handed straight to a hardware video encoder. That
 * decoupling is the whole point — the export is smooth at exactly the requested
 * frame rate no matter how long any individual frame took to produce, and every
 * frame gets the geometry it deserves instead of whatever had streamed in by
 * the time the clock reached it.
 *
 * `CanvasSource.add()` snapshots the canvas synchronously and then resolves once
 * the encoder and muxer have room, which makes awaiting it both the frame grab
 * and the backpressure valve. Nothing may await between `render()` and `add()`
 * or the drawing buffer will already have been cleared.
 */

const RESOLUTIONS = {
	720: 1280,
	1080: 1920,
	1440: 2560,
	2160: 3840,
}

// Live preview renders at up to 2× DPR and the browser downscales into the CSS
// box — that is most of the AA the eye sees. Capture used to force ratio 1, so
// the file looked crunchy next to the same flight on screen. Supersample the
// drawing buffer and bilinear-downsample into the encode canvas; cap so a 4K
// export does not become an 8K render.
const SUPER_SAMPLE = { fast: 1, balanced: 2, best: 2 }
const SUPER_SAMPLE_MAX_LONG = 3840

/** H.264 and HEVC reject odd dimensions outright. */
const even = value => Math.round( value / 2 ) * 2

function capturePixelRatio( width, height, quality ) {

	const wanted = SUPER_SAMPLE[ quality ] ?? 2
	if ( wanted <= 1 ) return 1
	const long = Math.max( width, height )
	// Keep the drawing-buffer long edge ≤ 4K so a 1440p export can still run
	// at 1.5× instead of falling back to crunchy 1×.
	return Math.min( wanted, SUPER_SAMPLE_MAX_LONG / long )

}

function makeEncodeCanvas( width, height ) {

	if ( typeof OffscreenCanvas !== 'undefined' ) {

		return new OffscreenCanvas( width, height )

	}

	const canvas = document.createElement( 'canvas' )
	canvas.width = width
	canvas.height = height
	return canvas

}

export function captureSize( { resolution = 1080, aspect = 16 / 9 } = {} ) {

	// The named resolution is the long edge, so a vertical or square frame keeps
	// the same pixel budget instead of becoming a postage stamp — and 1080p
	// scope comes out exactly 1920 wide rather than 1922.
	const long = RESOLUTIONS[ resolution ] || 1920
	return aspect >= 1
		? { width: even( long ), height: even( long / aspect ) }
		: { width: even( long * aspect ), height: even( long ) }

}

export async function bestCodec( { width, height } ) {

	const codec = await getFirstEncodableVideoCodec( [ 'avc', 'hevc', 'av1', 'vp9' ], {
		width, height, quality: new Quality( 'high' ),
	} )
	if ( codec !== null ) return codec
	return ( await canEncodeVideo( 'vp8', { width, height } ) ) ? 'vp8' : null

}

export class Recorder {

	constructor( world ) {

		this.world = world
		this.active = false
		this.cancelled = false
		this.result = null

	}

	cancel() {

		this.cancelled = true

	}

	/**
	 * @param {object} opts
	 * @param {number} opts.resolution 720 | 1080 | 1440 | 2160
	 * @param {number} opts.fps
	 * @param {number} opts.aspect Width over height.
	 * @param {'fast'|'balanced'|'best'} opts.quality How long to let the tiles
	 *   catch up before each frame is committed.
	 * @param {(info: object) => void} [opts.onProgress]
	 */
	async record( {
		resolution = 1080,
		fps = 30,
		aspect = 16 / 9,
		quality = 'balanced',
		onProgress,
	} = {} ) {

		const { world } = this
		if ( this.active || ! world.shot ) return null

		this.active = true
		this.cancelled = false
		this.result = null

		const restoreState = world.state
		const restoreTime = world.shotTime
		let captureStarted = false
		let lastCommittedTime = null
		let output = null

		try {

			const { width, height } = captureSize( { resolution, aspect } )
			const codec = await bestCodec( { width, height } )
			if ( codec === null ) throw new Error( 'This browser cannot encode video at that size.' )

			const usesMp4 = codec !== 'vp8'
			const totalFrames = Math.max( 1, Math.round( world.shot.duration * fps ) )
			const frameDuration = 1 / fps
			const pixelRatio = capturePixelRatio( width, height, quality )

			// Per-frame patience. `best` waits for the pipeline to go quiet on every
			// single frame; `fast` never waits and takes whatever has streamed in.
			const settleBudget = quality === 'best' ? 2500 : quality === 'balanced' ? 220 : 0

			world.setCaptureSize( width, height, pixelRatio )
			captureStarted = true
			this._tuneTilesForCapture()

			// Encode from a 1× canvas. When the world is supersampled, each frame
			// is drawn down into this before `add()` — same contract as before:
			// nothing may await between `render()` and the snapshot.
			const encodeCanvas = pixelRatio > 1
				? makeEncodeCanvas( width, height )
				: world.renderer.domElement
			const encodeCtx = pixelRatio > 1
				? encodeCanvas.getContext( '2d', { alpha: false } )
				: null

			const target = new BufferTarget()
			output = new Output( {
				format: usesMp4
					? new Mp4OutputFormat( { fastStart: 'in-memory' } )
					: new WebMOutputFormat(),
				target,
			} )
			const source = new CanvasSource( encodeCanvas, {
				codec,
				quality: new Quality( 'high' ),
				keyFrameInterval: 1,
				latencyMode: 'quality',
				sizeChangeBehavior: 'deny',
				...( codec === 'avc' ? { fullCodecString: 'avc1.640033' } : {} ),
			} )
			output.addVideoTrack( source, { frameRate: fps } )
			await output.start()

			const started = performance.now()

			const commitFrame = ( time ) => {

				world.render( frameDuration )
				if ( encodeCtx ) {

					encodeCtx.drawImage( world.renderer.domElement, 0, 0, width, height )

				}
				return source.add( time, frameDuration )

			}

			// Prime the first frame properly: everything that streams, streams,
			// and the clouds get a few passes at the capture resolution before
			// anything is committed. SMAA is spatial and has no history to warm.
			world.seek( world.shot.duration )
			await world.settle( { maxWaitMs: quality === 'fast' ? 1500 : 12000 } )
			// meter at the capture resolution, since the exposure has to match
			// what actually gets encoded
			world.autoExpose( { blend: true } )

			world.seek( 0 )
			// Replace the final metering probe before yielding to the browser. The
			// probe loop is synchronous, but the settle below is not.
			world.render( frameDuration )
			await world.settle( { maxWaitMs: quality === 'fast' ? 1500 : 12000 } )
			for ( let i = 0; i < 12; i ++ ) {

				world.seek( 0 )
				world.render( frameDuration )

			}

			for ( let frame = 0; frame < totalFrames; frame ++ ) {

				if ( this.cancelled ) break

				const time = frame / fps
				world.seek( time )

				if ( settleBudget > 0 && ! world.isSettled() ) {

					await world.settle( { maxWaitMs: settleBudget, stableFrames: 2 } )
					world.seek( time )

				}
				if ( this.cancelled ) break

				await commitFrame( time )
				lastCommittedTime = time

				if ( onProgress ) onProgress( {
					frame: frame + 1,
					totalFrames,
					shotTime: time,
					duration: world.shot.duration,
					elapsed: ( performance.now() - started ) / 1000,
					rate: ( time + frameDuration ) / Math.max( ( performance.now() - started ) / 1000, 1e-3 ),
				} )

			}

			if ( this.cancelled ) {

				await output.cancel()
				return null

			}

			await output.finalize()

			this.result = {
				blob: new Blob( [ target.buffer ], { type: usesMp4 ? 'video/mp4' : 'video/webm' } ),
				extension: usesMp4 ? 'mp4' : 'webm',
				width,
				height,
				fps,
				codec,
				duration: world.shot.duration,
			}
			return this.result

		} catch ( error ) {

			if ( output ) {

				try {

					await output.cancel()

				} catch {}

			}
			throw error

		} finally {

			this.active = false
			this._restoreTiles()
			world.restoreSize()
			// Hold the exact last frame the encoder accepted. The nominal duration
			// is one frame beyond it; seeking there made Stop advance the camera and
			// exposure before the preview resumed. If capture failed before a frame
			// was accepted, restore the pre-capture shot time instead.
			if ( captureStarted && world.shot ) {

				world.seek( lastCommittedTime ?? restoreTime )

			}
			world.state = restoreState

		}

	}

	_tuneTilesForCapture() {

		const { tiles } = this.world
		this._saved = {
			errorTarget: tiles.errorTarget,
			maxBytes: tiles.lruCache.maxBytesSize,
			minBytes: tiles.lruCache.minBytesSize,
			parseJobs: tiles.parseQueue.maxJobs,
		}

		// LOD fades stay on: World._updateTiles() advances TilesFadePlugin on
		// the shot clock, so a fixed-timestep capture gets the same crossfade
		// as a live flight instead of a wall-clock slam or a hard pop.

		tiles.errorTarget = 8
		tiles.lruCache.minBytesSize = 1.6 * 2 ** 30
		tiles.lruCache.maxBytesSize = 2.2 * 2 ** 30
		tiles.parseQueue.maxJobs = 14

	}

	_restoreTiles() {

		const { tiles } = this.world
		const saved = this._saved
		if ( ! saved ) return
		tiles.errorTarget = saved.errorTarget
		tiles.lruCache.maxBytesSize = saved.maxBytes
		tiles.lruCache.minBytesSize = saved.minBytes
		tiles.parseQueue.maxJobs = saved.parseJobs
		this._saved = null

	}

}

export function downloadRecording( result, name = 'cinematic-world' ) {

	if ( ! result?.blob ) return
	const base = String( name || 'cinematic-world' ).replace( /\.[^.]+$/, '' ) || 'cinematic-world'
	const url = URL.createObjectURL( result.blob )
	const link = document.createElement( 'a' )
	link.href = url
	link.download = `${base}.${result.extension}`
	link.rel = 'noopener'
	document.body.appendChild( link )
	link.click()
	link.remove()
	// Keep the object URL alive long enough for a slow download to start —
	// especially for large 4K exports.
	setTimeout( () => URL.revokeObjectURL( url ), 60_000 )

}
