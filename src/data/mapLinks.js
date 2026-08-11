/**
 * Pasted map links, turned back into a latitude and a longitude.
 *
 * Nobody types coordinates. They find the place in whatever map is already on
 * the screen, hit share, and paste. What lands on the clipboard is a URL, and
 * every provider hides the coordinate somewhere different inside it: Google
 * after an `@`, Apple in `ll=`, OpenStreetMap in the `#map=` hash, Bing behind
 * a tilde, Yandex and 2GIS the other way round — longitude first. All of that
 * is read here, offline, without asking anyone's API.
 *
 * There are four possible answers:
 *
 *   { lat, lon, label?, source }  a coordinate
 *   { label, source }             a name and no coordinate — a Maps *search*
 *                                 link; the caller may still know the place
 *   { reason, source }            recognised, and genuinely unreadable here:
 *                                 a shortened goo.gl, a what3words address, a
 *                                 Plus Code with no town. Each needs a network
 *                                 round trip to somebody else's service, and
 *                                 saying so is more use than finding nothing.
 *   null                          not a link at all — try names and coordinates
 *
 * Nothing in here throws. A coordinate that fails its range check is treated as
 * a pattern that matched the wrong number, and the next pattern gets a turn.
 */

/** One signed degree value. Deliberately loose — `keep` does the range check. */
const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`

/** LAT then LON, in any of the separators the providers use. */
const PAIR = new RegExp( `(${NUM})\\s*[,;~_]\\s*(${NUM})` )

/** Zoom-then-coordinate hashes: `#15/48.8584/2.2945`, shared by every slippy map. */
const HASH_PATH = new RegExp( `(?:^|[#/=])\\d+(?:\\.\\d+)?/(${NUM})/(${NUM})` )

const SHORTENERS = [
	'maps.app.goo.gl', 'goo.gl', 'g.co', 'bit.ly', 'tinyurl.com', 't.co',
	'ow.ly', 'is.gd', 'buff.ly', 'rb.gy', 'shorturl.at', 'qrco.de', 'lnkd.in',
]

export function parseMapLink( input ) {

	const text = String( input || '' ).trim()
	if ( ! text ) return null

	const found = findUrl( text )

	// A bare code is a location without being a link. Skipped once a web URL is
	// in play: a path full of `+` separators would otherwise read as a Plus Code.
	const code = readCode( found && /^https?:/i.test( found ) ? '' : found || text )
	if ( code ) return code

	if ( ! found ) return null

	const ctx = describe( found )
	if ( ! ctx ) return null

	for ( const read of READERS ) {

		const hit = read( ctx )
		if ( hit ) return hit

	}

	// The text is unmistakably a URL, so falling through to the landmark search
	// would only produce a confusing "nothing found" against a name nobody typed.
	return {
		source: ctx.source,
		reason: 'No coordinate in that URL — open it in Maps, then paste the full URL from the address bar',
	}

}

/**
 * Coordinates written out rather than linked: a decimal pair, or degrees and
 * minutes and seconds in either order.
 */
export function parseCoordText( input ) {

	const text = String( input || '' ).trim()
	if ( ! text ) return null

	return readDMS( text ) || readDecimal( text )

}

// ------------------------------------------------------------------ providers

/**
 * Every reader takes the parsed URL and returns a result or null. Order counts:
 * the specific ones run first, and `readGeneric` picks up whatever is left with
 * a parameter named plainly enough to trust.
 */
const READERS = [
	readShortened,
	readGoogle,
	readApple,
	readOpenStreetMap,
	readBing,
	readWaze,
	readYandex,
	read2GIS,
	readHere,
	readMapy,
	readWhat3Words,
	readSlippyHash,
	readGeneric,
]

function readShortened( ctx ) {

	if ( ! SHORTENERS.includes( ctx.host ) ) return null

	// goo.gl also shortens everything else Google has ever published
	const maps = ctx.host !== 'goo.gl' || ctx.path.startsWith( '/maps' )
	return {
		source: ctx.host,
		reason: maps
			? 'Short Google link won’t work — open it, then paste the full URL from the address bar'
			: 'Shortened link won’t work — open it, then paste the full URL from the address bar',
	}

}

