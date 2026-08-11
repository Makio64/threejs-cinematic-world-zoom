import { Vector3 } from 'three'

import { formatCoord, LANDMARKS } from '../data/landmarks.js'

/**
 * A card pinned over a point on the planet once a flight lands.
 *
 * Two things use it. The conference entry carries a `featured` block — its own
 * mark in the place list, and a three-line card over the venue. A custom target
 * from a pasted map link or typed coordinate gets the same stem, with only the
 * lat/lon so the viewer can see exactly which point the flight picked.
 *
 * It builds its own element and decorates the list from the outside rather than
 * living inside UI: nothing else in the interface is anchored to a point on the
 * planet, and the projection maths is the same for both cards.
 */

const _point = new Vector3()
const _normal = new Vector3()
const _toEye = new Vector3()

/**
 * How far outside the frame the anchor may drift before the card is dropped.
 * A little past the edge rather than at it: a card whose stem points just off
 * screen still reads, and the alternative is one that blinks on the boundary.
 */
const EDGE_X = 1.25
const EDGE_Y = 1.45

export class Venue {

	constructor( world, root = document.getElementById( 'ui' ) ) {

		this.world = world
		this.card = null

		this.el = document.createElement( 'div' )
		this.el.className = 'venue'
		this.el.innerHTML =
			'<a class="venue-pin" target="_blank" rel="noopener">'
				+ '<span class="venue-lines">'
					+ '<b class="venue-title"></b>'
					+ '<i class="venue-when"></i>'
					+ '<em class="venue-link rule"></em>'
				+ '</span>'
				+ '<span class="venue-stem"></span>'
			+ '</a>'
		root.appendChild( this.el )

		this.pin = this.el.querySelector( '.venue-pin' )
		this.title = this.el.querySelector( '.venue-title' )
		this.when = this.el.querySelector( '.venue-when' )
		this.link = this.el.querySelector( '.venue-link' )

		this.decorateList()

	}

	/**
	 * Upgrades the rows the place list has already built, rather than teaching it
	 * about an entry that is not a landmark. The row stays a plain `.place`
	 * button — same hover-to-preview, same selection — it only wears the event's
	 * own identity.
	 *
	 * The logo replaces the name outright rather than sitting beside it: it says
	 * "THREE CONF.JS" itself, and setting that twice, once as a wordmark and once
	 * as type, reads as a mistake. The button keeps its accessible name from the
	 * image's alt text.
	 */
	decorateList( list = document.getElementById( 'places-list' ) ) {

		if ( ! list ) return

		for ( const landmark of LANDMARKS ) {

			const featured = landmark.featured
			if ( ! featured || ! featured.logo ) continue

			const row = list.querySelector( `.place[data-id="${landmark.id}"]` )
			if ( ! row ) continue

			row.classList.add( 'place-featured' )
			row.textContent = ''

			const logo = document.createElement( 'span' )
			logo.className = 'place-logo'
			if ( featured.logoType && featured.logoBadge ) {

				const type = document.createElement( 'img' )
				type.className = 'place-logo-type'
				type.src = featured.logoType
				type.alt = landmark.name
				const badge = document.createElement( 'img' )
				badge.className = 'place-logo-badge'
				badge.src = featured.logoBadge
				badge.alt = ''
				badge.setAttribute( 'aria-hidden', 'true' )
				logo.append( type, badge )

			} else {

				const img = document.createElement( 'img' )
				img.src = featured.logo
				img.alt = landmark.name
				logo.appendChild( img )

			}
			row.appendChild( logo )

			// the date carries the row now, with the venue under it — the name is
			// in the wordmark, so repeating it here would only cost a line
			const lines = document.createElement( 'b' )
			lines.textContent = featured.badge || ''
			if ( landmark.place ) {

				const where = document.createElement( 'small' )
				where.textContent = landmark.place
				lines.appendChild( where )

			}
			row.appendChild( lines )

			const country = document.createElement( 'i' )
			country.textContent = landmark.country
			row.appendChild( country )

		}

	}

	/**
	 * Takes a committed selection. Anywhere without a card takes the whole thing
	 * off the screen — this is also what stops a card left over from one landing
	 * reappearing over the next place.
	 */
	setTarget( target ) {

		const featured = target && target.featured
		const custom = target && target.id === 'custom'
		this.card = featured || custom || null
		document.body.classList.toggle( 'has-venue', Boolean( this.card ) )
		this.el.classList.toggle( 'is-coords', Boolean( custom && ! featured ) )
		this.el.classList.remove( 'on' )
		if ( ! this.card ) return

		if ( featured ) {

			const [ title, when, link ] = featured.card
			this.pin.href = featured.href
			this.title.textContent = title
			this.when.textContent = when
			this.link.textContent = link
			this.when.hidden = false
			this.link.hidden = false
			// three lines of type is a poor link text; the label is the whole of it
			this.pin.setAttribute( 'aria-label', `${title}, ${when} — ${link}` )
			return

		}

		// one line of lat/lon, pointing at the exact sample the link resolved to —
		// the shot readout already has the name, if the paste carried one
		const coords = formatCoord( target.lat, target.lon )
		this.pin.href = `https://www.google.com/maps?q=${target.lat},${target.lon}`
		this.title.textContent = coords
		this.when.textContent = ''
		this.link.textContent = ''
		this.when.hidden = true
		this.link.hidden = true
		this.pin.setAttribute( 'aria-label', coords )

	}

	/**
	 * Pins the card over the venue. Called once a frame, and only after a landing.
	 *
	 * The anchor is the shot's own aim point rather than a spot in the frame, so
	 * the card holds on the building through the residual orbit that closes every
	 * flight, and keeps holding if the viewer takes the camera themselves.
	 */
	update( state ) {

		if ( ! this.card ) return
		if ( state !== 'done' && state !== 'free' ) return this._hide()

		const { camera, target, tiles } = this.world
		if ( ! camera || ! target || ! tiles ) return

		const { ellipsoid } = tiles
		ellipsoid.getCartographicToPosition( target.latRad, target.lonRad, target.aimHeight, _point )

		// Round the back of the planet. The ground normal under the venue has to
		// face the camera, or a card that is geometrically in frame would be
		// floating over the Earth with the venue behind it.
		ellipsoid.getPositionToNormal( _point, _normal )
		if ( _normal.dot( _toEye.copy( camera.position ).sub( _point ) ) <= 0 ) return this._hide()

		// Split rather than `project()`, so the view-space depth can be tested
		// before the perspective divide folds everything behind the lens back
		// into the frame as a mirrored ghost.
		_point.applyMatrix4( camera.matrixWorldInverse )
		if ( _point.z > - camera.near ) return this._hide()
		_point.applyMatrix4( camera.projectionMatrix )

		if ( Math.abs( _point.x ) > EDGE_X || Math.abs( _point.y ) > EDGE_Y ) return this._hide()

		// CSS pixels: the drawing buffer carries the pixel ratio, the viewport
		// does not, and this is a DOM element
		const x = ( _point.x * 0.5 + 0.5 ) * window.innerWidth
		const y = ( 0.5 - _point.y * 0.5 ) * window.innerHeight
		this.el.style.transform = `translate3d(${x.toFixed( 1 )}px, ${y.toFixed( 1 )}px, 0)`
		this.el.classList.add( 'on' )

	}

	_hide() {

		this.el.classList.remove( 'on' )

	}

}
