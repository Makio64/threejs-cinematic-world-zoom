/**
 * Copies the atmosphere and cloud binaries out of node_modules into public/.
 *
 * The takram packages default to fetching these from a githubusercontent LFS
 * URL at runtime. That is a bad dependency for any app and a disqualifying one
 * for a recording tool: a slow or blocked fetch does not fail loudly, it just
 * silently produces a sky with no clouds and shadow sampling that dithers
 * against a missing texture, which looks like heavy colour noise over the whole
 * frame. Serving them locally makes the first frame deterministic.
 */

import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' )
const out = join( root, 'public', 'assets' )
const nm = join( root, 'node_modules' )

const COPIES = [
	[ '@takram/three-atmosphere/assets/stars.bin', 'stars.bin' ],
	[ '@takram/three-clouds/assets/local_weather.png', 'local_weather.png' ],
	[ '@takram/three-clouds/assets/shape.bin', 'shape.bin' ],
	[ '@takram/three-clouds/assets/shape_detail.bin', 'shape_detail.bin' ],
	[ '@takram/three-clouds/assets/turbulence.png', 'turbulence.png' ],
]

mkdirSync( out, { recursive: true } )

// Older installs downloaded Takram's default STBN volume here. That file is
// derived from NVIDIA's separately licensed dataset, so it must not slip into
// an MIT release just because public/assets is cached between builds. World
// creates its own deterministic jitter texture now.
const legacyStbn = join( out, 'stbn.bin' )
if ( existsSync( legacyStbn ) ) {

	unlinkSync( legacyStbn )

}

for ( const [ from, to ] of COPIES ) {

	const source = join( nm, from )
	const dest = join( out, to )
	if ( ! existsSync( source ) ) throw new Error( `assets: missing ${ from } — run pnpm install first` )
	copyFileSync( source, dest )

}

console.log( `assets: prepared ${ COPIES.length } files in public/assets` )
