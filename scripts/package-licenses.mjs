/** Copies the project and runtime dependency licenses into the release. */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' )
const dist = join( root, 'dist' )
const licenses = join( dist, 'licenses' )

if ( ! existsSync( dist ) ) throw new Error( 'licenses: dist/ does not exist — build first' )

const COPIES = [
	[ 'LICENSE', 'LICENSE' ],
	[ 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md' ],
	[ 'node_modules/three/LICENSE', 'licenses/three-MIT.txt' ],
	[ 'node_modules/3d-tiles-renderer/LICENSE', 'licenses/3d-tiles-renderer-Apache-2.0.txt' ],
	[ 'third_party_licenses/mapbox-point-geometry-ISC.txt', 'licenses/mapbox-point-geometry-ISC.txt' ],
	[ 'third_party_licenses/mapbox-vector-tile-BSD-3-Clause.txt', 'licenses/mapbox-vector-tile-BSD-3-Clause.txt' ],
	[ 'third_party_licenses/fflate-MIT.txt', 'licenses/fflate-MIT.txt' ],
	[ 'third_party_licenses/pbf-BSD-3-Clause.txt', 'licenses/pbf-BSD-3-Clause.txt' ],
	[ 'third_party_licenses/pmtiles-BSD-3-Clause.txt', 'licenses/pmtiles-BSD-3-Clause.txt' ],
	[ 'third_party_licenses/takram-MIT.txt', 'licenses/takram-MIT.txt' ],
	[ 'node_modules/mediabunny/LICENSE', 'licenses/mediabunny-MPL-2.0.txt' ],
	[ 'node_modules/postprocessing/LICENSE.md', 'licenses/postprocessing-Zlib.txt' ],
]

mkdirSync( licenses, { recursive: true } )
for ( const [ from, to ] of COPIES ) {

	const source = join( root, from )
	if ( ! existsSync( source ) ) throw new Error( `licenses: missing ${from}` )
	copyFileSync( source, join( dist, to ) )

}

console.log( `licenses: packaged ${COPIES.length - 2} third-party license files` )
