/**
 * Where the Google Photorealistic 3D Tiles credentials come from.
 *
 * The token the three.js example ships with is registered to threejs.org and
 * returns 403 from anywhere else, so this app has to be given a key of its own.
 * Either kind works:
 *
 *   Cesium Ion   free account at https://ion.cesium.com, asset 2275207
 *   Google Maps  a Maps Platform key with the Map Tiles API enabled
 *
 * Resolution order, first hit wins:
 *
 *   1. ?ion=… or ?google=… in the URL
 *   2. whatever was last entered in the app (localStorage)
 *   3. VITE_ION_TOKEN / VITE_GOOGLE_API_KEY in .env
 *
 * A typed key outranks `.env` on purpose. A `VITE_` variable is baked into the
 * bundle only in the explicit credential build mode. If that key ever stops
 * working, a visitor can still replace it with one they enter here.
 */

export const GOOGLE_TILES_ASSET = '2275207'

const STORAGE_KEY = 'cinematic-world.tileAuth'
const REQUEST_TIMEOUT_MS = 15000

// Optional access keeps this module importable directly in Node for its pure
// helpers, where `import.meta.env` is not defined.
const BUNDLED_CREDENTIALS = {
	ion: import.meta.env?.VITE_ION_TOKEN || '',
	google: import.meta.env?.VITE_GOOGLE_API_KEY || '',
}

/** Shown when Cesium's (or Google's) 3D Tiles quota is exhausted. */
export const QUOTA_EXCEEDED_REASON =
	'The 3D Tiles quota is exhausted. Enter another Cesium Ion token or Google Maps API key, or try again later.'

export function resolveTileAuth() {

	const params = new URLSearchParams( location.search )

	const fromUrl = params.get( 'ion' ) || params.get( 'google' )
	if ( fromUrl ) {

		const auth = { kind: params.get( 'google' ) ? 'google' : 'ion', key: fromUrl, source: 'url' }
		// Drop the key from the address bar as soon as the app loads. Persist only
		// after checkAuth succeeds — a bad ?ion= must not overwrite a working key.
		stripAuthFromUrl()
		return auth

	}

	try {

		const stored = JSON.parse( localStorage.getItem( STORAGE_KEY ) || 'null' )
		if ( stored && stored.key ) return { ...stored, source: 'stored' }

	} catch {}

	if ( BUNDLED_CREDENTIALS.google ) return { kind: 'google', key: BUNDLED_CREDENTIALS.google, source: 'env' }
	if ( BUNDLED_CREDENTIALS.ion ) return { kind: 'ion', key: BUNDLED_CREDENTIALS.ion, source: 'env' }

	return { kind: 'ion', key: '', source: 'none' }

}

export function rememberTileAuth( auth ) {

	try {

		localStorage.setItem( STORAGE_KEY, JSON.stringify( { kind: auth.kind, key: auth.key } ) )

	} catch {}

}

/** Removes `?ion=` / `?google=` from the address bar without reloading. */
export function stripAuthFromUrl() {

	const params = new URLSearchParams( location.search )
	if ( ! params.has( 'ion' ) && ! params.has( 'google' ) ) return

	params.delete( 'ion' )
	params.delete( 'google' )
	const query = params.toString()
	const next = `${ location.pathname }${ query ? `?${ query }` : '' }${ location.hash }`
	history.replaceState( null, '', next )

}

/** A Google key starts with `AIza`; anything else is treated as an Ion token. */
export function classifyKey( key ) {

	const trimmed = String( key || '' ).trim()
	if ( ! trimmed ) return null
	return { kind: /^AIza/.test( trimmed ) ? 'google' : 'ion', key: trimmed }

}

/**
 * True when a fetch status / body / thrown error is a tiles quota rejection
 * (Cesium Ion monthly root-tile cap, or Google's shared daily root-tile cap
 * that Ion routes through).
 */
