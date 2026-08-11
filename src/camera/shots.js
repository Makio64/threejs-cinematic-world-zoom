import { MathUtils } from 'three'

import {
	bezier, clamp01, coast, coastFromRest, delayed,
	mixLog, settleSpan, sineInOut, smootherstep, smoothTrack, track,
} from './easing.js'

const D2R = MathUtils.DEG2RAD

/**
 * Shot library.
 *
 * A shot is a set of independent channels over normalised time. They are
 * deliberately *not* driven by one shared curve: the eye reads a move as
 * authored when the distance, the rotation and the lens each arrive on their
 * own schedule. Distance is always interpolated geometrically, because what
 * feels like a constant zoom rate is a constant rate of change of log(distance).
 *
 * Every channel is a pure function of t, so a shot can be sampled at an
 * arbitrary virtual time — which is what makes frame-locked recording possible.
 */

/**
 * Where every flight begins. Far enough that the whole planet sits inside the
 * frame with margin at the widest lens any shot opens on — at 1.4e7 the disc
 * was larger than the frame and every shot started on a cropped Earth.
 */
export const SPACE_DISTANCE = 2.0e7

/**
 * The bearing that puts north at the top of the frame.
 *
 * Azimuth is the compass bearing of the *camera* as seen from the subject, and
 * the rig's screen-up is `-sin(pitch)*h + cos(pitch)*up` — so a camera due
 * north of the subject (azimuth 0) looks south and hangs the planet upside
 * down. Sitting due south of it and looking north is what reads as a map: east
 * to the right, north up, continents where you expect them.
 */
export const NORTH_UP = Math.PI

/**
 * The eye-to-subject distance inside which the camera is let off north-up.
 *
 * Above it the Earth reads as a globe: the limb is in or near the frame, the
 * continents are the subject, and a bearing that has already turned hangs the
 * whole map at an angle. At five thousand kilometres the disc is 68° wide
 * against a 34-62° lens, so it fills the frame and there is no mistaking it for
 * terrain.
 */
const NORTH_HOLD_DISTANCE = 5.0e6

/** How gently a landing gives up its exit velocity, in seconds. */
const SETTLE_TIME = 2.2

/** How long the landing takes to forget its exit turn rate, in seconds. */
const TURN_SETTLE_TIME = 3.5

/**
 * How far a landing is allowed to still travel, per channel: a distance ratio in
 * log space, degrees of pitch, and the shortest lens it may close onto.
 *
 * A flight that runs to the end arrives slowly enough that none of these bind.
 * An abort does not — stopped at its steepest, a dive carries fourteen times the
 * log-distance rate it would have landed on, and left alone the landing would
 * coast most of an order of magnitude further in.
 */
const SETTLE_LOG_SPAN = 0.35
const SETTLE_PITCH_SPAN = 25
const SETTLE_MIN_FOV = 8

const deg = v => v * D2R

/**
 * Signed rotation from `from` to a bearing congruent with `to`, choosing the
 * turn nearest to `approx`. Keeps large authored sweeps (an orbit's 320°) from
 * collapsing to a short the-other-way spin, while still landing on `to`.
 */
function rotationNear( from, to, approx ) {

	const TAU = Math.PI * 2
	const delta = to - from
	return delta - TAU * Math.round( ( delta - approx ) / TAU )

}

/**
 * First `t` at which a 0..1 progress curve reaches `value`.
 *
 * Bracketed by a coarse scan before bisecting, so a curve that overshoots and
 * comes back — flyby's distance does — yields its *first* crossing rather than
 * whichever one bisection happens to fall into. Runs once, when a shot is built.
 */
function solveProgressTime( curve, value ) {

	if ( value <= 0 ) return 0

	const steps = 256
	let lo = 0, hi = -1
	for ( let i = 1; i <= steps; i ++ ) {

		if ( curve( i / steps ) < value ) continue
		lo = ( i - 1 ) / steps
		hi = i / steps
		break

	}

	if ( hi < 0 ) return 1

	for ( let i = 0; i < 24; i ++ ) {

		const mid = ( lo + hi ) / 2
		if ( curve( mid ) >= value ) hi = mid
		else lo = mid

	}

	return hi

}

/** Deterministic band-limited noise. Same t always gives the same value. */
function noise( t, seed ) {

	return (
		0.62 * Math.sin( t * 2.3 + seed * 12.9898 ) +
		0.27 * Math.sin( t * 5.7 + seed * 78.233 ) +
		0.11 * Math.sin( t * 11.3 + seed * 39.425 )
	)

}

