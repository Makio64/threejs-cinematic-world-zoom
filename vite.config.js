import { defineConfig } from 'vite'

const TILE_CREDENTIAL_BUILD_MODE = 'embed-tile-credentials'
const TILE_CREDENTIAL_ENV_KEYS = [ 'VITE_ION_TOKEN', 'VITE_GOOGLE_API_KEY' ]

export default defineConfig( ( { command, mode } ) => {

	const exposeTileCredentials = command === 'serve' || mode === TILE_CREDENTIAL_BUILD_MODE

	return {
		// Only these two VITE_* values may cross the client boundary, and never in
		// a normal build. The alternate prefix matches nothing used by this app.
		envPrefix: exposeTileCredentials ? TILE_CREDENTIAL_ENV_KEYS : 'CINEMATIC_WORLD_PUBLIC_',
		server: {
			port: 5180,
		},
		// mediabunny / postprocessing ship large ESM bundles — pre-bundle them once
		optimizeDeps: {
			include: [ 'three', '3d-tiles-renderer', 'postprocessing', 'mediabunny' ],
		},
	}

} )