export function isQuotaFailure( { status, body, error } = {} ) {

	if ( status === 429 ) return true

	const text = [
		typeof body === 'string' ? body : '',
		error && error.message,
		error && String( error ),
	].filter( Boolean ).join( ' ' )

	return /quota|resource_exhausted|rate.?limit/i.test( text )

}

async function request( url, options = {} ) {

	const controller = new AbortController()
	const timer = setTimeout( () => controller.abort(), REQUEST_TIMEOUT_MS )
	try {

		return await fetch( url, { ...options, signal: controller.signal } )

	} finally {

		clearTimeout( timer )

	}

}

/**
 * Cheap credential check. Does not fetch Google's root tileset unless
 * `probeRoot` is set — that response is billable and uncacheable (`max-age=0`),
 * and the tiles renderer already loads root once per session.
 *
 *   Ion     hits the asset endpoint; with `probeRoot` (key-entry), also fetches
 *           the tileset root Ion hands back so a quota-dead Google path cannot
 *           dispose a working globe
 *   Google  without `probeRoot`, returns `{ ok, deferred }` so the caller can
 *           confirm via `awaitRootTilesAuth` on the live renderer; with
 *           `probeRoot` (key-entry only), fetches root before the working
 *           tileset is disposed, so a bad key does not blank the globe
 */
export async function verifyTileAuth( auth, { probeRoot = false } = {} ) {

	if ( ! auth?.key ) {

		return { ok: false, reason: 'Add a Cesium Ion token or Google Maps API key to load the globe.' }

	}

	try {

		if ( auth.kind === 'google' ) {

			if ( ! probeRoot ) return { ok: true, deferred: true }

			const res = await request( `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent( auth.key )}` )
			if ( res.ok ) return { ok: true }
			const body = await res.text().catch( () => '' )
			if ( isQuotaFailure( { status: res.status, body } ) ) {

				return { ok: false, status: res.status, reason: QUOTA_EXCEEDED_REASON, quota: true }

			}

			return { ok: false, status: res.status, reason: res.status === 403
				? 'That Google key was rejected. Check the Map Tiles API is enabled and the referrer restrictions allow this origin.'
				: `Google returned ${res.status}.` }

		}

		const res = await request( `https://api.cesium.com/v1/assets/${GOOGLE_TILES_ASSET}/endpoint?access_token=${encodeURIComponent( auth.key )}` )
		const body = await res.text().catch( () => '' )
		if ( ! res.ok ) {

			if ( isQuotaFailure( { status: res.status, body } ) ) {

				return { ok: false, status: res.status, reason: QUOTA_EXCEEDED_REASON, quota: true }

			}

			return { ok: false, status: res.status, reason: res.status === 401 || res.status === 403
				? 'Cesium Ion rejected that token.'
				: `Cesium Ion returned ${res.status}.` }

		}

		if ( ! probeRoot ) return { ok: true }

		// Ion's endpoint can stay green while Google's root behind it is 429.
		// Follow the URL it returns before disposing the live tileset.
		return probeIonTilesRoot( body )

	} catch ( error ) {

		if ( isQuotaFailure( { error } ) ) {

			return { ok: false, reason: QUOTA_EXCEEDED_REASON, quota: true }

		}

		return { ok: false, reason: error?.name === 'AbortError'
			? 'The tile service did not respond in time.'
			: 'Could not reach the tile service. Check the network.' }

	}

}

/**
 * Fetches the tileset root described by a Cesium Ion asset endpoint body.
 *
 * Ion returns two shapes for asset 2275207:
 *   hosted   `{ url, accessToken }`
 *   external `{ externalType, options: { url } }` — Google Photorealistic tiles,
 *            key already in the query string (see CesiumIonAuthPlugin)
 */