/**
 * Google. The `@` is the viewport centre and the `!3d…!4d` pair inside the data
 * blob is the pin itself, which is why a place link gets read from the blob
 * first — the two can sit a street apart when the map was panned before sharing.
 * Embeds invert it: there `!2d` is the longitude.
 */
function readGoogle( ctx ) {

	if ( ! /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test( ctx.host ) ) return null

	const label = googleLabel( ctx )

	// a dropped pin shared by Plus Code puts the code where the name would go
	const plus = readPlusCode( ctx.path )
	if ( plus && plus.lat !== undefined ) return { ...plus, source: 'Google Maps' }

	if ( ctx.path.includes( '/maps/embed' ) ) {

		const embed = ctx.raw.match( new RegExp( `!2d(${NUM})!3d(${NUM})` ) )
		const hit = embed && keep( +embed[ 2 ], +embed[ 1 ] )
		if ( hit ) return { ...hit, label, source: 'Google Maps' }

	}

	if ( ctx.path.includes( '/place/' ) ) {

		const pin = ctx.raw.match( new RegExp( `!8m2!3d(${NUM})!4d(${NUM})` ) )
		const hit = pin && keep( +pin[ 1 ], +pin[ 2 ] )
		if ( hit ) return { ...hit, label, source: 'Google Maps' }

	}

	const at = ctx.raw.match( new RegExp( `@(${NUM}),\\s*(${NUM})` ) )
	const centre = at && keep( +at[ 1 ], +at[ 2 ] )
	if ( centre ) return { ...centre, label, source: 'Google Maps' }

	const any = ctx.raw.match( new RegExp( `!3d(${NUM})!4d(${NUM})` ) )
	const pin = any && keep( +any[ 1 ], +any[ 2 ] )
	if ( pin ) return { ...pin, label, source: 'Google Maps' }

	// `q=loc:48.8584,2.2945` and `q=48.8584,2.2945 (Eiffel Tower)` both land here
	const param = fromParams( ctx, [
		'q', 'query', 'll', 'sll', 'center', 'destination', 'origin', 'viewpoint', 'daddr', 'saddr',
	] ) || fromLatLonParams( ctx )
	if ( param ) return { ...param, label, source: 'Google Maps' }

	// a search link with no coordinate still carries what was searched for
	return label ? { label, source: 'Google Maps' } : null

}

function googleLabel( ctx ) {

	const segment = ctx.path.match( /\/maps\/(?:place|search|dir)\/([^/@]+)/ )
	const text = clean( segment ? segment[ 1 ] : ctx.params.get( 'q' ) ?? ctx.params.get( 'query' ) )
	if ( ! text || text === '?' ) return undefined

	// a dropped pin is shared as its own coordinates, in the slot a name would use
	return looksNumeric( text ) ? undefined : text

}

function readApple( ctx ) {

	if ( ! /(^|\.)apple\.com$/.test( ctx.host ) || ! ctx.host.startsWith( 'maps.' ) ) return null

	const label = clean( ctx.params.get( 'name' ) ?? ctx.params.get( 'address' ) ?? ctx.params.get( 'q' ) )
	const hit = fromParams( ctx, [ 'coordinate', 'll', 'sll', 'center', 'q', 'daddr', 'saddr' ] )
	if ( hit ) return { ...hit, label: looksNumeric( label ) ? undefined : label, source: 'Apple Maps' }

	// the newer share sheet emits maps.apple.com/p/<opaque id>
	if ( /^\/p\//.test( ctx.path ) ) {

		return { source: 'Apple Maps', reason: 'Apple’s short place link carries no coordinate — open it, then share the full link' }

	}

	return label ? { label, source: 'Apple Maps' } : null

}

function readOpenStreetMap( ctx ) {

	if ( ! /(^|\.)(openstreetmap\.(org|de)|osm\.org)$/.test( ctx.host ) ) return null

	const marker = fromLatLonParams( ctx )
	if ( marker ) return { ...marker, source: 'OpenStreetMap' }

	const hash = ctx.hash.match( HASH_PATH )
	const view = hash && keep( +hash[ 1 ], +hash[ 2 ] )
	if ( view ) return { ...view, source: 'OpenStreetMap' }

	// osm.org/go/0EEQjE-- is the one short link that can be read without a server
	const short = ctx.path.match( /^\/go\/([A-Za-z0-9_~]+)/ )
	const spot = short && decodeOsmShortlink( short[ 1 ] )
	if ( spot ) return { ...spot, source: 'OpenStreetMap' }

	const hit = fromParams( ctx, [ 'll', 'center' ] )
	return hit ? { ...hit, source: 'OpenStreetMap' } : null

}

