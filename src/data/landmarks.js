/**
 * Landmark presets.
 *
 * `groundH` is the orthometric elevation (metres above mean sea level) and
 * `geoidN` the approximate EGM96 geoid undulation there. The ellipsoid wants
 * `h = groundH + geoidN`, and that correction is not cosmetic: New York, San
 * Francisco and Dubai all sit around thirty metres *below* the WGS84 ellipsoid,
 * so using the orthometric height alone would bury the camera underground.
 *
 * `lookAtHeight` is the visual centre of the subject relative to the ground —
 * negative where the coordinate is a summit or a rim and the subject is the
 * mass or void beneath it.
 *
 * `coverage` records how good Google's photorealistic mesh actually is — every
 * entry below was rendered at its landing frame and looked at. A few candidates
 * were cut on that evidence: Teotihuacán is draped terrain, downtown Dubai has
 * no building geometry at all, and neither Hagia Sophia nor Christ the Redeemer
 * exists as mesh. Machu Picchu is the same draped-terrain class — kept anyway,
 * tagged `moderate`. Coverage is also thin or absent over China, India and
 * Russia, so nothing from there is here.
 *
 * `featured` is the one thing here that is not a landmark. An entry that
 * carries it gets its own mark and colour at the top of the place list, and a
 * card that arrives over the subject once the flight lands:
 *
 *   logo      a URL, drawn in place of both the emoji and the name
 *   logoType  optional type layer — blackens on row hover
 *   logoBadge optional colour mark stacked over logoType (never inverted)
 *   badge     what the list entry says instead of the name
 *   href      where the card links to
 *   card      exactly three lines of text, longest-lived first
 *
 * `faceToward` is an optional lat/lon the landing view should look past the
 * subject toward. Most shots derive their final bearing from the sun; this is
 * the escape hatch when geography matters more than the light angle — the
 * camera sits opposite that point so it sits in the background of the landing.
 */

import { parseCoordText, parseMapLink } from './mapLinks.js'

const DEG2RAD = Math.PI / 180
const BASE_URL = import.meta.env?.BASE_URL || '/'

/** Search form: case/accent-insensitive and indifferent to punctuation. */
export function searchKey( value ) {

	return String( value || '' )
		.normalize( 'NFD' )
		.replace( /\p{Mark}/gu, '' )
		.toLowerCase()
		.replace( /[^\p{Letter}\p{Number}]+/gu, '' )

}

/** Compass bearing from A to B, radians clockwise from north. */
function compassBearing( from, to ) {

	const φ1 = from.lat * DEG2RAD
	const φ2 = to.lat * DEG2RAD
	const Δλ = ( to.lon - from.lon ) * DEG2RAD
	const y = Math.sin( Δλ ) * Math.cos( φ2 )
	const x = Math.cos( φ1 ) * Math.sin( φ2 ) - Math.sin( φ1 ) * Math.cos( φ2 ) * Math.cos( Δλ )
	return Math.atan2( y, x )

}

