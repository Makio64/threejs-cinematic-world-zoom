import { captureSize } from '../record/Recorder.js'
import { coordTarget, formatCoord, LANDMARKS, parseLocation, searchKey } from '../data/landmarks.js'
import { parseCoordText, parseMapLink } from '../data/mapLinks.js'
import { SHOTS, SHOT_KEYS } from '../camera/shots.js'
import { LIGHT_KEYS, LIGHT_PRESETS } from '../sun.js'

/** Shortest first: seven seconds is about the floor for a fall this long. */
const DURATIONS = [ 7, 10, 15, 20 ]

const DEFAULT_PLACE = 'threejs-conf-paris'
const PLACE_STORAGE_KEY = 'cinematic-world.lastPlace'
const MOBILE_PICKER_QUERY = '(max-width: 860px)'

/** How long a verification runs before the card says it is still working. */
const KEY_SLOW_MS = 4000

/** How long a rejection stays on the card before it clears itself. */
const KEY_NOTICE_MS = 5000

/**
 * What setup says back, in the words the card uses. `tilesAuth` answers in the
 * services' own vocabulary — tokens, tilesets, asset 2275207 — which is exactly
 * what the beginner this screen is for does not have. Rewriting here rather
 * than there keeps the verification honest and the copy in one place.
 *
 * Anything unmatched passes through: a bare `Cesium Ion returned 500.` is
 * already short, and inventing a friendlier version of an unknown failure only
 * makes it harder to report.
 *
 * None of these tells the reader to paste. The same string has to read right on
 * the first screen, where a key arrived in a `?ion=` link somebody sent them and
 * there is no field in front of them, as it does under the field itself.
 */
const KEY_REASONS = [
	{
		// a brand new Ion account has no 3D tiles on it, and generic
		// "check you copied it" advice sends the user round the loop again
		test: /did not return a tileset URL/,
		text: 'That Cesium account needs the 3D map first. Add “Google Photorealistic 3D Tiles”, then try the key again.',
		href: 'https://ion.cesium.com/assetdepot/2275207',
		label: 'Add it on Cesium ↗',
	},
	{
		// Ion itself said no — the check got as far as api.cesium.com
		test: /rejected that token/,
		text: 'Cesium did not recognise that key. Check the whole line was copied.',
	},
	{
		// A live root refused, and neither tilesAuth nor this table knows whose
		// root it was: naming Cesium here would be wrong for every Google key,
		// and for an Ion token whose Google root is the thing refusing.
		test: /rejected this key/,
		text: 'The map service refused that key. If it is a Google key, check the Map Tiles API is on and this site is allowed.',
	},
	{
		test: /Google key was rejected/,
		text: 'Google rejected that key. Check the Map Tiles API is on and that this site is allowed.',
		href: 'https://developers.google.com/maps/documentation/tile/get-api-key',
		label: 'Google key setup ↗',
	},
	{
		test: /did not respond in time|Could not reach the tile service/,
		text: 'The map service did not answer. Check your connection and try again.',
	},
]

/** Quota comes from the caller, never from the string — it is not a bad key. */
function keyReason( message, quota ) {

	if ( ! message ) return { text: '' }
	if ( quota ) {

		return { text: 'That key has hit its 3D map limit. The key itself is fine — try another one, or come back later.' }

	}

	const match = KEY_REASONS.find( reason => reason.test.test( message ) )
	return match ? { text: match.text, href: match.href, label: match.label } : { text: message }

}

const $ = id => document.getElementById( id )

/** Last committed place — landmark id, or a custom lat/lon with optional name. */
function rememberPlace( target ) {

	if ( ! target ) return

	try {

		const payload = target.id === 'custom'
			? { id: 'custom', lat: target.lat, lon: target.lon, name: target.name }
			: { id: target.id }
		localStorage.setItem( PLACE_STORAGE_KEY, JSON.stringify( payload ) )

	} catch {}

}

function loadLastPlace() {

	try {

		return JSON.parse( localStorage.getItem( PLACE_STORAGE_KEY ) || 'null' )

	} catch {

		return null

	}

}

/**
 * The whole interface is four buttons, a start button and a record toggle.
 *
 * Place and shot open a list; light and length cycle: click and they advance
 * to the next option. The place list previews itself — hovering an entry turns
 * the globe to it, so choosing is something you do by looking rather than by
 * reading — and the shot list carries each move's tagline, which is the only
 * way to pick a camera move you haven't flown yet.
 *
 * It owns no application state beyond what it needs to render. Everything
 * meaningful lives in the world and comes back through the setters; every user
 * action leaves through a callback.
 */
export class UI {