/**
 * The dive's pull-up: flat until just past halfway, then one soft arc onto the
 * final framing. Keeps a little exit rate so the landing drifts instead of
 * freezing level on the last beat.
 */
const pullUp = delayed( 0.52, bezier( 0.55, 0, 0.22, 0.86 ) )

export const SHOTS = {

	dive: {
		name: 'Dive',
		tagline: 'Straight down from orbit, pulling up at the last moment',
		duration: 24,
		sweep: 80,
		endFov: 58,
		// Commit from the first frame and accelerate through the fall. The old
		// hang-then-plunge eased to a stop at ~¼ of the shot before dropping,
		// which read as two beats instead of one dive. Soft land with residual
		// rate so the residual orbit can take over.
		distance: bezier( 0.45, 0.08, 0.28, 0.88 ),
		// One continuous gesture: a forward lean while falling, then a single
		// soft arc onto the final framing. A little residual rate keeps the cut
		// alive.
		pitch: t => 88 - 8 * sineInOut( clamp01( t / 0.5 ) ) - 66 * pullUp( t ),
		// `coastFromRest`, not `coast`: under a delay, coast's 0.036 start slope
		// is a rate step at the exact frame the turn begins
		azimuth: delayed( 0.52, coastFromRest ),
		// the lens opens with the pull-up, on the same clock as the pitch
		fov: t => 30 + 8 * sineInOut( clamp01( t / 0.5 ) ) + 20 * pullUp( t ),
		// banks into the pull-up and settles level — sin² is flat at both ends
		roll: t => 7 * Math.sin( Math.PI * clamp01( ( t - 0.52 ) / 0.48 ) ) ** 2,
		handheld: 0.85,
	},

	descent: {
		name: 'Descent',
		tagline: 'A long fall out of orbit, settling into a slow drift',
		duration: 28,
		sweep: 160,
		endFov: 52,
		// a near-steady rate of change of log-distance that still drifts at the
		// cut, so the fall hands off into the residual orbit instead of stalling
		distance: coast,
		pitch: smoothTrack( [ [ 0, 62 ], [ 0.5, 45 ], [ 1, 24 ] ], 0.35 ),
		azimuth: coast,
		fov: smoothTrack( [ [ 0, 36 ], [ 0.34, 40 ], [ 1, 52 ] ], 0.25 ),
		roll: t => 2.4 * Math.sin( Math.PI * t ) ** 2,
		handheld: 0.5,
	},

	orbit: {
		name: 'Orbit',
		tagline: 'Drops hard, then circles the subject on a long lens',
		duration: 32,
		sweep: 320,
		endFov: 44,
		// most of the altitude goes in the first half, then a gentle close
		// approach — azimuth keeps circling through the cut as one gesture,
		// not a held drop followed by a sudden spin
		distance: smoothTrack( [ [ 0, 0 ], [ 0.45, 0.8 ], [ 1, 1 ] ], 0.3 ),
		pitch: smoothTrack( [ [ 0, 76 ], [ 0.44, 32 ], [ 1, 16 ] ], 0.3 ),
		azimuth: smoothTrack( [ [ 0, 0 ], [ 0.4, 0.38 ], [ 1, 1 ] ], 0.55 ),
		fov: smoothTrack( [ [ 0, 40 ], [ 0.44, 47 ], [ 1, 44 ] ] ),
		roll: t => 1.6 * Math.sin( Math.PI * t ) ** 2,
		handheld: 0.4,
	},

	flyby: {
		name: 'Flyby',
		tagline: 'Comes in low and fast, overshoots, banks back around',
		duration: 26,
		sweep: 215,
		endFov: 58,
		// closest approach happens before the end, then it pulls back out —
		// the overshoot apex is a turnaround, which smoothTrack keeps flat.
		// Distance settles; azimuth and pitch keep a little exit rate so the
		// bank-around doesn't die as the roll levels out.
		distance: smoothTrack( [ [ 0, 0 ], [ 0.5, 0.72 ], [ 0.8, 1.08 ], [ 1, 1 ] ] ),
		pitch: smoothTrack( [ [ 0, 70 ], [ 0.6, 20 ], [ 0.82, 5 ], [ 1, 13 ] ], 0.35 ),
		azimuth: smoothTrack( [ [ 0, 0 ], [ 0.56, 0.18 ], [ 0.86, 0.84 ], [ 1, 1 ] ], 0.45 ),
		fov: smoothTrack( [ [ 0, 34 ], [ 0.56, 44 ], [ 0.82, 66 ], [ 1, 58 ] ] ),
		roll: smoothTrack( [ [ 0, 0 ], [ 0.58, 2 ], [ 0.78, 13 ], [ 0.94, 4 ], [ 1, 0 ] ] ),
		handheld: 1.3,
	},

	hyperzoom: {
		name: 'Hyperzoom',
		tagline: 'Barely moves. The lens does all the work',
		duration: 22,
		sweep: 26,
		endFov: 11,
		// stays much further out — the long lens supplies the magnification
		endDistanceScale: 2.6,
		distance: bezier( 0.5, 0, 0.38, 0.9 ),
		pitch: track( [ [ 0, 44 ], [ 1, 28 ] ], coast ),
		azimuth: coast,
		fov: smoothTrack( [ [ 0, 62 ], [ 0.22, 50 ], [ 1, 11 ] ], 0.2 ),
		roll: () => 0,
		handheld: 0.25,
	},

}