export const LANDMARKS = [

	{
		// Not a landmark: the conference this was built to be shown at. The
		// coordinate is the centroid of the Maison de la Chimie's footprint
		// rather than its door on rue Saint-Dominique — the hall sits back
		// behind the street wall, and orbiting the door frames the neighbour.
		// The dive lands looking toward the Eiffel Tower so Paris reads as
		// Paris behind the venue, rather than whatever bearing the sun asked for.
		id: 'threejs-conf-paris', name: 'Threejs Conf Paris',
		place: 'Maison de la Chimie', country: 'France', cat: '🟣',
		lat: 48.86027, lon: 2.31663, groundH: 33, geoidN: 44.5,
		lookAtHeight: 24, orbitRadius: 300, orbitPitch: 19, coverage: 'excellent',
		faceToward: { lat: 48.85822, lon: 2.29450 },
		featured: {
			// type + badge are stacked so hover can blacken THREE CON without
			// touching the pink .js mark
			logo: `${BASE_URL}threejs-conf.png`,
			logoType: `${BASE_URL}threejs-conf-type.png`,
			logoBadge: `${BASE_URL}threejs-conf-badge.png`,
			badge: '10 & 11 Sept 2026',
			href: 'https://threejs.paris',
			card: [ 'Threejs Conf Paris', '10 & 11 Sept 2026', 'threejs.paris' ],
		},
	},

	// Europe
	{
		id: 'eiffel-tower', name: 'Eiffel Tower', place: 'Paris', country: 'France', cat: '🗼',
		lat: 48.85822, lon: 2.29450, groundH: 33, geoidN: 44.5,
		lookAtHeight: 150, orbitRadius: 420, orbitPitch: 16, coverage: 'excellent',
	},
	{
		id: 'colosseum', name: 'Colosseum', place: 'Rome', country: 'Italy', cat: '🏛️',
		lat: 41.89017, lon: 12.49225, groundH: 20, geoidN: 48,
		lookAtHeight: 25, orbitRadius: 230, orbitPitch: 22, coverage: 'excellent',
	},
	{
		id: 'sagrada-familia', name: 'Sagrada Família', place: 'Barcelona', country: 'Spain', cat: '⛪',
		lat: 41.40361, lon: 2.17444, groundH: 42, geoidN: 49.5,
		lookAtHeight: 90, orbitRadius: 300, orbitPitch: 14, coverage: 'excellent',
	},
	{
		id: 'tower-bridge', name: 'Tower Bridge', place: 'London', country: 'United Kingdom', cat: '🌉',
		lat: 51.50556, lon: -0.07528, groundH: 5, geoidN: 46.5,
		lookAtHeight: 40, orbitRadius: 300, orbitPitch: 16, coverage: 'excellent',
	},
	{
		id: 'mont-saint-michel', name: 'Mont-Saint-Michel', place: 'Normandy', country: 'France', cat: '🏰',
		lat: 48.63601, lon: -1.51146, groundH: 20, geoidN: 47,
		lookAtHeight: 45, orbitRadius: 480, orbitPitch: 15, coverage: 'excellent',
	},
	{
		// Summit ice dome. lookAtHeight is negative so the massif fills the frame
		// rather than the camera staring at a white tip against empty sky.
		id: 'mont-blanc', name: 'Mont Blanc', place: 'Alps', country: 'France', cat: '🏔️',
		lat: 45.83278, lon: 6.86500, groundH: 4808, geoidN: 51,
		lookAtHeight: -550, orbitRadius: 7500, orbitPitch: 12, coverage: 'good',
	},

	// North America
	{
		id: 'statue-liberty', name: 'Statue of Liberty', place: 'New York', country: 'United States', cat: '🗽',
		lat: 40.68925, lon: -74.04450, groundH: 3, geoidN: -32.5,
		lookAtHeight: 55, orbitRadius: 260, orbitPitch: 15, coverage: 'excellent',
	},
	{
		// Aimed at the inner gorge, not at Mather Point. Orbiting a rim viewpoint
		// spends half the shot over flat scrub with the canyon behind the camera;
		// orbiting a point in the middle of the void always looks into it.
		// groundH is deliberately the *rim* height so the camera floor stays
		// above the plateau it passes over.
		id: 'grand-canyon', name: 'Grand Canyon', place: 'Arizona', country: 'United States', cat: '🏜️',
		lat: 36.09500, lon: -112.09500, groundH: 2170, geoidN: -22,
		lookAtHeight: -700, orbitRadius: 3200, orbitPitch: 20, coverage: 'excellent',
	},
	// South America
	{
		// Citadel terrace, not Huayna Picchu's tip — lands looking toward the
		// peak so the postcard ridge reads behind the ruins. Mesh is draped
		// terrain rather than carved stone; the silhouette still carries it.
		id: 'machu-picchu', name: 'Machu Picchu', place: 'Cusco', country: 'Peru', cat: '⛰️',
		lat: -13.16310, lon: -72.54560, groundH: 2430, geoidN: 32,
		lookAtHeight: 25, orbitRadius: 1400, orbitPitch: 16, coverage: 'moderate',
		faceToward: { lat: -13.15640, lon: -72.54630 },
	},
	{
		id: 'sugarloaf', name: 'Sugarloaf Mountain', place: 'Rio de Janeiro', country: 'Brazil', cat: '🍞',
		lat: -22.94867, lon: -43.15650, groundH: 396, geoidN: -6,
		lookAtHeight: -140, orbitRadius: 900, orbitPitch: 12, coverage: 'excellent',
	},

	// Africa
	{
		// Khufu itself rather than the three-pyramid centroid: at a radius that
		// frames the whole plateau each pyramid is too small to read.
		id: 'giza-pyramids', name: 'Pyramids of Giza', place: 'Giza', country: 'Egypt', cat: '🔺',
		lat: 29.97918, lon: 31.13436, groundH: 60, geoidN: 14.5,
		lookAtHeight: 75, orbitRadius: 620, orbitPitch: 19, coverage: 'moderate',
	},
	// Asia and the Middle East
	{
		id: 'mount-fuji', name: 'Mount Fuji', place: 'Honshū', country: 'Japan', cat: '🗻',
		lat: 35.36056, lon: 138.72750, groundH: 3776, geoidN: 37,
		lookAtHeight: -450, orbitRadius: 6500, orbitPitch: 12, coverage: 'good',
	},
	{
		id: 'tokyo-tower', name: 'Tokyo Tower', place: 'Tokyo', country: 'Japan', cat: '🗼',
		lat: 35.65858, lon: 139.74543, groundH: 20, geoidN: 37,
		lookAtHeight: 160, orbitRadius: 520, orbitPitch: 14, coverage: 'excellent',
	},
	{
		id: 'marina-bay', name: 'Marina Bay Sands', place: 'Singapore', country: 'Singapore', cat: '🛥️',
		lat: 1.28361, lon: 103.85944, groundH: 5, geoidN: 8.5,
		lookAtHeight: 130, orbitRadius: 600, orbitPitch: 14, coverage: 'good',
	},

	// Oceania
	{
		id: 'sydney-opera', name: 'Sydney Opera House', place: 'Sydney', country: 'Australia', cat: '🎭',
		lat: -33.85678, lon: 151.21530, groundH: 4, geoidN: 22,
		lookAtHeight: 30, orbitRadius: 320, orbitPitch: 14, coverage: 'excellent',
	},
	{
		id: 'uluru', name: 'Uluru', place: 'Northern Territory', country: 'Australia', cat: '🪨',
		lat: -25.34500, lon: 131.03611, groundH: 863, geoidN: 9,
		lookAtHeight: -170, orbitRadius: 2100, orbitPitch: 13, coverage: 'moderate',
	},

]