	constructor() {

		this.el = {
			body: document.body,
			bar: $( 'bar' ),
			optPlace: $( 'opt-place' ),
			optShot: $( 'opt-shot' ),
			optLight: $( 'opt-light' ),
			optLength: $( 'opt-length' ),
			places: $( 'places' ),
			placesClose: $( 'places-close' ),
			placesList: $( 'places-list' ),
			shots: $( 'shots' ),
			shotsClose: $( 'shots-close' ),
			shotsList: $( 'shots-list' ),
			search: $( 'search' ),
			coordLat: $( 'coord-lat' ),
			coordLon: $( 'coord-lon' ),
			coordGo: $( 'coord-go' ),
			go: $( 'btn-go' ),
			goLabel: document.querySelector( '.go-label' ),
			record: $( 'btn-record' ),
			settings: $( 'settings' ),
			settingsBtn: $( 'btn-settings' ),
			settingsClose: $( 'settings-close' ),
			help: $( 'btn-help' ),
			status: $( 'status' ),
			fps: $( 'fps' ),
			finish: $( 'finish' ),
			shotName: document.querySelector( '.shot-name' ),
			shotPlace: document.querySelector( '.shot-place' ),
			shotCoord: document.querySelector( '.shot-coord' ),
			shotAlt: document.querySelector( '.shot-alt' ),
			recPill: document.querySelector( '.rec-pill span' ),
			bootText: document.querySelector( '.boot-text' ),
			sunNote: $( 'sun-note' ),
			keyPrompt: $( 'keyprompt' ),
			keyCard: $( 'keyprompt-card' ),
			keyBody: $( 'keyprompt-body' ),
			keyChapter: $( 'keyprompt-chapter' ),
			keyCount: $( 'keyprompt-count' ),
			keyCountVh: $( 'keyprompt-count-vh' ),
			keyForm: $( 'keyform' ),
			keyMessage: $( 'keyprompt-msg' ),
			keyNoteLink: $( 'keyprompt-msg-link' ),
			keyInput: $( 'keyinput' ),
			keySave: $( 'keysave' ),
			keyGet: $( 'keyget' ),
			keyStepGet: $( 'keystep-get' ),
			keyStepPaste: $( 'keystep-paste' ),
			keyActGet: $( 'keyact-get' ),
			keyActPaste: $( 'keyact-paste' ),
		}

		this.selection = {
			landmark: DEFAULT_PLACE,
			shot: 'flyby',
			light: 'golden',
			duration: 15,
		}

		this.on = {
			select: () => {},
			preview: () => {},
			previewEnd: () => {},
			shot: () => {},
			light: () => {},
			duration: () => {},
			go: () => {},
			abort: () => {},
			record: () => {},
			replay: () => {},
			change: () => {},
			save: () => {},
			advanced: () => {},
			key: () => {},
		}

		this.armed = false
		this._custom = null
		this._previewTimer = 0
		this._previewing = false
		this._fpsLast = 0
		this._fpsMean = 0
		this._fpsWrote = 0
		this._mobilePicker = window.matchMedia( MOBILE_PICKER_QUERY )
		this._keyReturnFocus = null
		this._keyStep = 'paste'
		this._keyChecking = false
		// bumped on every open, so a verification that lands long after the card
		// it belongs to was answered cannot close the next one — see keyAccepted
		this._keyGen = 0
		this._keySlowTimer = 0
		this._keyNoticeTimer = 0

		this._buildPlaces()
		this._buildShots()
		this._bindOptions()
		this._bindSearch()
		this._bindCoords()
		this._bindButtons()
		this._bindKeyPrompt()
		this._bindAdvanced()
		this._bindKeys()
		this._mobilePicker.addEventListener( 'change', () => this._syncPickerSemantics() )

	}

	// ------------------------------------------------------------- building

	_buildPlaces() {

		const frag = document.createDocumentFragment()
		for ( const landmark of LANDMARKS ) {

			const item = document.createElement( 'button' )
			item.className = 'place'
			item.type = 'button'
			item.dataset.id = landmark.id
			item.setAttribute( 'aria-pressed', 'false' )
			item.innerHTML =
				`<em aria-hidden="true">${landmark.cat}</em>`
				+ `<span class="place-copy"><b>${landmark.name}</b><small>${landmark.place}</small></span>`
				+ `<i>${landmark.country}</i>`

			// hovering turns the globe to the place, so the list previews itself
			item.addEventListener( 'pointerenter', () => this._previewPlace( landmark ) )
			item.addEventListener( 'focus', () => this._previewPlace( landmark ) )
			item.addEventListener( 'click', () => {

				this.select( landmark.id )
				this._closePlaces()

			} )
			frag.appendChild( item )

		}
		this.el.placesList.appendChild( frag )

	}

	_buildShots() {

		const frag = document.createDocumentFragment()
		SHOT_KEYS.forEach( ( key, index ) => {

			const shot = SHOTS[ key ]
			const item = document.createElement( 'button' )
			item.className = 'shot-option'
			item.type = 'button'
			item.dataset.id = key
			item.setAttribute( 'aria-pressed', 'false' )
			const n = String( index + 1 ).padStart( 2, '0' )
			item.innerHTML =
				`<span class="shot-index">${n}</span>`
				+ `<span class="shot-copy"><b>${shot.name}</b><i>${shot.tagline}</i></span>`
			item.addEventListener( 'click', () => {

				this.selectShot( key )
				this._closeShots()

			} )
			frag.appendChild( item )

		} )
		this.el.shotsList.appendChild( frag )

	}

	_previewPlace( landmark ) {

		clearTimeout( this._previewTimer )
		if ( landmark.id === this.selection.landmark ) {

			this._endPreview()
			return

		}
		this._previewTimer = setTimeout( () => {

			this._previewing = true
			this.on.preview( landmark )

		}, 90 )

	}

	_endPreview() {

		clearTimeout( this._previewTimer )
		if ( ! this._previewing ) return
		this._previewing = false
		this.on.previewEnd()

	}

	// -------------------------------------------------------- cycling options

	_bindOptions() {

		this.el.optPlace.addEventListener( 'click', () => this._togglePlaces() )
		this.el.optShot.addEventListener( 'click', () => this._toggleShots() )
		this.el.placesClose.addEventListener( 'click', () => this._closePlaces() )
		this.el.shotsClose.addEventListener( 'click', () => this._closeShots() )
		this.el.places.addEventListener( 'keydown', event => {

			this._handlePickerKey( event, this.el.places, () => this._closePlaces() )

		}, true )
		this.el.shots.addEventListener( 'keydown', event => {

			this._handlePickerKey( event, this.el.shots, () => this._closeShots() )

		}, true )

		this._cycle( this.el.optLight, () => LIGHT_KEYS, 'light', key => {

			this.on.light( key )
			this.flashStatus( LIGHT_PRESETS[ key ].note, 2200 )

		} )

		this._cycle( this.el.optLength, () => DURATIONS, 'duration', value => this.on.duration( value ) )

		this.renderOptions()

	}

	_cycle( button, values, key, notify ) {

		const advance = () => {

			const list = values()
			const index = list.indexOf( this.selection[ key ] )
			const next = list[ ( index + 1 ) % list.length ]
			this.selection[ key ] = next
			this.renderOptions()
			notify( next )

		}
		button.addEventListener( 'click', advance )
		button._advance = advance

	}