export const SHOT_KEYS = Object.keys( SHOTS )

/**
 * Binds a shot preset to a subject and returns a sampler.
 *
 * @param {object} opts
 * @param {string} opts.preset Key into {@link SHOTS}.
 * @param {number} opts.endAzimuth Compass bearing (radians) the camera should
 *   finish on. Derived from the sun so the light lands where we want it, which
 *   means the *start* bearing is what gets back-solved from the sweep.
 * @param {number} opts.endDistance Final eye-to-subject distance in metres.
 * @param {number} [opts.startDistance=SPACE_DISTANCE]
 * @param {number} [opts.duration] Overrides the preset's own duration.
 * @param {number} [opts.handheld=1] Global multiplier on the handheld drift.
 * @param {number} [opts.seed=0]
 */
export function createShot( {
	preset = 'descent',
	endAzimuth = 0,
	endDistance = 900,
	startDistance = SPACE_DISTANCE,
	duration,
	handheld = 1,
	seed = 0,
} = {} ) {

	const shot = SHOTS[ preset ] || SHOTS.descent
	const d1 = endDistance * ( shot.endDistanceScale || 1 )
	const d0 = Math.max( startDistance, d1 * 10 )
	const sweep = deg( shot.sweep )
	const totalDuration = duration || shot.duration
	const logSpan = Math.log( d0 / d1 )
	const drift = handheld * ( shot.handheld ?? 1 )

	// One azimuth channel from north-up to the light-solved landing bearing.
	// An overlay "north hold" on top of the authored sweep could cancel it mid
	// shot (orbit especially: start spinning, stall, spin again). Folding both
	// into a single turn nearest the authored sweep keeps the rate the sign of
	// the curve — establishing still opens north-up because every preset's
	// azimuth curve starts flat or delayed.
	const azimuthTravel = rotationNear( NORTH_UP, endAzimuth, sweep )

	// distance channel: presets return either a plain 0..1 progress or, for the
	// overshoot shots, a value that can exceed 1 — both are fed through the same
	// geometric interpolation so an overshoot reads as "flew past it"
	const sampleDistance = t => mixLog( d0, d1, shot.distance( t ) )

	// North-up hold: the bearing stays put until the camera is inside
	// `NORTH_HOLD_DISTANCE`, then eases across all of the time that is left.
	//
	// The *hold* is keyed to distance, because `t` does not know how high the
	// camera is — the same t=0.2 is 5 000 km into a descent and 200 km into an
	// orbit, so a hold authored in normalised time releases too late on one preset
	// and too early on another. `dive` is the proof: the one preset that held
	// north before this existed, with a hand-tuned `delayed( 0.52, … )` that means
	// nothing on any of the other four. This is that hold, derived rather than
	// guessed, and it leaves dive's own authored beat exactly where it was.
	//
	// The *release* is keyed to time, and that is the part worth not rewriting.
	// The suppressed sweep has to be given back somewhere. Handing it back over a
	// second distance band spends it while the camera crosses a few hundred
	// kilometres — measured at 0.8 to 1.3 frame-widths per second, a whip pan high
	// up where there is nothing to whip past. Spread over the rest of the shot it
	// costs a fifth of that, and it lands the sweep low down where the move was
	// already going fastest and where there is finally something to sweep past.
	//
	// It multiplies the authored progress rather than overlaying a counter-turn on
	// top of it. A product of two non-decreasing curves is non-decreasing, so the
	// sweep can never reverse mid shot — the failure mode an overlay has, and the
	// reason there is a warning against one. The gate is exactly 1 at t=1, so the
	// shot still lands exactly on `endAzimuth`; its slope is 0 there, so the
	// authored exit rate survives intact for the landing to pick up.
	const holdUntil = Math.min(
		solveProgressTime( shot.distance, clamp01( Math.log( d0 / NORTH_HOLD_DISTANCE ) / logSpan ) ),
		0.9,
	)
	const northGate = delayed( holdUntil, smootherstep )

	/** The authored channels, with no handheld drift on them. */
	const sampleChannels = ( time, out ) => {

		const t = clamp01( time / totalDuration )

		out.distance = sampleDistance( t )
		out.azimuth = NORTH_UP + azimuthTravel * shot.azimuth( t ) * northGate( t )
		out.pitch = deg( shot.pitch( t ) )
		out.roll = deg( shot.roll( t ) )
		out.fov = shot.fov( t )
		out.yaw = shot.yaw ? shot.yaw( t ) : 0
		out.tilt = shot.tilt ? shot.tilt( t ) : 0
		out.t = t
		return out

	}

	/**
	 * Handheld drift, on top of the authored channels. Scaled by how far into the
	 * descent we are, so the planet never wobbles, and by fov, so the shake stays
	 * constant in screen space instead of growing as the lens gets long.
	 *
	 * Runs off the raw clock rather than the clamped one, so it keeps breathing
	 * after the channels themselves have stopped — a landing that froze its drift
	 * mid-wobble would lock the frame, and lock it a fraction of a degree off the
	 * framing the shot was composed for.
	 */
	const addDrift = ( time, out ) => {

		if ( ! ( drift > 0 ) ) return out

		const closeness = clamp01( Math.log( d0 / out.distance ) / logSpan )
		const amp = deg( 0.11 ) * drift * closeness * ( out.fov / 45 )
		const ts = time * 0.9
		out.yaw += amp * noise( ts, seed + 1 )
		out.tilt += amp * 0.8 * noise( ts, seed + 2 )
		out.roll += amp * 1.5 * noise( ts * 0.7, seed + 3 )
		return out

	}

	return {
		preset,
		name: shot.name,
		tagline: shot.tagline,
		duration: totalDuration,
		startAzimuth: NORTH_UP,
		endAzimuth,
		startDistance: d0,
		endDistance: d1,

		/**
		 * @param {number} time Seconds into the shot.
		 * @param {object} [out] Reused state object.
		 */
		sample( time, out = {} ) {

			return addDrift( time, sampleChannels( time, out ) )

		},

		/**
		 * The landing: a sampler for what the camera does *after* the flight, in
		 * seconds since it ended.
		 *
		 * Arriving used to drop every channel's rate to zero in a single frame —
		 * still closing at sixty to a hundred and fifty metres a second, then
		 * stopped — while azimuth alone carried on at a constant rate forever.
		 * Here every channel leaves at exactly the rate it had, and relaxes: the
		 * push-in, the pull-up and the lens all come to rest of their own accord,
		 * and azimuth eases from its exit rate into `cruise` so the subject is
		 * never quite still. The whole flight and its landing are one move.
		 *
		 * `baseTime` is where the flight actually ended: the full duration for a
		 * shot that ran out, wherever the viewer stopped it for one that did not.
		 * The rates are read backwards from there, so an abort hands over the
		 * velocity it really had rather than the one the shot would have finished
		 * with.
		 *
		 * Pure in its argument, like the shot itself, so a capture could cover it.
		 *
		 * @param {number} baseTime Seconds into the shot at which it stopped.
		 * @param {object} [opts]
		 * @param {number} [opts.cruise] Perpetual turn rate, radians/second.
		 */
		settle( baseTime, { cruise = deg( 1.6 ), settleTime = SETTLE_TIME, turnTime = TURN_SETTLE_TIME } = {} ) {

			const base = sampleChannels( baseTime, {} )

			// Read the exit rates off the sampler. The channels are smooth analytic
			// curves, so there is no noise to average away and the only error is
			// truncation — hence a short step, and a centred difference wherever the
			// shot still has room ahead. At the very end there is no room: the
			// channels clamp past `duration`, and a centred difference there would
			// read half the true rate. A flight stopped on its first frame has no
			// history either, and reads zero rather than something enormous.
			const h = Math.min( 1 / 480, baseTime / 2 )
			const usable = h > 1e-9
			const back = usable ? sampleChannels( baseTime - h, {} ) : null
			const ahead = usable && baseTime + h <= totalDuration
				? sampleChannels( baseTime + h, {} )
				: null
			const back2 = usable && ! ahead ? sampleChannels( baseTime - 2 * h, {} ) : null

			// Centred where the shot has room ahead, and a second-order one-sided
			// difference at the very end, where it has none. Both are exact for a
			// quadratic, which matters at a turnaround: flyby lands on one, and a
			// plain backward difference there reads the curve's curvature as rate and
			// hands the landing a push-in the shot did not have.
			const derive = get => {

				if ( ! usable ) return 0
				if ( ahead ) return ( get( ahead ) - get( back ) ) / ( 2 * h )
				return ( 3 * get( base ) - 4 * get( back ) + get( back2 ) ) / ( 2 * h )

			}

			const logDistanceRate = derive( s => Math.log( s.distance ) )
			const pitchRate = derive( s => s.pitch )
			const fovRate = derive( s => s.fov )
			const rollRate = derive( s => s.roll )
			const azimuthRate = derive( s => s.azimuth )

			// One clock for the whole landing, shortened if any channel would
			// otherwise travel further than it should. Bounding the excursion by
			// shortening the time constant — rather than by clamping the value it
			// accumulates — is what keeps this C1: a clamp on the accumulated span
			// puts a hard rate kink exactly where it engages, about half a second
			// into every aborted landing. Shortening tau leaves the hand-over rate
			// exact, and a landing that arrives fast settling faster is right anyway.
			const reach = ( rate, span ) => Math.abs( rate ) > 1e-9 ? Math.abs( span / rate ) : Infinity
			const time = Math.min(
				settleTime,
				reach( logDistanceRate, SETTLE_LOG_SPAN ),
				reach( pitchRate, deg( SETTLE_PITCH_SPAN ) ),
				reach( fovRate, Math.max( 1, base.fov - SETTLE_MIN_FOV ) ),
			)

			// Keep turning the way the shot was turning. A flight stopped on a held
			// beat — anywhere in dive's first twelve seconds, say — has no rate to
			// read, so fall back to the direction the sweep was authored to go
			// instead of to whichever way an arbitrary sign convention points.
			const heading = azimuthRate !== 0
				? Math.sign( azimuthRate )
				: Math.sign( azimuthTravel ) || 1
			const cruiseRate = cruise * heading

			return {
				baseTime,

				/**
				 * @param {number} tau Seconds since the flight ended.
				 * @param {object} [out] Reused state object.
				 */
				sample( tau, out = {} ) {

					const span = settleSpan( time, tau )
					const turn = settleSpan( turnTime, tau )

					Object.assign( out, base )

					// geometric, like every other distance in this file
					out.distance = base.distance * Math.exp( logDistanceRate * span )
					out.azimuth = base.azimuth + cruiseRate * tau + ( azimuthRate - cruiseRate ) * turn
					out.pitch = base.pitch + pitchRate * span
					out.fov = base.fov + fovRate * span
					out.roll = base.roll + rollRate * span

					return addDrift( baseTime + tau, out )

				},
			}

		},

		/** Normalised descent progress, for altitude-keyed effects. */
		progress( time ) {

			return clamp01( Math.log( d0 / sampleDistance( clamp01( time / totalDuration ) ) ) / logSpan )

		},
	}

}