/**
 * Fills in everything the rig and the shot need: radians, the ellipsoidal
 * heights, and the final eye-to-subject distance implied by the orbit.
 */
export function resolveTarget( source ) {

	const groundH = source.groundH ?? 0
	const geoidN = source.geoidN ?? 0
	const groundHeight = groundH + geoidN
	const lookAtHeight = source.lookAtHeight ?? 60
	const orbitRadius = source.orbitRadius ?? 600
	const orbitPitch = ( source.orbitPitch ?? 15 ) * DEG2RAD
	// Camera azimuth is the bearing of the *eye* from the subject, so to look
	// toward a point past the subject the camera sits on the opposite bearing.
	const endAzimuth = source.faceToward
		? compassBearing( source, source.faceToward ) + Math.PI
		: undefined

	return {
		...source,
		latRad: source.lat * DEG2RAD,
		lonRad: source.lon * DEG2RAD,
		groundHeight,
		aimHeight: groundHeight + lookAtHeight,
		orbitRadius,
		orbitPitch,
		// the orbit is authored as a ground radius and an elevation angle; the
		// shot works in slant distance
		endDistance: orbitRadius / Math.cos( orbitPitch ),
		endAzimuth,
		// Floor for the camera, as an ellipsoidal height, measured against the
		// coordinate's own ground. Deliberately conservative: for a canyon or a
		// summit the coordinate is the local high point, so staying above it is
		// the only cheap guarantee that the camera does not end up inside the
		// plateau it is orbiting. Shots that want to be *inside* something get
		// there by aiming down into it, not by flying below the rim.
		minHeight: groundHeight + Math.max( 40, lookAtHeight > 0 ? lookAtHeight * 0.18 : 40 ),
	}

}