function readBing( ctx ) {

	if ( ! /(^|\.)bing\.com$/.test( ctx.host ) ) return null

	// cp=48.8584~2.2945, and rtp/sp write their points as 48.8584_2.2945
	const hit = fromParams( ctx, [ 'cp', 'sp', 'rtp', 'q', 'where1', 'center' ] ) || fromLatLonParams( ctx )
	return hit ? { ...hit, source: 'Bing Maps' } : null

}

function readWaze( ctx ) {

	if ( ! /(^|\.)waze\.com$/.test( ctx.host ) ) return null

	// to=ll.48.8584,2.2945 — the pair reader steps over the `ll.` prefix
	const hit = fromParams( ctx, [ 'll', 'latlng', 'to', 'from', 'q' ] ) || fromLatLonParams( ctx )
	return hit ? { ...hit, source: 'Waze' } : null

}

/** Yandex writes longitude first, everywhere. */
function readYandex( ctx ) {

	if ( ! /(^|\.)yandex\.[a-z.]+$/.test( ctx.host ) ) return null

	const hit = fromParams( ctx, [ 'll', 'pt', 'whatshere[point]', 'whatshere%5bpoint%5d' ], true )
	return hit ? { ...hit, source: 'Yandex Maps' } : null

}

/** So does 2GIS: `?m=37.6173,55.7558/16`. */
function read2GIS( ctx ) {

	if ( ! /(^|\.)2gis\.[a-z.]+$/.test( ctx.host ) ) return null

	const hit = fromParams( ctx, [ 'm', 'center', 'll' ], true )
	return hit ? { ...hit, source: '2GIS' } : null

}

function readHere( ctx ) {

	if ( ! /(^|\.)here\.com$/.test( ctx.host ) ) return null

	const hit = fromParams( ctx, [ 'map', 'at', 'c', 'll' ] ) || readPair( ctx.path.match( /^\/l\/(.+)/ )?.[ 1 ] )
	return hit ? { ...hit, source: 'HERE' } : null

}

/** Mapy names its axes after the screen: x across, y up. */
function readMapy( ctx ) {

	if ( ! /(^|\.)mapy\.(cz|com)$/.test( ctx.host ) ) return null

	const hit = keep( Number( ctx.params.get( 'y' ) ), Number( ctx.params.get( 'x' ) ) )
	return hit ? { ...hit, source: 'Mapy' } : null

}

function readWhat3Words( ctx ) {

	if ( ! /(^|\.)(what3words\.com|w3w\.co)$/.test( ctx.host ) ) return null

	const words = ctx.path.match( /([a-zà-ÿ]+\.[a-zà-ÿ]+\.[a-zà-ÿ]+)/i )
	return {
		source: 'what3words',
		reason: words
			? `what3words needs their API to resolve ///${words[ 1 ]} — paste coordinates or a map link instead`
			: 'what3words addresses need their API — paste coordinates or a map link instead',
	}

}

/**
 * `#15/48.8584/2.2945` — Leaflet's default hash, and with it geojson.io, Felt,
 * kepler.gl, Mapbox and MapLibre demos, and half the tile viewers on the web.
 */
function readSlippyHash( ctx ) {

	const hash = ctx.hash.match( HASH_PATH )
	const hit = hash && keep( +hash[ 1 ], +hash[ 2 ] )
	return hit ? { ...hit, source: ctx.source } : null

}

/**
 * Anything else with a parameter named plainly enough to be unambiguous. This
 * is where the long tail lands — booking sites, transit apps, weather maps.
 */
