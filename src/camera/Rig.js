import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three'

import { getEastNorthUpAxes } from '../geo.js'

/**
 * Geographic camera rig.
 *
 * The whole shot is described in the *target's* East-North-Up frame:
 *
 *   azimuth  compass bearing of the camera as seen from the target (0 = the
 *            camera sits due north of it and therefore looks south)
 *   pitch    elevation of the camera above the target's local horizon
 *            (0 = level with it, PI/2 = directly overhead)
 *   distance metres from the eye to the aim point
 *   roll     camera roll
 *   yaw/tilt look-away offsets applied in camera space, so the lens can point
 *            somewhere other than the subject (handheld drift, free-look framing)
 *
 * The basis is built analytically rather than with `lookAt`, because `lookAt`
 * is degenerate exactly where the interesting shots live — straight down at the
 * subject. Here the screen-up vector is `-sin(pitch)*h + cos(pitch)*up`, which
 * stays continuous and unit-length through pitch = 90 degrees.
 */

const _east = new Vector3()
const _north = new Vector3()
const _up = new Vector3()
const _h = new Vector3()
const _dir = new Vector3()
const _x = new Vector3()
const _y = new Vector3()
const _z = new Vector3()
const _eye = new Vector3()
const _aim = new Vector3()
const _basis = new Matrix4()
const _q = new Quaternion()
const _relative = new Quaternion()
const _angles = new Euler()

const MAX_PITCH = MathUtils.degToRad( 89.5 )
const MIN_PITCH = MathUtils.degToRad( -20 )

/** Width of the rounded corner where the ground-clearance constraint engages. */
const SOFT_CLEARANCE = MathUtils.degToRad( 3 )

export class CameraRig {

	constructor( ellipsoid ) {

		this.ellipsoid = ellipsoid

		// target in radians / metres above the ellipsoid
		this.lat = 0
		this.lon = 0
		this.aimHeight = 0

		// the camera is never allowed below this ellipsoidal height
		this.minHeight = 40

		// last resolved state, useful for debug readouts and for handing over to
		// the free-look controls when a shot ends
		this.state = {
			azimuth: 0,
			pitch: Math.PI / 2,
			distance: 1e7,
			roll: 0,
			fov: 45,
			yaw: 0,
			tilt: 0,
		}
		this.position = new Vector3()
		this.quaternion = new Quaternion()
		this.aim = new Vector3()
		this.altitude = 0

	}

	setTarget( lat, lon, aimHeight ) {

		this.lat = lat
		this.lon = lon
		this.aimHeight = aimHeight
		return this

	}

	/** Writes the aim point (the point the shot orbits and frames) into `target`. */
	getAimPoint( target = new Vector3() ) {

		return this.ellipsoid.getCartographicToPosition( this.lat, this.lon, this.aimHeight, target )

	}

	/**
	 * Resolves a shot state onto a camera. Returns the resolved state, with
	 * `pitch` possibly raised to keep the camera above `minHeight`.
	 */
	apply( camera, state ) {

		const { ellipsoid } = this
		const distance = Math.max( state.distance, 1 )

		getEastNorthUpAxes( ellipsoid, this.lat, this.lon, _east, _north, _up )
		ellipsoid.getCartographicToPosition( this.lat, this.lon, this.aimHeight, _aim )

		const azimuth = state.azimuth
		_h.copy( _east ).multiplyScalar( Math.sin( azimuth ) )
			.addScaledVector( _north, Math.cos( azimuth ) )

		// Ground clearance. Solve the *minimal* pitch that clears `minHeight`
		// from the bottom up — d(height)/d(pitch) is distance*cos(pitch), so
		// this converges in a couple of steps and degrades to the clamp when
		// it cannot — then take a smooth maximum against the authored pitch.
		// A hard max would engage with a rate kink exactly at the crossing,
		// which reads as the camera catching on something mid-landing; the
		// rounded corner keeps the resolved pitch C1 through the constraint.
		const requested = MathUtils.clamp( state.pitch, MIN_PITCH, MAX_PITCH )
		const needed = this._neededPitch( distance, _aim, _h, _up )
		const pitch = resolvePitch( requested, needed )

		this._eyeAt( pitch, distance, _aim, _h, _up, _eye )

		// camera basis: +z points from the aim back to the eye, +y is the
		// screen-up that stays continuous through the top-down singularity
		setCameraAxes( pitch, _h, _up )

		if ( state.roll ) rotatePair( _x, _y, state.roll )
		if ( state.yaw ) rotatePair( _z, _x, state.yaw )
		if ( state.tilt ) rotatePair( _y, _z, state.tilt )

		_basis.makeBasis( _x, _y, _z )
		_q.setFromRotationMatrix( _basis )

		camera.position.copy( _eye )
		camera.quaternion.copy( _q )
		camera.up.copy( _y )
		camera.updateMatrixWorld()

		if ( state.fov !== undefined && camera.fov !== state.fov ) {

			camera.fov = state.fov
			camera.updateProjectionMatrix()

		}

		this.position.copy( _eye )
		this.quaternion.copy( _q )
		this.aim.copy( _aim )
		this.altitude = ellipsoid.getPositionElevation( _eye )

		const resolved = this.state
		resolved.azimuth = azimuth
		resolved.pitch = pitch
		resolved.distance = distance
		resolved.roll = state.roll || 0
		resolved.fov = state.fov !== undefined ? state.fov : resolved.fov
		resolved.yaw = state.yaw || 0
		resolved.tilt = state.tilt || 0

		return resolved

	}

