/**
 * Solar position, and the inverse problem the app actually cares about:
 * "give me a moment in time at which this place looks good".
 *
 * Position uses the NOAA solar-position algorithm (accurate to well under a
 * tenth of a degree, far more than we need). The inverse is solved by a coarse
 * scan over the whole year followed by a local refinement, rather than by
 * inverting the hour-angle equation directly — a scan cannot pick the wrong
 * branch, cannot be caught out by a longitude sign, and degrades gracefully at
 * latitudes where the requested elevation is simply unreachable.
 */

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const DAY_MS = 86400000

const sin = a => Math.sin( a * D2R )
const cos = a => Math.cos( a * D2R )

/**
 * Solar declination and the equation of time for an instant.
 * @param {number} jd Julian day.
 */
function solarParams( jd ) {

	const T = ( jd - 2451545 ) / 36525

	// geometric mean longitude and anomaly of the sun, degrees
	const L0 = ( 280.46646 + T * ( 36000.76983 + T * 0.0003032 ) ) % 360
	const M = 357.52911 + T * ( 35999.05029 - 0.0001537 * T )
	const e = 0.016708634 - T * ( 0.000042037 + 0.0000001267 * T )

	// equation of the centre -> true longitude
	const C = sin( M ) * ( 1.914602 - T * ( 0.004817 + 0.000014 * T ) )
		+ sin( 2 * M ) * ( 0.019993 - 0.000101 * T )
		+ sin( 3 * M ) * 0.000289
	const trueLong = L0 + C

	// apparent longitude, corrected for nutation and aberration
	const omega = 125.04 - 1934.136 * T
	const lambda = trueLong - 0.00569 - 0.00478 * sin( omega )

	// obliquity of the ecliptic
	const eps0 = 23 + ( 26 + ( 21.448 - T * ( 46.815 + T * ( 0.00059 - T * 0.001813 ) ) ) / 60 ) / 60
	const eps = eps0 + 0.00256 * cos( omega )

	const declination = Math.asin( sin( eps ) * sin( lambda ) ) * R2D

	// equation of time, minutes
	const y = Math.tan( eps * D2R / 2 ) ** 2
	const eqTime = 4 * R2D * (
		y * sin( 2 * L0 )
		- 2 * e * sin( M )
		+ 4 * e * y * sin( M ) * cos( 2 * L0 )
		- 0.5 * y * y * sin( 4 * L0 )
		- 1.25 * e * e * sin( 2 * M )
	)

	return { declination, eqTime }

}

const toJulian = ms => ms / DAY_MS + 2440587.5

/**
 * Solar elevation and compass azimuth at a place and time.
 * @param {number} latDeg Latitude, degrees north.
 * @param {number} lonDeg Longitude, degrees east.
 * @param {Date|number} when
 * @returns {{ elevation: number, azimuth: number, declination: number, hourAngle: number }}
 *   Elevation is degrees above the horizon (refraction not applied); azimuth is
 *   degrees clockwise from true north.
 */
export function solarPosition( latDeg, lonDeg, when ) {

	const ms = when instanceof Date ? when.getTime() : when
	const { declination, eqTime } = solarParams( toJulian( ms ) )

	// minutes since UTC midnight
	const utcMinutes = ( ( ms % DAY_MS ) + DAY_MS ) % DAY_MS / 60000

	// true solar time, then the hour angle: -180 at solar midnight, 0 at noon
	const trueSolar = utcMinutes + eqTime + 4 * lonDeg
	let hourAngle = trueSolar / 4 - 180
	hourAngle = ( ( hourAngle + 180 ) % 360 + 360 ) % 360 - 180

	const sinEl = sin( latDeg ) * sin( declination )
		+ cos( latDeg ) * cos( declination ) * cos( hourAngle )
	const elevation = Math.asin( Math.max( -1, Math.min( 1, sinEl ) ) ) * R2D

	// azimuth measured clockwise from north
	const azimuth = ( Math.atan2(
		-sin( hourAngle ) * cos( declination ),
		sin( declination ) * cos( latDeg ) - cos( declination ) * sin( latDeg ) * cos( hourAngle )
	) * R2D + 360 ) % 360

	return { elevation, azimuth, declination, hourAngle }

}