	/** Writes the current value into each button, with a small step animation. */
	renderOptions() {

		const place = this._custom || LANDMARKS.find( l => l.id === this.selection.landmark )
		this._setValue( this.el.optPlace, place ? place.name : '—' )
		this._setValue( this.el.optShot, SHOTS[ this.selection.shot ].name )
		this._setValue( this.el.optLight, LIGHT_PRESETS[ this.selection.light ].name )
		this._setValue( this.el.optLength, `${this.selection.duration}s` )

		for ( const item of this.el.placesList.querySelectorAll( '.place' ) ) {

			item.setAttribute( 'aria-pressed', item.dataset.id === this.selection.landmark ? 'true' : 'false' )

		}

		for ( const item of this.el.shotsList.querySelectorAll( '.shot-option' ) ) {

			item.setAttribute( 'aria-pressed', item.dataset.id === this.selection.shot ? 'true' : 'false' )

		}

	}

	selectShot( key ) {

		if ( ! SHOTS[ key ] || key === this.selection.shot ) return
		this.selection.shot = key
		this.renderOptions()
		this.on.shot( key )
		this.flashStatus( SHOTS[ key ].tagline, 2200 )

	}

	_setValue( button, text ) {

		const node = button.querySelector( '.opt-value' )
		if ( node.textContent === text ) return
		node.textContent = text
		node.classList.remove( 'step' )
		// force a reflow so the animation restarts on every change
		void node.offsetWidth
		node.classList.add( 'step' )

	}

	// -------------------------------------------------------------- popovers

	_togglePlaces() {

		// opening is an idle-only act — elsewhere the bar is hidden, and an
		// invisible popover would still catch clicks meant for the canvas
		if ( ! this.el.body.classList.contains( 'places-open' )
			&& ! this.el.body.classList.contains( 'state-idle' ) ) return

		const open = this.el.body.classList.toggle( 'places-open' )
		this.el.optPlace.setAttribute( 'aria-expanded', open ? 'true' : 'false' )
		if ( open ) {

			this._closeShots()
			this.el.body.classList.remove( 'settings-open' )
			this.el.settingsBtn.setAttribute( 'aria-expanded', 'false' )
			const active = this.el.placesList.querySelector( '.place[aria-pressed="true"]' )
			if ( active ) active.scrollIntoView( { block: 'center' } )
			this._activatePickerModal( this.el.places, 'places-open', active )

		} else {

			this._endPreview()
			this._deactivatePickerModal( this.el.places, this.el.optPlace )

		}

	}

	_toggleShots() {

		if ( ! this.el.body.classList.contains( 'shots-open' )
			&& ! this.el.body.classList.contains( 'state-idle' ) ) return

		const open = this.el.body.classList.toggle( 'shots-open' )
		this.el.optShot.setAttribute( 'aria-expanded', open ? 'true' : 'false' )
		if ( open ) {

			this._endPreview()
			this._closePlaces()
			this.el.body.classList.remove( 'settings-open' )
			this.el.settingsBtn.setAttribute( 'aria-expanded', 'false' )
			const active = this.el.shotsList.querySelector( '.shot-option[aria-pressed="true"]' )
			this._activatePickerModal( this.el.shots, 'shots-open', active )

		} else {

			this._deactivatePickerModal( this.el.shots, this.el.optShot )

		}

	}

	_closeShots() {

		this.el.body.classList.remove( 'shots-open' )
		this.el.optShot.setAttribute( 'aria-expanded', 'false' )
		this._deactivatePickerModal( this.el.shots, this.el.optShot )

	}

	_closePlaces() {

		this._endPreview()
		this.el.body.classList.remove( 'places-open' )
		this.el.optPlace.setAttribute( 'aria-expanded', 'false' )
		this._deactivatePickerModal( this.el.places, this.el.optPlace )
		// A filter left applied means the next open shows a list with entries
		// missing and no visible reason why.
		this._clearFilter()

	}

	_activatePickerModal( picker, openClass, focusTarget ) {

		if ( ! this._mobilePicker.matches ) return

		picker.setAttribute( 'aria-modal', 'true' )
		setTimeout( () => {

			if ( ! this.el.body.classList.contains( openClass ) ) return
			const target = focusTarget || picker.querySelector( '.picker-close' )
			if ( target ) target.focus( { preventScroll: true } )

		}, 0 )

	}

	_deactivatePickerModal( picker, trigger ) {

		const restoreFocus = picker.hasAttribute( 'aria-modal' ) && picker.contains( document.activeElement )
		picker.removeAttribute( 'aria-modal' )
		if ( ! restoreFocus ) return

		setTimeout( () => trigger.focus( { preventScroll: true } ), 0 )

	}

	_syncPickerSemantics() {

		const mobile = this._mobilePicker.matches
		this.el.places.toggleAttribute( 'aria-modal', mobile && this.el.body.classList.contains( 'places-open' ) )
		this.el.shots.toggleAttribute( 'aria-modal', mobile && this.el.body.classList.contains( 'shots-open' ) )

	}

	_handlePickerKey( event, picker, close ) {

		if ( ! this._mobilePicker.matches ) return
		if ( event.key === 'Escape' ) {

			event.preventDefault()
			event.stopImmediatePropagation()
			close()
			return

		}
		if ( event.key !== 'Tab' ) return

		const focusable = [ ...picker.querySelectorAll(
			'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
		) ].filter( element => ! element.hidden && element.getClientRects().length )
		if ( ! focusable.length ) return

		const active = document.activeElement
		const first = focusable[ 0 ]
		const last = focusable[ focusable.length - 1 ]
		const wrapBackward = event.shiftKey && ( active === first || ! picker.contains( active ) )
		const wrapForward = ! event.shiftKey && ( active === last || ! picker.contains( active ) )
		if ( ! wrapBackward && ! wrapForward ) return

		event.preventDefault()
		const target = wrapBackward ? last : first
		target.focus( { preventScroll: true } )

	}

	_clearFilter() {

		this.el.search.value = ''
		for ( const item of this.el.placesList.querySelectorAll( '.place' ) ) {

			item.style.display = ''

		}

	}

