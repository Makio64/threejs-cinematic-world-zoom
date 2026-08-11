/**
 * Easing curves for the cinematic rig.
 *
 * Every function maps [0,1] -> [0,1] with f(0)=0 and f(1)=1. Channels of a shot
 * (distance, azimuth, pitch, fov, roll) each get their own curve — that offset
 * between channels is most of what makes a move read as "shot" rather than
 * "interpolated".
 *
 * This is deliberately not a general easing library: it holds the curves the
 * shots in `shots.js` actually use, and the two combinators — `bezier` and
 * `smoothTrack` — that let you author a new one without adding to this file.
 */

export const smoothstep = t => t * t * ( 3 - 2 * t )

export const smootherstep = t => t * t * t * ( t * ( t * 6 - 15 ) + 10 )

export const cubicInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow( -2 * t + 2, 3 ) / 2

export const sineInOut = t => -( Math.cos( Math.PI * t ) - 1 ) / 2

/**
 * CSS-style cubic-bezier(x1,y1,x2,y2), solved with Newton-Raphson and a
 * bisection fallback. Precise enough for animation and cheap enough per frame.
 */
export const bezier = ( x1, y1, x2, y2 ) => {

	const cx = 3 * x1
	const bx = 3 * ( x2 - x1 ) - cx
	const ax = 1 - cx - bx

	const cy = 3 * y1
	const by = 3 * ( y2 - y1 ) - cy
	const ay = 1 - cy - by

	const sampleX = t => ( ( ax * t + bx ) * t + cx ) * t
	const sampleY = t => ( ( ay * t + by ) * t + cy ) * t
	const slopeX = t => ( 3 * ax * t + 2 * bx ) * t + cx

	return x => {

		if ( x <= 0 ) return 0
		if ( x >= 1 ) return 1

		// Newton first — converges in 2-4 steps for well behaved curves. The
		// tolerance is tight because these curves drive channels scaled up by
		// double-digit degrees: a loose solve reads as angular-velocity jitter.
		let t = x
		for ( let i = 0; i < 10; i ++ ) {

			const err = sampleX( t ) - x
			if ( Math.abs( err ) < 1e-9 ) return sampleY( t )
			const d = slopeX( t )
			if ( Math.abs( d ) < 1e-6 ) break
			t -= err / d

		}

		// Fallback for the flat-slope case.
		let lo = 0, hi = 1
		t = x
		for ( let i = 0; i < 40; i ++ ) {

			const v = sampleX( t )
			if ( Math.abs( v - x ) < 1e-9 ) break
			if ( v > x ) hi = t; else lo = t
			t = ( lo + hi ) / 2

		}

		return sampleY( t )

	}

}

/** Nothing happens until `start`, then it eases across the remaining time. */
export const delayed = ( start = 0.4, ease = cubicInOut ) => t => (
	t <= start ? 0 : ease( ( t - start ) / ( 1 - start ) )
)

/** The film-standard "slow in, slow out" — a touch snappier than smootherstep. */
export const cinematic = bezier( 0.62, 0, 0.2, 1 )

/**
 * Slow in, still drifting at the cut. Use for channels that should hand off
 * into a residual move rather than arrive with zero rate — azimuth especially.
 */
export const coast = bezier( 0.55, 0.02, 0.42, 0.84 )

/**
 * `coast` with the start pinned flat.
 *
 * That 0.02 control point leaves `coast` with a slope of 0.036 at t=0, which is
 * invisible on its own and becomes a rate kink the moment the curve is composed
 * under `delayed`: the hold ends and the channel steps straight to that slope
 * instead of easing into it. Scaled by a big authored sweep it is a visible tick
 * at the exact frame the move is supposed to begin.
 */
export const coastFromRest = bezier( 0.55, 0, 0.42, 0.84 )

export const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t

/**
 * How far a rate that decays exponentially to zero has travelled after `t`,
 * with time constant `tau`.
 *
 * `value + rate * settleSpan( tau, t )` leaves `value` at exactly `rate` and
 * comes to rest of its own accord, having moved `rate * tau` in total. That is
 * what carries a shot's exit velocity through the cut: a channel that simply
 * stopped would drop its rate to zero in one frame, which the eye reads as the
 * film stopping rather than as the flight arriving.
 */
export const settleSpan = ( tau, t ) => tau > 0 ? tau * ( 1 - Math.exp( -t / tau ) ) : 0

/** Geometric (log-space) interpolation — the correct one for distances. */
export const mixLog = ( a, b, t ) => a * Math.pow( b / a, t )