async function probeIonTilesRoot( endpointBody ) {

	let endpoint
	try {

		endpoint = JSON.parse( endpointBody )

	} catch {

		return { ok: false, reason: 'Cesium Ion returned an unreadable endpoint.' }

	}

	const url = endpoint?.externalType
		? endpoint.options?.url
		: endpoint?.url

	if ( ! url ) {

		return { ok: false, reason: 'Cesium Ion did not return a tileset URL. Add Google Photorealistic 3D Tiles (asset 2275207) to your Ion account, then try again.' }

	}

	const headers = {}
	if ( endpoint.accessToken ) headers.Authorization = `Bearer ${ endpoint.accessToken }`

	const res = await request( url, { headers } )
	if ( res.ok ) return { ok: true }

	const body = await res.text().catch( () => '' )
	if ( isQuotaFailure( { status: res.status, body } ) ) {

		return { ok: false, status: res.status, reason: QUOTA_EXCEEDED_REASON, quota: true }

	}

	return {
		ok: false,
		status: res.status,
		reason: res.status === 401 || res.status === 403
			? 'The tile service rejected this key. Enter a Cesium Ion token or a Google Maps API key.'
			: `The tile root returned ${ res.status }.`,
	}

}

/**
 * Waits for the tiles renderer's root tileset — the single Google root request
 * we want to spend. Resolves with the same shape as `verifyTileAuth`.
 *
 * Root failures arrive as `load-error` with `tile: null`; leaf failures are
 * ignored here so a missing mesh tile cannot look like a bad key.
 */
export function awaitRootTilesAuth( tiles, { timeoutMs = 20000 } = {} ) {

	return new Promise( resolve => {

		let settled = false
		let timer = 0

		const finish = result => {

			if ( settled ) return
			settled = true
			tiles.removeEventListener( 'load-root-tileset', onRoot )
			tiles.removeEventListener( 'load-error', onError )
			clearTimeout( timer )
			resolve( result )

		}

		const onRoot = () => finish( { ok: true } )

		const onError = event => {

			if ( event.tile != null ) return
			const interpreted = interpretTileError( event )
			if ( interpreted ) finish( interpreted )

		}

		// Listeners first, then the already-loaded check — otherwise a root
		// that lands in that gap is missed and we wait out the full timeout.
		tiles.addEventListener( 'load-root-tileset', onRoot )
		tiles.addEventListener( 'load-error', onError )

		if ( tiles.rootTileset || tiles.root ) {

			finish( { ok: true } )
			return

		}

		// Still loading after a long wait — keep the key prompt open rather
		// than reporting success. Re-check once: a root that landed in the
		// same turn as the timer must not look like a failure.
		timer = setTimeout( () => {

			if ( tiles.rootTileset || tiles.root ) finish( { ok: true } )
			else finish( {
				ok: false,
				timedOut: true,
				reason: 'The tile service did not respond in time. Check the key and try again.',
			} )

		}, timeoutMs )

	} )

}

/**
 * Turns a 3d-tiles-renderer `load-error` event into the same shape as
 * `verifyTileAuth`, or null when the failure is not something the key prompt
 * can fix (transient network blips, a single missing tile, …).
 */
export function interpretTileError( event ) {

	const error = event && event.error
	const status = error && ( error.status || error.statusCode )
	const message = error && error.message ? error.message : String( error || '' )
	const statusMatch = message.match( /\b([45]\d\d)\b/ )
	const fromMessage = statusMatch ? Number( statusMatch[ 1 ] ) : undefined
	const code = status || fromMessage

	if ( isQuotaFailure( { status: code, error, body: message } ) ) {

		return { ok: false, status: code, reason: QUOTA_EXCEEDED_REASON, quota: true }

	}

	// Auth failures — referrer lock, revoked token, Ion asset no longer shared.
	// Ask again rather than spam the console with every failed tile.
	if ( code === 401 || code === 403 ) {

		return {
			ok: false,
			status: code,
			reason: 'The tile service rejected this key. Enter a Cesium Ion token or a Google Maps API key.',
		}

	}

	return null

}