	_toggleSettings( force ) {

		const open = force !== undefined
			? this.el.body.classList.toggle( 'settings-open', force )
			: this.el.body.classList.toggle( 'settings-open' )
		this.el.settingsBtn.setAttribute( 'aria-expanded', open ? 'true' : 'false' )
		if ( open ) {

			this._closePlaces()
			this._closeShots()

		}

	}

	// -------------------------------------------------------------- bindings

	/**
	 * Resolves free text (typed or pasted into the search field) into a place.
	 */
	_applyLocation( text ) {

		const { target, source, reason } = parseLocation( text )
		if ( ! target ) {

			this.flashStatus(
				reason || 'Nothing found — paste a Google Maps URL, or try 48.8582, 2.2945',
				5200,
			)
			return false

		}

		this.el.search.value = ''
		this.el.search.blur()
		this._closePlaces()
		if ( target.id === 'custom' ) this.selectCustom( target )
		else this.select( target.id )

		if ( source ) this.flashStatus( `From ${source} — ${formatCoord( target.lat, target.lon )}`, 3200 )
		return true

	}

	/**
	 * The lat/lon row: type a coordinate pair, press Enter or Go, and that
	 * point becomes the target — the same "custom location" the search box
	 * builds from a pasted pair, reachable without knowing the syntax.
	 */
	_bindCoords() {

		const { coordLat, coordLon, coordGo } = this.el

		const apply = () => {

			const target = coordTarget( parseFloat( coordLat.value ), parseFloat( coordLon.value ) )
			if ( ! target ) {

				this.flashStatus( 'Enter a valid latitude (−90…90) and longitude (−180…180)' )
				return

			}
			coordLat.blur()
			coordLon.blur()
			this._closePlaces()
			this.selectCustom( target )

		}

		/**
		 * A whole pair, or a whole map link, dropped into one of two number
		 * boxes. Left alone the browser would reject it outright — neither is a
		 * number — so the paste is caught, split across both fields, and flown to.
		 * Anything without a coordinate in it falls through to the input, which
		 * is still the right home for a half-typed latitude.
		 */
		const paste = event => {

			const text = event.clipboardData?.getData( 'text' )?.trim()
			if ( ! text ) return

			const link = parseMapLink( text )
			const point = link && link.lat !== undefined ? link : parseCoordText( text )
			if ( ! point ) {

				if ( link?.reason ) {

					event.preventDefault()
					this.flashStatus( link.reason, 5200 )

				}
				return

			}

			event.preventDefault()
			coordLat.value = point.lat.toFixed( 5 )
			coordLon.value = point.lon.toFixed( 5 )
			apply()
			if ( link ) this.flashStatus( `From ${link.source} — ${formatCoord( point.lat, point.lon )}`, 3200 )

		}

		coordGo.addEventListener( 'click', apply )

		for ( const input of [ coordLat, coordLon ] ) {

			input.addEventListener( 'paste', paste )
			input.addEventListener( 'keydown', event => {

				event.stopPropagation()
				if ( event.key === 'Enter' ) apply()
				else if ( event.key === 'Escape' ) {

					input.blur()
					this._closePlaces()

				}

			} )

		}

	}

	_bindSearch() {

		const { search } = this.el

		search.addEventListener( 'keydown', event => {

			event.stopPropagation()
			if ( event.key === 'Escape' ) {

				search.value = ''
				search.blur()
				this._closePlaces()

			} else if ( event.key === 'Enter' ) {

				this._applyLocation( search.value )

			}

		} )

		// A pasted link resolves on the spot. Nobody pastes a URL in order to keep
		// typing, and a box full of `!3d48.85!4d2.29` is nothing anyone can read —
		// so it never lands in the field unless it turned out to be unusable.
		search.addEventListener( 'paste', event => {

			const text = event.clipboardData?.getData( 'text' )?.trim()
			if ( ! text || ! parseMapLink( text ) ) return

			event.preventDefault()
			if ( ! this._applyLocation( text ) ) search.value = text

		} )

		// filter the list as you type
		search.addEventListener( 'input', () => {

			const needle = searchKey( search.value )
			for ( const item of this.el.placesList.querySelectorAll( '.place' ) ) {

				const landmark = LANDMARKS.find( l => l.id === item.dataset.id )
				const hit = ! needle
					|| [ landmark.name, landmark.place, landmark.country ]
						.some( field => searchKey( field ).includes( needle ) )
				item.style.display = hit ? '' : 'none'

			}

		} )

	}

	_bindButtons() {

		this.el.go.addEventListener( 'click', () => {

			const body = this.el.body
			if ( body.classList.contains( 'state-flying' ) || body.classList.contains( 'state-loading' ) ) {

				this.on.abort()

			} else {

				this.on.go()

			}

		} )

		this.el.record.addEventListener( 'click', () => this.toggleRecord() )
		this.el.settingsBtn.addEventListener( 'click', () => this._toggleSettings() )
		this.el.settingsClose.addEventListener( 'click', () => this._toggleSettings( false ) )
		this.el.help.addEventListener( 'click', () => this.el.body.classList.toggle( 'show-help' ) )
		document.querySelector( '.help' ).addEventListener( 'click', () => {

			this.el.body.classList.remove( 'show-help' )

		} )

		this.el.places.addEventListener( 'pointerleave', () => this._endPreview() )

		// a click anywhere else closes whichever popover is open
		document.addEventListener( 'pointerdown', event => {

			if ( ! this.el.places.contains( event.target ) && ! this.el.optPlace.contains( event.target ) ) {

				if ( this.el.body.classList.contains( 'places-open' ) ) {

					this._endPreview()
					this._closePlaces()

				}

			}
			if ( ! this.el.shots.contains( event.target ) && ! this.el.optShot.contains( event.target ) ) {

				if ( this.el.body.classList.contains( 'shots-open' ) ) this._closeShots()

			}
			if ( ! this.el.settings.contains( event.target ) && ! this.el.settingsBtn.contains( event.target ) ) {

				if ( this.el.body.classList.contains( 'settings-open' ) ) this._toggleSettings( false )

			}

		}, true )

		for ( const button of this.el.finish.querySelectorAll( 'button' ) ) {

			button.addEventListener( 'click', () => this.on[ button.dataset.act ]() )

		}

	}