/** Signed smallest difference between two compass bearings, in degrees. */
export function bearingDelta( a, b ) {

	return ( ( a - b + 540 ) % 360 ) - 180

}

/**
 * Finds an instant at which the sun over (lat, lon) is at — or as close as the
 * latitude allows to — the requested elevation, optionally also on a requested
 * side of the sky.
 *
 * Never returns a night-time result: below-horizon candidates are penalised
 * hard, so on a polar-night coordinate the answer is the brightest moment of
 * the brightest day of the year rather than a plausible-looking midnight.
 *
 * @param {object} opts
 * @param {number} opts.lat Latitude, degrees north.
 * @param {number} opts.lon Longitude, degrees east.
 * @param {number} [opts.elevation=14] Desired solar elevation, degrees.
 * @param {number} [opts.azimuth] Desired solar compass azimuth, degrees. Omit
 *   to let the search pick whichever side of the sky fits the elevation best.
 * @param {number} [opts.azimuthWeight=0.35] How much the azimuth target matters
 *   relative to the elevation target. Elevation always wins a tie.
 * @param {number} [opts.year] Year to search within. Defaults to the current one.
 * @returns {{ date: Date, elevation: number, azimuth: number, exact: boolean }}
 */
export function findDaylight( {
	lat,
	lon,
	elevation = 14,
	azimuth = null,
	azimuthWeight = 0.35,
	year = new Date().getUTCFullYear(),
} = {} ) {

	const start = Date.UTC( year, 0, 1 )

	const cost = ms => {

		const s = solarPosition( lat, lon, ms )
		// keep the subject lit: 3 degrees of slack, then a steep penalty
		const night = s.elevation < 3 ? ( 3 - s.elevation ) ** 2 * 40 : 0
		const dEl = s.elevation - elevation
		let dAz = 0
		if ( azimuth !== null ) dAz = bearingDelta( s.azimuth, azimuth )
		return dEl * dEl + azimuthWeight * dAz * dAz + night

	}

	// coarse scan: every 3 days, every 12 minutes. ~58k evaluations, a couple of
	// milliseconds, and immune to picking the wrong solution branch.
	let bestMs = start
	let bestCost = Infinity
	for ( let day = 0; day < 365; day += 3 ) {

		const dayMs = start + day * DAY_MS
		for ( let min = 0; min < 1440; min += 12 ) {

			const ms = dayMs + min * 60000
			const c = cost( ms )
			if ( c < bestCost ) {

				bestCost = c
				bestMs = ms

			}

		}

	}

	// refine: walk the day-of-year and the time-of-day alternately with a
	// shrinking step until both are sub-minute / sub-day accurate
	let dayStep = 3 * DAY_MS
	let minStep = 12 * 60000
	for ( let pass = 0; pass < 22; pass ++ ) {

		let improved = false
		for ( const step of [ dayStep, -dayStep, minStep, -minStep ] ) {

			const ms = bestMs + step
			if ( ms < start || ms > start + 365 * DAY_MS ) continue
			const c = cost( ms )
			if ( c < bestCost - 1e-9 ) {

				bestCost = c
				bestMs = ms
				improved = true

			}

		}
		if ( ! improved ) {

			dayStep /= 2
			minStep /= 2

		}
		if ( minStep < 1000 && dayStep < DAY_MS / 24 ) break

	}

	const s = solarPosition( lat, lon, bestMs )
	return {
		date: new Date( bestMs ),
		elevation: s.elevation,
		azimuth: s.azimuth,
		exact: Math.abs( s.elevation - elevation ) < 0.5
			&& ( azimuth === null || Math.abs( bearingDelta( s.azimuth, azimuth ) ) < 8 ),
	}

}