function readGeneric( ctx ) {

	const hit = fromLatLonParams( ctx ) || fromParams( ctx, [
		'll', 'center', 'centre', 'loc', 'location', 'coord', 'coords', 'coordinate',
		'coordinates', 'position', 'pos', 'point', 'marker', 'markers', 'geo', 'at',
		'q', 'query', 'destination', 'origin',
	] )
	if ( hit ) return { ...hit, source: ctx.source }

	const at = ctx.raw.match( new RegExp( `@(${NUM}),(${NUM})` ) )
	const centre = at && keep( +at[ 1 ], +at[ 2 ] )
	return centre ? { ...centre, source: ctx.source } : null

}

// ---------------------------------------------------------------- bare codes

/**
 * The formats that are a location without being a link: the `geo:` URI behind
 * every "open in maps" button, Plus Codes, geohashes, what3words.
 */
function readCode( text ) {

	const geo = text.match( new RegExp( `^geo:\\s*(${NUM})\\s*,\\s*(${NUM})`, 'i' ) )
	if ( geo ) {

		// geo:0,0?q=48.8584,2.2945(Eiffel+Tower) is the "search" form of the URI
		const query = text.match( /[?&]q=([^&]+)/i )
		const inner = query && readPair( safeDecode( query[ 1 ] ) )
		const hit = inner || keep( +geo[ 1 ], +geo[ 2 ] )
		if ( hit ) {

			const label = clean( text.match( /\(([^)]+)\)/ )?.[ 1 ] )
			return { ...hit, label, source: 'geo: link' }

		}

	}

	const w3w = text.match( /(?:^\/{3}|what3words\.com\/|w3w\.co\/)([a-zÀ-ɏ]+\.[a-zÀ-ɏ]+\.[a-zÀ-ɏ]+)/i )
	if ( w3w ) {

		return { source: 'what3words', reason: `what3words needs their API to resolve ///${w3w[ 1 ]} — paste coordinates or a map link instead` }

	}

	const hash = text.match( /^(?:geohash|gh):\s*([0-9bcdefghjkmnpqrstuvwxyz]{1,12})$/i )
	if ( hash ) {

		const hit = decodeGeohash( hash[ 1 ] )
		if ( hit ) return { ...hit, source: 'geohash' }

	}

	return readPlusCode( text )

}

/**
 * Open Location Code. A full code carries the whole world in eight characters
 * plus a refinement tail; a short one (`V75V+8Q Paris`) is relative to a town
 * that only a geocoder can place, so that gets a sentence instead.
 */
function readPlusCode( text ) {

	const code = text.match( /(^|[\s,/])([23456789CFGHJMPQRVWX]{2,8}0*\+[23456789CFGHJMPQRVWX]{0,7})(?=$|[\s,/])/i )
	if ( ! code ) return null

	const body = code[ 2 ].toUpperCase()
	const head = body.slice( 0, body.indexOf( '+' ) )
	if ( head.length < 8 ) {

		return { source: 'Plus Code', reason: `${body} is a short Plus Code — paste it with its town, or use the full code` }

	}

	const hit = decodePlusCode( body )
	return hit ? { ...hit, source: 'Plus Code' } : null

}

// ------------------------------------------------------------------- parsing