	/**
	 * Setup: two screens, one question each. Get a key, then paste it.
	 *
	 * The step is never inferred — `askForKey` is told which screen to open on,
	 * and only ever on the way in. Four of the five ways the gate can open are
	 * a key that stopped working, and walking someone who has already been here
	 * back through an explanation is the thing this replaced.
	 */
	_bindKeyPrompt() {

		this.el.keyForm.addEventListener( 'submit', event => {

			event.preventDefault()
			if ( this._keyChecking ) return
			const value = this.el.keyInput.value.trim()
			if ( ! value ) {

				this.keyRejected( 'Paste your key to continue.' )
				return

			}
			this.keyNotice( '' )
			this.on.key( value )

		} )

		this.el.keyInput.addEventListener( 'input', () => {

			if ( ! this.el.keyPrompt.classList.contains( 'has-error' ) ) return
			this.keyNotice( '' )

		} )

		// one gesture: the tab opens and the card moves on, so coming back from
		// the errand lands on a focused field with nothing left to decide
		this.el.keyGet.addEventListener( 'click', () => this._showKeyStep( 'paste' ) )

		for ( const button of this.el.keyCard.querySelectorAll( '[data-key-step]' ) ) {

			button.addEventListener( 'click', () => {

				if ( this._keyChecking ) return
				this._showKeyStep( button.dataset.keyStep, { back: button.dataset.keyStep === 'get' } )

			} )

		}

		// On document, in capture: hiding the step that holds the focused element
		// blurs it to <body>, and a listener on the card would then never fire —
		// which is exactly when the trap has to hold.
		document.addEventListener( 'keydown', event => this._handleKeyPromptKey( event ), true )

	}

	/**
	 * The settings panel.
	 *
	 * It carries only what is worth changing before a take — whether clouds throw
	 * shadows, and how the file is written. The rest of the look is art direction
	 * the light and shot presets already do, so it lives on `world` instead:
	 * `exposureBias`, `handheld`, `cloudShadows`, `tuneLight()` and `setFraming()`
	 * are all live from the console (see the `cinematicWorld` global in main.js).
	 *
	 * To surface one of those as a control: add the input to index.html, add a
	 * `bind()` line here, and handle the key in `onAdvanced` in main.js.
	 */
	_bindAdvanced() {

		this.advancedValues = {}

		const bind = ( id, key ) => {

			const input = $( id )
			const push = () => {

				const raw = input.type === 'checkbox' ? input.checked : input.value
				this.advancedValues[ key ] = input.tagName === 'SELECT' && ! isNaN( Number( raw ) )
					? Number( raw )
					: raw
				this.on.advanced( key, this.advancedValues[ key ] )

			}
			input.addEventListener( 'change', push )
			push()

		}

		bind( 'cloud-shadows', 'cloudShadows' )
		bind( 'rec-res', 'resolution' )
		bind( 'rec-fps', 'fps' )
		bind( 'rec-ar', 'aspect' )
		bind( 'rec-quality', 'quality' )

		// The letterbox is the export frame, not decoration: keep the preview
		// matte locked to whatever aspect will actually be encoded, and spell out
		// the pixel size, since "1080p" alone is ambiguous off 16:9.
		const syncAspect = () => {

			document.documentElement.style.setProperty( '--ar', $( 'rec-ar' ).value )
			const { width, height } = captureSize( {
				resolution: Number( $( 'rec-res' ).value ),
				aspect: Number( $( 'rec-ar' ).value ),
			} )
			$( 'rec-size' ).textContent = `Exports at ${width} × ${height}.`

		}
		$( 'rec-ar' ).addEventListener( 'change', syncAspect )
		$( 'rec-res' ).addEventListener( 'change', syncAspect )
		syncAspect()

	}

	_bindKeys() {

		window.addEventListener( 'keydown', event => {

			if ( event.metaKey || event.ctrlKey || event.altKey || event.repeat ) return
			if ( this.el.body.classList.contains( 'keyprompt-open' ) ) return
			if ( event.target instanceof Element
				&& event.target.closest( 'input, select, textarea, button, a, [contenteditable]' ) ) return
			const body = this.el.body
			const idle = body.classList.contains( 'state-idle' )
			const flying = body.classList.contains( 'state-flying' )
			const loading = body.classList.contains( 'state-loading' )

			switch ( event.key ) {

				case 'Escape':
					if ( body.classList.contains( 'show-help' ) ) body.classList.remove( 'show-help' )
					else if ( body.classList.contains( 'places-open' ) ) { this._endPreview(); this._closePlaces() }
					else if ( body.classList.contains( 'shots-open' ) ) this._closeShots()
					else if ( body.classList.contains( 'settings-open' ) ) this._toggleSettings( false )
					else this.on.abort()
					break

				case ' ':
				case 'Enter':
					// with focus inside a popover the key belongs to the focused
					// option — let the button's native activation select it
					if ( event.target instanceof Element && event.target.closest( '.places, .shots' ) ) break
					event.preventDefault()
					if ( flying || loading ) this.on.abort()
					else this.on.go()
					break

				case 'p': case 'P':
					if ( ! idle ) break
					this._togglePlaces()
					break

				case 's': case 'S':
					if ( ! idle ) break
					this._toggleShots()
					break

				case 'l': case 'L':
					if ( ! idle ) break
					this.el.optLight._advance()
					break

				case 't': case 'T':
					if ( ! idle ) break
					this.el.optLength._advance()
					break

				case 'ArrowLeft':
					if ( ! idle ) break
					this._step( -1 )
					break

				case 'ArrowRight':
					if ( ! idle ) break
					this._step( 1 )
					break

				case 'r': case 'R':
					if ( ! idle ) break
					// the recorder is desktop-only; the mobile bar has no REC
					if ( window.matchMedia( '(max-width: 860px)' ).matches ) break
					this.toggleRecord()
					break

				case 'h': case 'H':
					body.classList.toggle( 'ui-hidden' )
					break

				case 'f': case 'F':
					if ( document.fullscreenElement ) document.exitFullscreen()
					else document.documentElement.requestFullscreen?.()
					break

				case '?':
					body.classList.toggle( 'show-help' )
					break

				default:
					break

			}

		} )

	}