/**
 * One step of a critically damped spring towards `target`. `state` is
 * `{ value, rate }` and is advanced in place; the new value is returned.
 *
 * A fixed-duration ease is the wrong tool for anything the viewer can change
 * again while it is still moving. Restarting a smootherstep from wherever it
 * got to drops the rate to zero on every retarget, so sweeping a cursor down a
 * list reads as a stutter rather than as one move. A spring carries its
 * velocity through the change: retargeting bends the move instead of stalling
 * it, and it still arrives at rest. Critical damping means it never overshoots
 * of its own accord, and the clamp catches the one case that could — an
 * inherited velocity pointing the wrong way.
 *
 * `smoothTime` is roughly how long the move takes to land: the response is 59%
 * of the way there after one, 91% after two, 98% after three. The closed form
 * is stable at any frame length, where the obvious explicit integration blows
 * up the moment a frame runs long.
 */
export const damp = ( state, target, smoothTime, dt ) => {

	// no smoothing asked for is a cut; a frame of no length is not a cut, and
	// two rAF callbacks can share a timestamp
	if ( ! ( dt > 0 ) ) return state.value
	if ( ! ( smoothTime > 0 ) ) {

		state.value = target
		state.rate = 0
		return target

	}

	const omega = 2 / smoothTime
	const x = omega * dt
	// rational approximation of exp( -x ), exact enough over a frame
	const decay = 1 / ( 1 + x + 0.48 * x * x + 0.235 * x * x * x )

	const gap = state.value - target
	const step = ( state.rate + omega * gap ) * dt
	const value = target + ( gap + step ) * decay
	const rate = ( state.rate - omega * step ) * decay

	if ( ( target - state.value > 0 ) === ( value > target ) ) {

		state.value = target
		state.rate = 0
		return target

	}

	state.value = value
	state.rate = rate
	return value

}

/**
 * Piecewise keyframe track. `keys` is `[[t, value, ease?], ...]` sorted by t.
 * A key's third element eases the segment *arriving* at it, which is what lets
 * a move ease into a beat and then continue out of it at a steady rate —
 * without that, every segment slows to a stop at both ends and a long shot
 * reads as a series of stalls.
 */
export const track = ( keys, ease = smootherstep ) => t => {

	if ( t <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ]
	const last = keys[ keys.length - 1 ]
	if ( t >= last[ 0 ] ) return last[ 1 ]

	for ( let i = 1; i < keys.length; i ++ ) {

		const [ t1, v1, segmentEase ] = keys[ i ]
		if ( t > t1 ) continue
		const [ t0, v0 ] = keys[ i - 1 ]
		const u = ( segmentEase || ease )( ( t - t0 ) / ( t1 - t0 ) )
		return v0 + ( v1 - v0 ) * u

	}

	return last[ 1 ]

}

/**
 * C1 keyframe track — a monotone cubic (Fritsch–Carlson) through `keys`
 * (`[[t, value], ...]` sorted by t). The start is flat so establishing beats
 * hold; the end is flat by default, or kept alive with `endCoast`.
 *
 * Where `track` slows to a stop at every key, this passes interior keys at
 * speed, so a multi-beat move reads as one continuous gesture. Tangents are
 * monotonicity-limited, so it never overshoots between keys, and a key that
 * *is* a turnaround (a local extremum) gets a flat tangent — the apex of an
 * overshoot arrives without a ripple.
 *
 * `endCoast` is a fraction of the last segment's secant kept as the exit
 * slope (0 = settle, 1 = leave at the average rate of the final beat). A
 * little coast is what stops a landing from reading as a hard stop before the
 * residual orbit takes over.
 */
export const smoothTrack = ( keys, endCoast = 0 ) => {

	const n = keys.length
	const h = [], d = []
	for ( let i = 0; i < n - 1; i ++ ) {

		h[ i ] = keys[ i + 1 ][ 0 ] - keys[ i ][ 0 ]
		d[ i ] = ( keys[ i + 1 ][ 1 ] - keys[ i ][ 1 ] ) / h[ i ]

	}

	const m = new Array( n ).fill( 0 )
	for ( let i = 1; i < n - 1; i ++ ) {

		if ( d[ i - 1 ] * d[ i ] > 0 ) {

			const w1 = 2 * h[ i ] + h[ i - 1 ]
			const w2 = h[ i ] + 2 * h[ i - 1 ]
			m[ i ] = ( w1 + w2 ) / ( w1 / d[ i - 1 ] + w2 / d[ i ] )

		}

	}

	if ( endCoast > 0 ) m[ n - 1 ] = endCoast * d[ n - 2 ]

	return t => {

		if ( t <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ]
		if ( t >= keys[ n - 1 ][ 0 ] ) return keys[ n - 1 ][ 1 ]

		let i = n - 2
		while ( i > 0 && t < keys[ i ][ 0 ] ) i --

		const u = ( t - keys[ i ][ 0 ] ) / h[ i ]
		const u2 = u * u
		const u3 = u2 * u
		return ( 2 * u3 - 3 * u2 + 1 ) * keys[ i ][ 1 ]
			+ ( u3 - 2 * u2 + u ) * h[ i ] * m[ i ]
			+ ( -2 * u3 + 3 * u2 ) * keys[ i + 1 ][ 1 ]
			+ ( u3 - u2 ) * h[ i ] * m[ i + 1 ]

	}

}
