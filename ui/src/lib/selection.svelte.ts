import { tick, untrack } from 'svelte';
import type { SongItem } from './api';
import { ui } from './player.svelte';
import { emptySelection, reconcileSelection, toggleTrack, visibleTrackKeys,
	type TrackEntry } from './selection';

// Select mode is app-wide (the titlebar toggle), but a selection lives in one list. Whichever list
// gets the first pick claims it; until that list is empty again every other list stays a plain
// click-to-open list.
const claim = $state<{ owner: symbol | null }>({ owner: null });

/** Leave select mode everywhere. Each list drops its own selection once it sees the flag go down. */
export function exitSelectMode() {
	ui.multiSelect = false;
	claim.owner = null;
}

/** One list owns selection. Rows may unmount freely; navigation/account changes reset the scope. */
export function trackSelection(
	items: () => SongItem[], visible: () => SongItem[], scope: () => string,
	complete: () => boolean = () => true,
	/** The list's own length while pages are still missing, and the walk that fetches them. Only a
	 *  playlist has either: everywhere else the rows on screen are all the rows there are. */
	total: () => number | undefined = () => undefined,
	loadRest: () => Promise<boolean> = async () => true
) {
	let entries = $state.raw<TrackEntry[]>([]);
	let loadedKeys = $state.raw<ReadonlySet<string>>(new Set());
	let selected = $state.raw(emptySelection());
	let lost = $state(0);
	const me = Symbol();
	// In select mode clicks pick rows instead of playing them, until another list claims the
	// selection. Checkboxes and the bulk bar wait for this list to claim it.
	const active = $derived(ui.multiSelect && (claim.owner === null || claim.owner === me));
	const claimed = $derived(ui.multiSelect && claim.owner === me);
	let selectingAll = $state(false);
	// Bumped every time the selection is dropped out from under an in-flight selectAll: a walk that
	// comes back to a cleared list, another playlist, or a list no longer in select mode has nothing
	// left to select.
	let dropped = 0;
	let lastScope: string | undefined;
	let nextKey = 0;
	function release() {
		if (claim.owner === me) claim.owner = null;
	}
	// Claim on the first pick, let go on the last. Called after every write to `selected`.
	function settle() {
		if (selected.keys.size) claim.owner = me;
		else release();
	}
	// Select mode switched off (toggle, Escape, navigation), or another list took over: nothing here
	// stays selected, and an in-flight selectAll has nothing left to select.
	$effect(() => {
		if (active) return;
		untrack(() => {
			if (!selected.keys.size && !lost) return;
			selected = emptySelection();
			lost = 0;
			dropped++;
		});
	});
	// A list that unmounts while it holds the selection must not keep the others locked out.
	$effect(() => release);
	$effect(() => {
		const songs = items();
		const currentScope = scope();
		const allLoaded = complete();
		untrack(() => {
			if (lastScope !== currentScope) {
				entries = [];
				selected = emptySelection();
				lost = 0;
				dropped++;
				release();
				lastScope = currentScope;
			}
			// A server sort or cached-page refresh may replace a long list with its first page.
			// Missing selected occurrences are unresolved until the final page, not deleted.
			const next = reconcileSelection(songs, entries, selected, () => String(++nextKey), allLoaded);
			entries = next.entries;
			loadedKeys = next.loadedKeys;
			lost += selected.keys.size - next.selection.keys.size;
			selected = next.selection;
			if (claim.owner === me) settle();
		});
	});
	const visibleKeys = $derived(visibleTrackKeys(entries, visible()));
	const songs = $derived(entries.filter((e) => selected.keys.has(e.key)).map((e) => e.song));
	const pending = $derived(entries.filter((e) => selected.keys.has(e.key) && !loadedKeys.has(e.key)).length);
	const hidden = $derived(selected.keys.size - pending - visibleKeys.filter((k) => selected.keys.has(k)).length);
	// What Select all is offering. Until the last page is in, the rows on screen are not the count
	// to put on the button, so the list's own total stands in.
	const selectAllCount = $derived(complete() ? visibleKeys.length : (total() ?? visibleKeys.length));
	// Never while pages are outstanding: every row on screen being ticked is not the whole list.
	const allSelected = $derived(
		complete() && visibleKeys.length > 0 && visibleKeys.every((k) => selected.keys.has(k))
	);
	return {
		get active() { return active; },
		get claimed() { return claimed; },
		exit() { selected = emptySelection(); lost = 0; dropped++; exitSelectMode(); },
		get count() { return selected.keys.size; },
		get songs() { return songs; },
		get visibleKeys() { return visibleKeys; },
		get hidden() { return hidden; },
		get pending() { return pending; },
		get lost() { return lost; },
		has(key: string | undefined) { return key !== undefined && selected.keys.has(key); },
		toggle(key: string, range = false) {
			selected = toggleTrack(selected, key, visibleKeys, range);
			settle();
		},
		get selectAllCount() { return selectAllCount; },
		get allSelected() { return allSelected; },
		get selectingAll() { return selectingAll; },
		/**
		 * Select every row, pulling in the pages still missing first. Hidden selections survive it,
		 * and the first visible key becomes the anchor (the anchor clears if none are visible).
		 * A walk that gives up short selects what did arrive rather than nothing.
		 */
		async selectAll() {
			if (selectingAll) return;
			const at = dropped;
			selectingAll = true;
			try {
				if (!complete()) {
					await loadRest();
					// `entries` is written by the effect above, not derived, so the new pages are not
					// in `visibleKeys` until it has run.
					await tick();
				}
				// Cleared, navigated, switched account, or left select mode while the pages were in
				// the air. Whichever it was is the newer instruction, so it wins.
				if (dropped !== at) return;
				// Another list may have claimed the selection while the pages were in the air.
				if (!active) return;
				selected = { keys: new Set([...selected.keys, ...visibleKeys]), anchor: visibleKeys[0] ?? null };
				settle();
			} finally {
				selectingAll = false;
			}
		},
		clear() { selected = emptySelection(); lost = 0; dropped++; release(); }
	};
}

export type TrackSelection = ReturnType<typeof trackSelection>;