	_step( direction ) {

		const index = LANDMARKS.findIndex( l => l.id === this.selection.landmark )
		const nextIndex = index < 0
			? direction > 0 ? 0 : LANDMARKS.length - 1
			: ( index + direction + LANDMARKS.length ) % LANDMARKS.length
		const next = LANDMARKS[ nextIndex ]
		this.select( next.id )

	}

	// -------------------------------------------------------------- setters

	select( id ) {

		const landmark = LANDMARKS.find( l => l.id === id )
		if ( ! landmark ) return

		this._custom = null
		this._previewing = false
		clearTimeout( this._previewTimer )
		this.selection.landmark = id
		this.renderOptions()
		this.showTarget( landmark )
		rememberPlace( landmark )
		this.on.select( landmark )

	}

	selectCustom( target ) {

		this._custom = target
		this._previewing = false
		clearTimeout( this._previewTimer )
		this.selection.landmark = 'custom'
		this.renderOptions()
		this.showTarget( target )
		rememberPlace( target )
		this.on.select( target )

	}

	/**
	 * Reopen on the place that was last committed. Falls back to the conference
	 * when nothing is stored, or the stored landmark id has left the table.
	 */
	restoreLastPlace() {

		const saved = loadLastPlace()
		if ( saved?.id === 'custom' ) {

			const target = coordTarget( saved.lat, saved.lon, { name: saved.name } )
			if ( target ) {

				this.selectCustom( target )
				return

			}

		} else if ( saved?.id && LANDMARKS.some( l => l.id === saved.id ) ) {

			this.select( saved.id )
			return

		}

		this.select( DEFAULT_PLACE )

	}

	/** The current selection, re-resolved. Used to restore after a preview. */
	currentTarget() {

		return this._custom || LANDMARKS.find( l => l.id === this.selection.landmark )

	}

	/** Keeps a probed custom height when a place-list preview is dismissed. */
	setCustomGround( groundHeight ) {

		if ( ! this._custom || ! Number.isFinite( groundHeight ) ) return
		this._custom.groundH = groundHeight
		this._custom.geoidN = 0
		this._custom.needsGroundProbe = false

	}

	showTarget( target ) {

		const where = [ target.place, target.country ].filter( Boolean ).join( ' · ' )
		this.el.shotName.textContent = target.name
		this.el.shotPlace.textContent = where
		this.el.shotCoord.textContent = formatCoord( target.lat, target.lon )

		// the coordinate fields mirror the target, so a picked place is also a
		// starting point the user can nudge — but never mid-keystroke
		const active = document.activeElement
		if ( active !== this.el.coordLat && active !== this.el.coordLon ) {

			this.el.coordLat.value = target.lat.toFixed( 5 )
			this.el.coordLon.value = target.lon.toFixed( 5 )

		}

	}

	/**
	 * Reports the moment the daylight solve landed on — the date the shaders will
	 * actually be lit by, not the one that was asked for. Worth showing: it is the
	 * only visible evidence that the sun was solved rather than guessed, and on a
	 * polar coordinate it is where you find out the elevation was unreachable.
	 */
	syncLight( solved ) {

		if ( ! solved ) return

		const when = solved.date.toISOString().replace( 'T', ' ' ).slice( 0, 16 )
		this.el.sunNote.textContent = solved.exact
			? `${when} UTC · sun ${solved.elevation.toFixed( 1 )}° above the horizon`
			: `${when} UTC · closest this latitude gets is ${solved.elevation.toFixed( 1 )}°`

	}

	setState( state ) {

		const body = this.el.body
		for ( const name of [ ...body.classList ] ) {

			if ( name.startsWith( 'state-' ) ) body.classList.remove( name )

		}
		body.classList.add( `state-${state}` )
		body.classList.remove( 'overlay-on' )
		// free-look is the tail of a finished flight, so the card stays — it is
		// the only way back to replay or to another place from there
		if ( state !== 'done' && state !== 'free' ) body.classList.remove( 'show-finish' )
		if ( state !== 'idle' ) {

			// end an active hover preview before closing, or a launch would fly
			// to the hovered place while the readout still names the selection
			this._endPreview()
			this._closePlaces()
			this._closeShots()
			this._toggleSettings( false )

		}
		this.el.goLabel.textContent = state === 'flying' || state === 'loading'
			? 'Abort'
			: this.armed ? 'Record' : 'Start'
		this.el.record.disabled = state !== 'idle'

	}

	/** Drives the in-flight overlay from shot time, never the wall clock. */
	setFlightReadout( { progress, altitude } ) {

		document.documentElement.style.setProperty( '--progress', progress.toFixed( 4 ) )
		// metres all the way down: the landing is where this readout is actually
		// read, and there it is a two- or three-digit number. Only the top of the
		// plunge, where metres run to seven digits, falls back to kilometres.
		this.el.shotAlt.textContent = altitude > 1e5
			? `${Math.round( altitude / 1000 ).toLocaleString( 'en-US' )} km`
			: `${Math.round( altitude ).toLocaleString( 'en-US' )} m`

		// in at a tenth, out at just past halfway — the part of the flight where
		// the subject actually fills the frame stays clean
		this.el.body.classList.toggle( 'overlay-on', progress > 0.08 && progress < 0.56 )

	}