/** Pulls the first URL out of a share sheet's "name, newline, link" text. */
function findUrl( text ) {

	const match = text.match( /(?:https?:\/\/|geo:|maps:\/\/|comgooglemaps:\/\/)[^\s<>"']+/i )
	if ( match ) return match[ 0 ]

	// pasted without the scheme, which every browser's address bar allows
	const bare = text.match( /(?:^|\s)((?:[\w-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s<>"']*)/i )
	return bare ? `https://${bare[ 1 ]}` : null

}

/** URL, split into the pieces the readers actually look at. */
function describe( raw ) {

	let url
	try {

		url = new URL( raw )

	} catch {

		return null

	}

	const params = new Map()
	const collect = search => {

		for ( const [ key, value ] of new URLSearchParams( search ) ) {

			if ( value && ! params.has( key.toLowerCase() ) ) params.set( key.toLowerCase(), value )

		}

	}

	collect( url.search )
	const hash = url.hash.replace( /^#/, '' )
	// `#map=15/48.8584/2.2945` and `#?lat=…&lon=…` are both query strings in a hash
	if ( hash.includes( '=' ) ) collect( hash.replace( /^\?/, '' ) )

	const host = url.hostname.toLowerCase().replace( /^www\./, '' )

	return {
		raw,
		host,
		// `source` is shown to the user, so it keeps only hostname characters —
		// and an app scheme (comgooglemaps://, maps://) has no host to show at all
		source: host.replace( /[^a-z0-9.:-]/g, '' ) || 'map link',
		path: safeDecode( url.pathname ),
		params,
		hash: safeDecode( hash ),
	}

}

/** First of these parameters that holds a usable pair. */
function fromParams( ctx, names, reversed = false ) {

	for ( const name of names ) {

		const hit = readPair( ctx.params.get( name ), reversed )
		if ( hit ) return hit

	}

	return null

}

/** The spelled-out form: `?lat=48.8584&lng=2.2945`, under any of its aliases. */
function fromLatLonParams( ctx ) {

	const pick = names => {

		for ( const name of names ) {

			const value = ctx.params.get( name )
			if ( value !== undefined && value !== '' ) return Number( value )

		}

		return NaN

	}

	return keep(
		pick( [ 'lat', 'latitude', 'mlat', 'lat1', 'sll_lat' ] ),
		pick( [ 'lon', 'lng', 'long', 'longitude', 'mlon', 'lon1', 'lng1' ] ),
	)

}

function readPair( value, reversed = false ) {

	if ( value === undefined || value === null ) return null
	const match = String( value ).match( PAIR )
	if ( ! match ) return null

	return reversed ? keep( +match[ 2 ], +match[ 1 ] ) : keep( +match[ 1 ], +match[ 2 ] )

}

function readDecimal( text ) {

	const match = text.match( new RegExp( `^\\s*(${NUM})\\s*°?\\s*[,;/\\s]\\s*(${NUM})\\s*°?\\s*$` ) )
	return match ? keep( +match[ 1 ], +match[ 2 ] ) : null

}

/**
 * Degrees, minutes and seconds, with the hemisphere on either side of the
 * number — `48°51'29.6"N 2°17'40.2"E` and `N 48.8584 E 2.2945` are the same
 * place. Minutes and seconds are optional, which is what lets this also read a
 * decimal pair that happens to be written with N/S/E/W instead of a sign.
 */
function readDMS( text ) {

	const body = String.raw`(\d{1,3}(?:\.\d+)?)\s*[°:\s]*\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′:\s]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*["″]?\s*)?`
	const part = new RegExp( `(?:([NSEW])\\s*${body}|${body}\\s*([NSEW]))`, 'gi' )

	const found = []
	let match
	while ( ( match = part.exec( text ) ) !== null ) {

		const prefixed = match[ 1 ] !== undefined
		const hemi = ( prefixed ? match[ 1 ] : match[ 8 ] ).toUpperCase()
		const [ d, m, s ] = prefixed
			? [ match[ 2 ], match[ 3 ], match[ 4 ] ]
			: [ match[ 5 ], match[ 6 ], match[ 7 ] ]

		const minutes = +( m || 0 )
		const seconds = +( s || 0 )
		if ( minutes >= 60 || seconds >= 60 ) continue

		const value = ( +d ) + minutes / 60 + seconds / 3600
		found.push( {
			axis: hemi === 'N' || hemi === 'S' ? 'lat' : 'lon',
			value: hemi === 'S' || hemi === 'W' ? -value : value,
		} )

	}

	const lat = found.find( f => f.axis === 'lat' )
	const lon = found.find( f => f.axis === 'lon' )
	return lat && lon ? keep( lat.value, lon.value ) : null

}

/**
 * The range check every reader funnels through. A pattern that matched a zoom
 * level or a tile index gets rejected here, and the next pattern gets its turn —
 * which is why this returns null rather than throwing.
 */
function keep( lat, lon ) {

	if ( ! Number.isFinite( lat ) || ! Number.isFinite( lon ) ) return null
	if ( Math.abs( lat ) > 90 || Math.abs( lon ) > 180 ) return null

	return { lat, lon }

}

// -------------------------------------------------------------------- codes

const PLUS_ALPHABET = '23456789CFGHJMPQRVWX'
const PLUS_ROWS = 5
const PLUS_COLS = 4

/** Open Location Code, decoded to the centre of the cell it names. */
function decodePlusCode( code ) {

	const digits = code.replace( /\+/g, '' ).replace( /0+$/, '' )
	if ( digits.length < 2 ) return null

	let lat = -90
	let lon = -180
	let latCell = 20 * PLUS_ALPHABET.length
	let lonCell = 20 * PLUS_ALPHABET.length

	// the first ten characters are pairs, each a base-20 digit of each axis
	for ( let i = 0; i < Math.min( 10, digits.length - 1 ); i += 2 ) {

		latCell /= PLUS_ALPHABET.length
		lonCell /= PLUS_ALPHABET.length
		lat += PLUS_ALPHABET.indexOf( digits[ i ] ) * latCell
		lon += PLUS_ALPHABET.indexOf( digits[ i + 1 ] ) * lonCell

	}

	// beyond that each character picks one cell of a 4×5 grid
	for ( let i = 10; i < digits.length; i ++ ) {

		const value = PLUS_ALPHABET.indexOf( digits[ i ] )
		if ( value < 0 ) return null
		latCell /= PLUS_ROWS
		lonCell /= PLUS_COLS
		lat += Math.floor( value / PLUS_COLS ) * latCell
		lon += ( value % PLUS_COLS ) * lonCell

	}

	return keep( lat + latCell / 2, lon + lonCell / 2 )

}

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'

function decodeGeohash( hash ) {

	let latLow = -90
	let latHigh = 90
	let lonLow = -180
	let lonHigh = 180
	let onLon = true

	for ( const character of hash.toLowerCase() ) {

		const value = GEOHASH_ALPHABET.indexOf( character )
		if ( value < 0 ) return null

		for ( let bit = 4; bit >= 0; bit -- ) {

			const high = ( value >> bit ) & 1
			if ( onLon ) {

				const mid = ( lonLow + lonHigh ) / 2
					if ( high ) lonLow = mid
					else lonHigh = mid

			} else {

				const mid = ( latLow + latHigh ) / 2
					if ( high ) latLow = mid
					else latHigh = mid

			}

			onLon = ! onLon

		}

	}

	return keep( ( latLow + latHigh ) / 2, ( lonLow + lonHigh ) / 2 )

}

const OSM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_~'

/**
 * OpenStreetMap's `/go/` short link. Unlike every other shortener this one is
 * not a lookup table on a server: the code *is* the coordinate, six bits per
 * character, longitude and latitude interleaved a bit at a time.
 */
function decodeOsmShortlink( code ) {

	let x = 0
	let y = 0
	let bits = 0

	for ( const character of code ) {

		let digit = OSM_ALPHABET.indexOf( character )
		if ( digit < 0 ) break

		for ( let i = 0; i < 3; i ++ ) {

			x = ( x * 2 ) + ( ( digit >> 5 ) & 1 )
			digit = ( digit << 1 ) & 0x3f
			y = ( y * 2 ) + ( ( digit >> 5 ) & 1 )
			digit = ( digit << 1 ) & 0x3f

		}

		bits += 3

	}

	if ( bits < 3 ) return null

	const cells = Math.pow( 2, bits )
	return keep(
		( y + 0.5 ) * 180 / cells - 90,
		( x + 0.5 ) * 360 / cells - 180,
	)

}

// --------------------------------------------------------------------- text

function clean( value ) {

	if ( ! value ) return undefined
	const text = safeDecode( String( value ) ).replace( /\+/g, ' ' ).replace( /\s+/g, ' ' ).trim()
	if ( ! text || text.length > 60 ) return undefined

	// `q=48.8584,2.2945 (Eiffel Tower)` — the parenthetical is the name
	const named = text.match( /^[-+\d.,;\s°'"NSEW]+\(([^)]+)\)$/i )
	return named ? named[ 1 ].trim() : text

}

/** True for the "names" that are really the coordinate written out again. */
function looksNumeric( text ) {

	if ( ! text ) return false
	return readDecimal( text ) !== null || readDMS( text ) !== null || readPair( text ) !== null

}

function safeDecode( text ) {

	try {

		return decodeURIComponent( text )

	} catch {

		return text

	}

}