	_neededPitch( distance, aim, h, up ) {

		const { ellipsoid } = this
		let needed = MIN_PITCH
		for ( let i = 0; i < 8; i ++ ) {

			this._eyeAt( needed, distance, aim, h, up, _eye )
			const elevation = ellipsoid.getPositionElevation( _eye )
			if ( elevation >= this.minHeight - 0.5 || needed >= MAX_PITCH ) break

			const slope = Math.max( distance * Math.cos( needed ), 1 )
			needed = Math.min( needed + ( this.minHeight - elevation ) / slope, MAX_PITCH )

		}

		return needed

	}

	_eyeAt( pitch, distance, aim, h, up, target ) {

		_dir.copy( h ).multiplyScalar( Math.cos( pitch ) ).addScaledVector( up, Math.sin( pitch ) )
		return target.copy( aim ).addScaledVector( _dir, distance )

	}

	/**
	 * Reads a shot state back off an arbitrary camera, so free-look can hand
	 * over to a shot without a jump.
	 */
	readFromCamera( camera, target = {} ) {

		const { ellipsoid } = this
		getEastNorthUpAxes( ellipsoid, this.lat, this.lon, _east, _north, _up )
		ellipsoid.getCartographicToPosition( this.lat, this.lon, this.aimHeight, _aim )

		_dir.copy( camera.position ).sub( _aim )
		const distance = _dir.length()
		_dir.divideScalar( distance || 1 )

		const e = _dir.dot( _east )
		const n = _dir.dot( _north )
		const u = _dir.dot( _up )

		const azimuth = Math.atan2( e, n )
		const pitch = Math.atan2( u, Math.hypot( e, n ) )
		_h.copy( _east ).multiplyScalar( Math.sin( azimuth ) )
			.addScaledVector( _north, Math.cos( azimuth ) )

		// Invert the rounded clearance maximum before storing pitch. Feeding the
		// already-resolved pitch through apply() would lift the camera a second time.
		const needed = this._neededPitch( Math.max( distance, 1 ), _aim, _h, _up )
		const requested = requestedPitchFor( pitch, needed )
		const resolvedPitch = resolvePitch( requested, needed )

		// apply() composes Rz(roll) * Ry(yaw) * Rx(tilt) on this base frame, so
		// ZYX recovers the same three offsets from an arbitrary camera quaternion.
		setCameraAxes( resolvedPitch, _h, _up )
		_basis.makeBasis( _x, _y, _z )
		_q.setFromRotationMatrix( _basis )
		_relative.copy( _q ).invert().multiply( camera.quaternion ).normalize()
		_angles.setFromQuaternion( _relative, 'ZYX' )

		target.distance = distance
		target.azimuth = azimuth
		target.pitch = requested
		target.roll = _angles.z
		target.yaw = _angles.y
		target.tilt = _angles.x
		target.fov = camera.fov
		return target

	}

}

function resolvePitch( requested, needed ) {

	const gap = requested - needed
	return Math.min(
		0.5 * ( requested + needed + Math.hypot( gap, SOFT_CLEARANCE ) ),
		MAX_PITCH,
	)

}

/** Inverse of resolvePitch's rounded maximum, for camera-to-rig hand-offs. */
function requestedPitchFor( pitch, needed ) {

	const gap = pitch - needed
	const requested = gap > 0
		? pitch - SOFT_CLEARANCE ** 2 / ( 4 * gap )
		: MIN_PITCH
	return MathUtils.clamp( requested, MIN_PITCH, MAX_PITCH )

}

function setCameraAxes( pitch, h, up ) {

	const cp = Math.cos( pitch )
	const sp = Math.sin( pitch )
	_z.copy( h ).multiplyScalar( cp ).addScaledVector( up, sp )
	_y.copy( h ).multiplyScalar( -sp ).addScaledVector( up, cp )
	_x.crossVectors( _y, _z ).normalize()
	_y.crossVectors( _z, _x ).normalize()

}

/**
 * Rotates a perpendicular unit pair in its own plane — `a` turns towards `b`.
 * Equivalent to rotating the frame about the third axis, without building a
 * quaternion for it.
 */
function rotatePair( a, b, angle ) {

	const c = Math.cos( angle )
	const s = Math.sin( angle )
	const ax = a.x, ay = a.y, az = a.z
	a.set( ax * c + b.x * s, ay * c + b.y * s, az * c + b.z * s )
	b.set( b.x * c - ax * s, b.y * c - ay * s, b.z * c - az * s )

}
