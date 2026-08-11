/**
 * Writes a deterministic East-North-Up frame, including at the poles.
 *
 * The ellipsoid helper derives east from the surface position, whose horizontal
 * components are both zero at the north pole. Longitude still defines a stable
 * meridian there, so east is simpler and safer to build from it directly.
 */
export function getEastNorthUpAxes( ellipsoid, lat, lon, east, north, up ) {

	ellipsoid.getCartographicToNormal( lat, lon, up )
	east.set( -Math.sin( lon ), Math.cos( lon ), 0 )
	north.crossVectors( up, east ).normalize()

}