export const LANDMARK_MAP = new Map( LANDMARKS.map( l => [ l.id, l ] ) )

/**
 * Resolves free text to a target — a landmark name, a coordinate pair in
 * decimal or degrees-minutes-seconds, or a link pasted out of any of the map
 * services `parseMapLink` reads.
 *
 * Always answers with an object, never null: `target` is the place, `source`
 * names where the coordinate was found so the interface can confirm it, and
 * `reason` is the sentence to show when there is nothing to fly to. Failing
 * silently is the one outcome worth avoiding — a link that resolves to nothing
 * looks identical to a link that was never read.
 */
export function parseLocation( input ) {

	const text = String( input || '' ).trim()
	if ( ! text ) return {}

	const link = parseMapLink( text )
	if ( link ) {

		if ( link.lat !== undefined ) {

			const target = coordTarget( link.lat, link.lon, { name: link.label } )
			return target ? { target, source: link.source } : { reason: 'That URL points off the globe' }

		}

		// a search link carries no coordinate, but what was searched for may well
		// be one of ours
		const named = link.label && findLandmark( link.label )
		if ( named ) return { target: named, source: link.source }

		return { source: link.source, reason: link.reason || `No coordinate in that ${link.source} URL` }

	}

	// no `source` for a coordinate typed out in full: the numbers are already in
	// front of the user, and the coordinate row echoes them back
	const point = parseCoordText( text )
	if ( point ) return { target: coordTarget( point.lat, point.lon ) }

	// numbers and hemispheres and nothing else: they meant a coordinate, and the
	// only thing wrong with it is the range
	if ( /\d/.test( text ) && /^[-+\d.,;:/\s°'′"″NSEWnsew]+$/.test( text ) ) {

		return { reason: 'Latitude runs −90…90 and longitude −180…180' }

	}

	const hit = findLandmark( text )
	return hit
		? { target: hit }
		: { reason: 'Nothing found — paste a Google Maps URL, or try 48.8582, 2.2945' }

}

/**
 * A prefix beats a mention: "Paris" is the Eiffel Tower's city before it is a
 * word inside another entry's name, so a plain `includes` scan would quietly
 * answer with whichever of the two happens to sit higher in the list.
 */
function findLandmark( input ) {

	const needle = searchKey( input )
	if ( ! needle ) return null

	const fields = landmark => [ landmark.name, landmark.place, landmark.country ].map( searchKey )
	return LANDMARKS.find( l => fields( l ).some( f => f.startsWith( needle ) ) )
		|| LANDMARKS.find( l => fields( l ).some( f => f.includes( needle ) ) )
		|| null

}

export function coordTarget( lat, lon, { name } = {} ) {

	if ( ! isFinite( lat ) || ! isFinite( lon ) ) return null
	if ( Math.abs( lat ) > 90 || Math.abs( lon ) > 180 ) return null

	return {
		id: 'custom',
		// a shared link often names the place it points at, and that name is a
		// better label for the shot than "Custom location"
		name: name || 'Custom location',
		place: formatCoord( lat, lon ),
		country: '',
		cat: '📍',
		lat, lon,
		// no elevation data for an arbitrary point — the ground probe fixes this
		// up once the tiles under it have loaded
		groundH: 0, geoidN: 0,
		lookAtHeight: 60, orbitRadius: 650, orbitPitch: 16,
		coverage: 'unknown',
		needsGroundProbe: true,
	}

}

export function formatCoord( lat, lon ) {

	const ns = lat >= 0 ? 'N' : 'S'
	const ew = lon >= 0 ? 'E' : 'W'
	return `${Math.abs( lat ).toFixed( 4 )}° ${ns}   ${Math.abs( lon ).toFixed( 4 )}° ${ew}`

}
