/**
 * `scripts/copy-assets.mjs` copies these files into public/ before dev or build.
 * Keep the URLs relative to Vite's base so deployments under a subpath work.
 */

const BASE = `${ import.meta.env.BASE_URL }assets/`

export const ASSETS = {
	stars: `${ BASE }stars.bin`,
	localWeather: `${ BASE }local_weather.png`,
	shape: `${ BASE }shape.bin`,
	shapeDetail: `${ BASE }shape_detail.bin`,
	turbulence: `${ BASE }turbulence.png`,
}

/** Fetches one of the local runtime assets. */
export async function fetchAsset( name ) {

	const url = assetUrl( name )
	const res = await fetch( url )
	if ( ! res.ok ) throw new Error( `${ name }: HTTP ${ res.status }` )
	return res.arrayBuffer()

}

/** Returns the URL for loaders that fetch assets themselves. */
export function assetUrl( name ) {

	const url = ASSETS[ name ]
	if ( ! url ) throw new Error( `unknown asset: ${ name }` )
	return url

}