	/**
	 * Frames per second, from the interval between frames rather than a counter:
	 * averaged over about a second so a single long frame bends the number
	 * instead of spiking it, and written four times a second, which is as fast
	 * as a number can change and still be read.
	 */
	tickFps() {

		const now = performance.now()
		const last = this._fpsLast
		this._fpsLast = now
		if ( ! last ) return

		const dt = now - last
		// a gap this long is the loop having been stopped — for a capture, a tab
		// in the background — not a slow frame, so start the average over
		if ( dt > 500 ) {

			this._fpsMean = 0
			return

		}

		this._fpsMean = this._fpsMean ? this._fpsMean + ( dt - this._fpsMean ) * 0.06 : dt
		if ( now - this._fpsWrote < 250 ) return
		this._fpsWrote = now
		this.el.fps.textContent = `${Math.round( 1000 / this._fpsMean )} FPS`

	}

	setLoad( value ) {

		document.documentElement.style.setProperty( '--load', value.toFixed( 3 ) )

	}

	showFinish( hasVideo ) {

		this.el.finish.querySelector( '.save' ).hidden = ! hasVideo
		this.el.body.classList.add( 'show-finish' )

	}

	toggleRecord() {

		if ( ! this.el.body.classList.contains( 'state-idle' )
			|| window.matchMedia( '(max-width: 860px)' ).matches ) return

		this.armed = ! this.armed
		this.el.record.setAttribute( 'aria-pressed', this.armed ? 'true' : 'false' )
		this.el.body.classList.toggle( 'is-recording', this.armed )
		this.el.goLabel.textContent = this.armed ? 'Record' : 'Start'
		this.on.record( this.armed )

	}

	setCapturing( on ) {

		this.el.body.classList.toggle( 'is-capturing', on )

	}

	setCaptureProgress( info ) {

		const time = seconds => {

			const m = Math.floor( seconds / 60 )
			const s = Math.floor( seconds % 60 )
			return `${String( m ).padStart( 2, '0' )}:${String( s ).padStart( 2, '0' )}`

		}
		this.el.recPill.textContent =
			`REC  ${time( info.shotTime )} / ${time( info.duration )}   ${info.rate.toFixed( 2 )}× realtime`

	}

	/**
	 * @param {string} text
	 * @param {{ html?: boolean }} [opts] `html: true` only for authored markup
	 *   (e.g. `<b>` around a resolution). Error strings and map-link reasons
	 *   stay on `textContent`.
	 */
	status( text, { html = false } = {} ) {

		clearTimeout( this._statusTimer )
		if ( ! text ) this.el.status.textContent = ''
		else if ( html ) this.el.status.innerHTML = text
		else this.el.status.textContent = text
		this.el.status.classList.toggle( 'on', Boolean( text ) )

	}

	flashStatus( text, ms = 2600, opts ) {

		this.status( text, opts )
		this._statusTimer = setTimeout( () => this.status( '' ), ms )

	}

	/** The generation a dismissal belongs to. See keyAccepted. */
	get keyGen() {

		return this._keyGen

	}

	/**
	 * Opens setup on `stage`, and only moves the user when it is the call that
	 * opens the card. A tile failure can arrive while someone is reading step
	 * one; it gets to rewrite the notice, not to yank the screen out from under
	 * them. `stage` defaults to 'paste' because four of the five ways in are a
	 * key that has stopped working — only a visitor we hold nothing for asks
	 * for 'get'.
	 */
	askForKey( message, { invalid = false, quota = false, stage = 'paste' } = {} ) {

		const opening = this.el.keyPrompt.hidden
		this.el.keyPrompt.hidden = false
		this.el.body.classList.add( 'keyprompt-open' )
		this._setKeyGate( true )

		if ( opening ) {

			this._keyGen ++
			this._keyReturnFocus = document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
			this.el.keyPrompt.classList.toggle( 'is-single', stage !== 'get' )
			this._showKeyStep( stage )

		}

		// last, and synchronously: _showKeyStep has flushed the unhide, so the
		// live region is rendered before its text changes — and nothing is left
		// queued that a later failure's message could be overwritten by
		this.keyNotice( message, { invalid, quota } )

	}

	/**
	 * The one thing the card ever says back, in the footer so that no step
	 * change can hide it. Step-neutral on purpose: it is also how a rejection
	 * reaches someone who has wandered back to the first screen.
	 */
	keyNotice( message, { invalid = false, quota = false } = {} ) {

		clearTimeout( this._keyNoticeTimer )

		const { text, href, label } = keyReason( message, quota )
		this.el.keyMessage.textContent = text
		this.el.keyPrompt.classList.toggle( 'has-error', invalid )
		if ( invalid ) this.el.keyInput.setAttribute( 'aria-invalid', 'true' )
		else this.el.keyInput.removeAttribute( 'aria-invalid' )

		this.el.keyNoteLink.hidden = ! href
		if ( href ) {

			this.el.keyNoteLink.href = href
			this.el.keyNoteLink.textContent = label

		}

		// A rejection is a reply to something the user just did: they read it,
		// and after that it is only a red mark sitting under the field. It takes
		// itself away, and the row it leaves stays open so the card does not
		// resize. One exception — a notice carrying a link, where the link is
		// the fix and has to still be there when they reach for it.
		if ( ! text || ! invalid || href ) return
		this._keyNoticeTimer = setTimeout( () => this.keyNotice( '' ), KEY_NOTICE_MS )

	}

	/** Never navigates: an empty field must not move anyone off the screen. */
	keyRejected( message, { quota = false } = {} ) {

		this.keyNotice( message, { invalid: true, quota } )
		// before the focus move: select() needs the field out of readOnly
		this.keyChecking( false )
		this.el.keyInput.focus( { preventScroll: true } )
		this.el.keyInput.select()

	}

	keyChecking( checking ) {

		this._keyChecking = checking
		this.el.keyPrompt.classList.toggle( 'is-checking', checking )
		this.el.keyForm.setAttribute( 'aria-busy', checking ? 'true' : 'false' )
		this.el.keyInput.readOnly = checking

		// aria-disabled, not disabled: disabling the button the user just
		// clicked blurs focus to <body> and drops the only primary out of the
		// focus ring for the whole verification, which can run twenty seconds
		this.el.keySave.setAttribute( 'aria-disabled', String( checking ) )
		this.el.keyActPaste.querySelector( '.keyalt' ).setAttribute( 'aria-disabled', String( checking ) )
		this.el.keySave.querySelector( 'span' ).textContent = checking
			? this.el.keySave.dataset.busy
			: this.el.keySave.dataset.label

		clearTimeout( this._keySlowTimer )
		if ( ! checking ) return
		// a round trip to the tile service can take fifteen seconds; a spinner
		// alone is indistinguishable from a card that has stopped responding
		this._keySlowTimer = setTimeout( () => {

			this.keyNotice( 'Still checking — the map service can take a few seconds.' )

		}, KEY_SLOW_MS )

	}