/**
 * The idle state: the globe held north-up, high above whichever subject is
 * currently selected, so that pressing go is a continuation rather than a cut.
 *
 * Nothing here moves on its own. This is the screen where the viewer works out
 * where on Earth they are and picks somewhere to go — a slow orbit of the
 * camera would turn the map a few degrees further from north with every second
 * they spend reading it. The motion in the idle screen comes from the planet
 * turning to the place under the cursor, from the drifting cloud deck, and from
 * the viewer's own hand on the globe.
 */
export function createIdleShot( {
	distance = 1.7e7,
	pitch = 70,
	fov = 42,
} = {} ) {

	return {
		sample( time, out = {} ) {

			out.distance = distance
			out.azimuth = NORTH_UP
			out.pitch = deg( pitch )
			out.roll = 0
			out.fov = fov
			// the world re-aims these each frame so the planet, rather than the
			// subject, ends up composed in the middle of the screen
			out.yaw = 0
			out.tilt = 0
			return out

		},
	}

}

/** Blends two shot states, for the hand-off between idle and a flight. */
export function blendStates( a, b, alpha, out = {} ) {

	const u = smootherstep( clamp01( alpha ) )
	out.distance = mixLog( a.distance, b.distance, u )
	out.azimuth = a.azimuth + shortestAngle( a.azimuth, b.azimuth ) * u
	out.pitch = a.pitch + ( b.pitch - a.pitch ) * u
	out.roll = a.roll + ( b.roll - a.roll ) * u
	out.fov = a.fov + ( b.fov - a.fov ) * u
	out.yaw = a.yaw + ( b.yaw - a.yaw ) * u
	out.tilt = a.tilt + ( b.tilt - a.tilt ) * u
	return out

}

export function shortestAngle( from, to ) {

	const TAU = Math.PI * 2
	return ( ( to - from ) % TAU + TAU + Math.PI ) % TAU - Math.PI

}