/**
 * Cross-checks (and if needed nudges) a date against whatever sun model the
 * renderer actually uses, by sampling the direction it produces.
 *
 * Our NOAA maths and @takram/three-atmosphere's ephemeris agree closely, but
 * this closes the loop so the lighting on screen is the lighting we solved for
 * rather than the lighting we assumed.
 *
 * @param {Date} date Starting guess.
 * @param {(date: Date) => number} measureElevation Returns the true elevation
 *   in degrees, as measured from the renderer's own sun direction.
 * @param {number} targetElevation Degrees.
 * @returns {Date}
 */
export function refineAgainstRenderer( date, measureElevation, targetElevation, windowMinutes = 100 ) {

	const base = date.getTime()
	let bestMs = base
	let bestErr = Math.abs( measureElevation( date ) - targetElevation )
	if ( bestErr < 0.02 ) return date

	// Two models that agree to a fraction of a degree can still disagree by a
	// few minutes of clock time near a shallow sun. A dense sweep of a narrow
	// window costs nothing and cannot pick the wrong side of solar noon.
	for ( let m = -windowMinutes; m <= windowMinutes; m ++ ) {

		const ms = base + m * 60000
		const err = Math.abs( measureElevation( new Date( ms ) ) - targetElevation )
		if ( err < bestErr ) {

			bestErr = err
			bestMs = ms

		}

	}

	return new Date( bestMs )

}

/**
 * Light presets.
 *
 * `gamma` is the angle between the sun and the direction the camera looks,
 * measured at the camera: 0 is straight into the sun, 90 puts it square on one
 * shoulder, 180 has it behind the camera. Photographers quote the same
 * relationship as the angle at the *subject*, which is 180 − gamma — so the
 * classic "sun 120–150° off axis" is gamma 30–60, and that band is where a low
 * sun gives a rim on the far edge, long shadows raking towards the lens, and
 * the forward-scattered haze that sells the scale of a descent.
 *
 * The camera's final bearing is derived from gamma rather than the other way
 * round, because a given elevation is reachable at any latitude the sun visits
 * while a given (elevation, azimuth) pair usually is not.
 *
 * `pitchScale` flattens the final approach for the presets that want the
 * horizon, and the sun with it, inside the frame.
 */
export const LIGHT_PRESETS = {
	golden: {
		name: 'Golden',
		elevation: 8,
		gamma: 46,
		exposure: 12,
		coverage: 0.3,
		flare: 0.011,
		note: 'Low warm key, long raking shadows',
	},
	backlight: {
		name: 'Contre-jour',
		elevation: 6,
		gamma: 13,
		exposure: 8.5,
		coverage: 0.45,
		flare: 0.026,
		pitchScale: 0.72,
		note: 'Sun into the lens, silver-lined cloud, silhouettes',
	},
	morning: {
		name: 'Morning',
		elevation: 21,
		gamma: 62,
		exposure: 10,
		coverage: 0.38,
		flare: 0.005,
		note: 'Open side key, soft shadows, plenty of cloud',
	},
	noon: {
		name: 'Noon',
		elevation: 66,
		gamma: 40,
		exposure: 9,
		coverage: 0.18,
		flare: 0.003,
		note: 'Hard top light, the tiles at their most legible',
	},
	lastlight: {
		name: 'Last light',
		elevation: 3.2,
		gamma: 26,
		exposure: 15,
		coverage: 0.34,
		flare: 0.022,
		pitchScale: 0.8,
		note: 'As low as the sun goes before the ground loses it',
	},
	cross: {
		name: 'Cross light',
		elevation: 14,
		gamma: 92,
		exposure: 11,
		coverage: 0.36,
		flare: 0.002,
		note: 'Pure side light — maximum modelling on a facade',
	},
}

export const LIGHT_KEYS = Object.keys( LIGHT_PRESETS )