	/**
	 * Swaps the visible step. `hidden` rather than opacity, so the outgoing
	 * step leaves the box tree in the same frame: the focus ring is built from
	 * what has client rects, and two steps on screen at once would put the
	 * other screen's controls in the tab order.
	 */
	_showKeyStep( id, { back = false } = {} ) {

		const get = id === 'get'
		this._keyStep = id
		this.el.keyStepGet.hidden = ! get
		this.el.keyStepPaste.hidden = get
		this.el.keyActGet.hidden = ! get
		this.el.keyActPaste.hidden = get

		const single = this.el.keyPrompt.classList.contains( 'is-single' )
		this.el.keyChapter.textContent = single ? 'Setup' : get ? 'Your free key' : 'Paste it'
		this.el.keyCount.textContent = get ? '01 / 02' : '02 / 02'
		this.el.keyCountVh.textContent = `Step ${ get ? 1 : 2 } of 2`
		this.el.keyCard.style.setProperty( '--keystep', get ? '.5' : '1' )
		this.el.keyCard.setAttribute( 'aria-labelledby', get ? 'keyget-title' : 'keypaste-title' )
		this.el.keyPrompt.classList.toggle( 'is-back', back )
		this.el.keyPrompt.classList.toggle( 'is-step-get', get )

		// going back to the explanation must not leave a rejection standing
		// under a heading it has nothing to do with
		if ( get ) this.keyNotice( '' )

		// The card may have been unhidden in this same task, and a just-shown
		// step cannot take focus until the render tree catches up. Reading
		// layout does that now rather than a frame later — a deferred callback
		// here is still queued while a mid-session failure writes the next
		// message, and would land on top of it. Worse in a background tab,
		// where rAF does not run at all: setup is answered with the Cesium tab
		// in front, so that is not a corner case here.
		void this.el.keyBody.offsetHeight
		this.el.keyBody.scrollTop = 0
		const target = get ? this.el.keyStepGet.querySelector( 'h2' ) : this.el.keyInput
		target.focus( { preventScroll: true } )

	}

	_setKeyGate( gated ) {

		for ( const element of document.querySelectorAll( '#view, #ui > :not(#keyprompt)' ) ) {

			element.inert = gated

		}

	}

	_handleKeyPromptKey( event ) {

		if ( ! this.el.body.classList.contains( 'keyprompt-open' ) ) return

		// Setup is required, so Escape is deliberately not a way around it —
		// and deliberately not a way back a step either, since most visits open
		// on the second screen and have no first screen to return to.
		if ( event.key === 'Escape' ) {

			event.preventDefault()
			event.stopImmediatePropagation()
			return

		}

		// Enter anywhere on the first screen takes the one action it offers.
		// Controls keep their own activation, so nothing fires twice.
		if ( event.key === 'Enter' ) {

			if ( event.isComposing || this.el.keyStepGet.hidden ) return
			if ( event.target instanceof Element
				&& event.target.closest( 'a, button, input, select, textarea' ) ) return
			event.preventDefault()
			this.el.keyGet.click()
			return

		}
		if ( event.key !== 'Tab' ) return

		const focusable = [ ...this.el.keyCard.querySelectorAll(
			'a[href], input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
		) ].filter( element => element.getClientRects().length )
		if ( ! focusable.length ) return

		// by index, not by identity: focus parks on the step heading, which is
		// inside the card but not in the ring, and neither end test would fire
		const index = focusable.indexOf( document.activeElement )
		const wrapBackward = event.shiftKey && index <= 0
		const wrapForward = ! event.shiftKey && ( index === -1 || index === focusable.length - 1 )
		if ( ! wrapBackward && ! wrapForward ) return

		event.preventDefault()
		const target = wrapBackward ? focusable[ focusable.length - 1 ] : focusable[ 0 ]
		target.focus( { preventScroll: true } )

	}

	/**
	 * `gen` is the generation the caller's verification began under. A live
	 * root load can confirm a key twenty seconds after its card was optimistically
	 * dismissed; by then a tile failure may have raised a new one, and that
	 * success has nothing to say about it.
	 */
	keyAccepted( gen = null ) {

		if ( gen !== null && gen !== this._keyGen ) return

		const returnFocus = this._keyReturnFocus
		this.keyChecking( false )
		clearTimeout( this._keyNoticeTimer )
		this.el.keyPrompt.hidden = true
		this.el.keyPrompt.classList.remove( 'has-error', 'is-back' )
		this.el.body.classList.remove( 'keyprompt-open' )
		this.el.keyInput.removeAttribute( 'aria-invalid' )
		this.el.keyInput.value = ''
		this.el.keyMessage.textContent = ''
		this.el.keyNoteLink.hidden = true
		this._setKeyGate( false )
		this._keyReturnFocus = null
		if ( this.el.body.classList.contains( 'state-idle' ) && returnFocus?.isConnected ) {

			returnFocus.focus( { preventScroll: true } )

		}

	}

	/**
	 * The stroke-and-label mark used at startup. After boot, the same call is
	 * the wait indicator for ground probes, settle, and cache warm-up — empty
	 * string dismisses it.
	 */
	boot( text ) {

		this.el.bootText.textContent = text || ''
		if ( ! this.el.body.classList.contains( 'state-boot' ) ) {

			this.el.body.classList.toggle( 'is-waiting', Boolean( text ) )

		}

	}

	bootDone() {

		this.el.body.classList.remove( 'state-boot', 'is-waiting' )

	}

}
