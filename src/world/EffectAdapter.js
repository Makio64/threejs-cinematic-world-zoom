import { HalfFloatType } from 'three'
import { EffectMaterial } from 'postprocessing'

/**
 * Bridges a pmndrs `postprocessing` pass into `WebGLRenderer.setEffects()`.
 *
 * three's effect contract is duck-typed: `render(renderer, writeBuffer,
 * readBuffer)` — note the argument order is the reverse of postprocessing's
 * `render(renderer, inputBuffer, outputBuffer)`.
 *
 * Three things the obvious version of this gets wrong:
 *
 *  - `needsSwap` must be read live. `EffectPass` recomputes it whenever its
 *    effects change; snapshotting it at construction can leave the chain
 *    reading a buffer nothing wrote to.
 *  - only three's first render target carries a depth texture, so a
 *    depth-consuming pass that is not first in the chain silently gets none.
 *    The depth texture is therefore captured once and pushed in explicitly.
 *  - three calls `end()` without a delta, so the whole chain would advance
 *    time by NaN. The clock is injected from outside instead, which is also
 *    what makes frame-locked recording reproducible.
 */
export class EffectAdapter {

	constructor( pass, { camera = null } = {} ) {

		this.pass = pass
		this.camera = camera
		this.enabled = true
		this.deltaTime = 1 / 60

		this._initialized = false
		this._depthTexture = null
		this._adoptedCamera = null

	}

	get needsSwap() {

		return this.pass.needsSwap

	}

	render( renderer, writeBuffer, readBuffer ) {

		if ( this._depthTexture === null && readBuffer.depthTexture ) {

			this._depthTexture = readBuffer.depthTexture

		}

		if ( this._initialized === false ) {

			this.pass.initialize( renderer, false, HalfFloatType )
			this.pass.setSize( readBuffer.width, readBuffer.height )
			if ( this._depthTexture !== null && this.pass.setDepthTexture ) {

				this.pass.setDepthTexture( this._depthTexture )

			}

			this._initialized = true

		}

		const material = this.pass.fullscreenMaterial
		if ( material instanceof EffectMaterial && this.camera !== null ) {

			// copyCameraSettings also installs the PERSPECTIVE_CAMERA define,
			// which is what gates the sun and moon discs — but it dirties the
			// material, so it only runs once. near/far change every frame and are
			// written straight into the uniforms.
			if ( this._adoptedCamera !== this.camera ) {

				material.copyCameraSettings( this.camera )
				this._adoptedCamera = this.camera

			} else {

				material.uniforms.cameraNear.value = this.camera.near
				material.uniforms.cameraFar.value = this.camera.far

			}

		}

		this.pass.render( renderer, readBuffer, writeBuffer, this.deltaTime )

	}

	setSize( width, height ) {

		if ( this._initialized ) this.pass.setSize( width, height )

	}

	dispose() {

		if ( this.pass.dispose ) this.pass.dispose()

	}

}

/** Keeps every adapter in a chain on the same clock. */
export function setChainDelta( adapters, deltaTime ) {

	for ( let i = 0; i < adapters.length; i ++ ) adapters[ i ].deltaTime = deltaTime

}
