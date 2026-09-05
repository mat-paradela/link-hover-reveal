import { Editor, Notice, Plugin, setIcon } from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	KeyBinding,
	ViewPlugin,
	ViewUpdate,
	keymap,
} from "@codemirror/view";
import {
	EditorSelection,
	EditorState,
	Prec,
	RangeSetBuilder,
	Text,
} from "@codemirror/state";

// Matches markdown links, e.g. [My bookmark title](https://example.com)
// Negative lookbehind excludes image embeds: ![alt](url)
const LINK_RE = /(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

const TITLE_CLASS = "link-hover-reveal-title";

interface LinkData {
	from: number;
	to: number;
	title: string;
	url: string;
}

interface LinkRange extends LinkData {
	titleFrom: number;
	titleTo: number;
}

function toLinkRange(match: RegExpExecArray, offset: number): LinkRange {
	const [raw, title, url] = match;
	const from = offset + match.index;
	const titleFrom = from + 1; // right after "["
	return {
		from,
		to: from + raw.length,
		titleFrom,
		titleTo: titleFrom + title.length, // right before "]"
		title,
		url,
	};
}

/** Every link on the line holding `pos`. Link syntax can't span a line break
 * (the title rejects "\n", the url rejects whitespace), so one line is an
 * exhaustive scan — cheap enough to redo on every keystroke, and always in
 * sync with the state it was handed, unlike the view plugin's cached list. */
function linksOnLine(doc: Text, pos: number): LinkRange[] {
	const line = doc.lineAt(pos);
	const found: LinkRange[] = [];
	LINK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = LINK_RE.exec(line.text))) {
		found.push(toLinkRange(match, line.from));
	}
	return found;
}

/** The single document position that may hold the cursor at a given spot on
 * screen.
 *
 * Hidden syntax takes up no width, so several positions paint at the same
 * pixel: the two sides of "[" (from / titleFrom) are one spot, and so is
 * everything from titleTo to the end of the link (the "](url)" run). If the
 * cursor can rest on more than one of them, an arrow press moves it in the
 * document but not on screen, and Backspace eats a character nobody can see.
 *
 * So each spot keeps exactly one legal position, and it's the one *outside*
 * the link. That's what makes typing next to a link behave like ordinary
 * text — which matters most right after writing one, since the cursor is
 * sitting at `to` the moment ")" completes it. The trade-off is that the
 * title's own edges belong to the surrounding text: text typed there lands
 * outside the link, so a title can't be extended by typing at its end (edit
 * it from the inside, or through the popup). */
function canonicalPos(doc: Text, pos: number): number {
	for (const l of linksOnLine(doc, pos)) {
		if (pos === l.titleFrom) return l.from;
		if (pos >= l.titleTo && pos < l.to) return l.to;
	}
	return pos;
}

/** Holds every cursor on a canonical position, whatever put it there —
 * mouse clicks, vertical arrows, Home/End, undo, other plugins. The key
 * handlers below only ever aim at canonical positions, so this never fights
 * them. Non-empty ranges are left alone: a selection covering hidden syntax
 * is unambiguous about what it'll delete, and trimming its ends would fight
 * shift-selection. */
const canonicalCursor = EditorState.transactionFilter.of((tr) => {
	const sel = tr.newSelection;
	let moved = false;
	const ranges = sel.ranges.map((r) => {
		if (!r.empty) return r;
		const pos = canonicalPos(tr.newDoc, r.head);
		if (pos === r.head) return r;
		moved = true;
		return EditorSelection.cursor(pos, r.assoc, undefined, r.goalColumn);
	});
	if (!moved) return tr;
	// "sequential" so these positions are read against the transaction's own
	// document rather than being mapped through its changes a second time.
	return [
		tr,
		{
			selection: EditorSelection.create(ranges, sel.mainIndex),
			sequential: true,
		},
	];
});

function buildDecorations(view: EditorView): {
	decorations: DecorationSet;
	atomic: DecorationSet;
	links: LinkRange[];
} {
	const deco = new RangeSetBuilder<Decoration>();
	const atomic = new RangeSetBuilder<Decoration>();
	const links: LinkRange[] = [];

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		LINK_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = LINK_RE.exec(text))) {
			const l = toLinkRange(match, from);

			// The syntax is hidden unconditionally — it never reappears
			// under the cursor. Everything that keeps that honest (arrows
			// that skip it, deletes that can't touch it) lives in
			// canonicalPos and the keymap below.
			deco.add(l.from, l.titleFrom, Decoration.replace({}));
			atomic.add(l.from, l.titleFrom, Decoration.replace({}));

			// The title stays real, editable text — just styled.
			deco.add(
				l.titleFrom,
				l.titleTo,
				Decoration.mark({
					class: TITLE_CLASS,
					attributes: {
						"data-lhr-from": String(l.from),
						"data-lhr-to": String(l.to),
						"data-lhr-title": l.title,
						"data-lhr-url": l.url,
					},
				})
			);

			// "](url)" as one range, not a bracket plus a url: atomic-range
			// correction only pushes the cursor out of positions strictly
			// *inside* a range, so splitting it would leave the seam between
			// the two halves as a reachable, invisible resting spot.
			deco.add(l.titleTo, l.to, Decoration.replace({}));
			atomic.add(l.titleTo, l.to, Decoration.replace({}));

			links.push(l);
		}
	}

	return { decorations: deco.finish(), atomic: atomic.finish(), links };
}

/** One arrow press, one visible move.
 *
 * At a link's edges the default single-character step lands on hidden
 * syntax: same pixel, so the press looks dead, and canonicalPos would just
 * bounce it back where it came from. Atomic ranges handle this on their own
 * for the long "](url)" run — but only because the correction needs a
 * position strictly inside a range, and the 1-char "[" has no inside. So
 * both edges get an explicit target instead: the far side of the nearest
 * character that's actually on screen. */
function arrowSkip(view: EditorView, forward: boolean): boolean {
	const { head, empty } = view.state.selection.main;
	if (!empty) return false;

	for (const l of linksOnLine(view.state.doc, head)) {
		// Leaving "from" rightwards, or "to" leftwards, means crossing
		// hidden syntax plus exactly one title character.
		const target =
			forward && head === l.from
				? l.titleFrom + 1
				: !forward && head === l.to
					? l.titleTo - 1
					: null;
		if (target === null) continue;

		view.dispatch({
			selection: { anchor: canonicalPos(view.state.doc, target) },
			scrollIntoView: true,
			userEvent: "select",
		});
		return true;
	}
	return false;
}

/** Backspace/Delete at a link edge must never eat the invisible markdown
 * syntax — that breaks the link with nothing on screen to show for it, and
 * retyping the character doesn't put it back. The cursor there sits at the
 * same pixel as the title's first or last character, so that's what gets
 * deleted: exactly what it looks like from the outside. */
function deleteSkip(view: EditorView, forward: boolean): boolean {
	const { head, empty } = view.state.selection.main;
	if (!empty) return false;

	for (const l of linksOnLine(view.state.doc, head)) {
		const atEnd = !forward && head === l.to;
		const atStart = forward && head === l.from;
		if (!atEnd && !atStart) continue;

		// Down to the last visible character: removing it would leave
		// "[](url)", which no longer matches as a link and so springs back
		// into view as raw syntax. Take the whole link instead — on screen
		// that's the same thing, the last of its text going away.
		if (l.title.length === 1) {
			view.dispatch({
				changes: { from: l.from, to: l.to },
				selection: { anchor: l.from },
				userEvent: forward ? "delete.forward" : "delete.backward",
			});
			return true;
		}

		const at = atEnd ? l.titleTo - 1 : l.titleFrom;
		view.dispatch({
			changes: { from: at, to: at + 1 },
			// Stay on the edge it was on — the link just got one character
			// shorter, so keeping backspace held down keeps eating the title.
			selection: { anchor: atEnd ? l.to - 1 : l.from },
			userEvent: forward ? "delete.forward" : "delete.backward",
		});
		return true;
	}
	return false;
}

const linkBoundaryKeymap: readonly KeyBinding[] = [
	{ key: "ArrowLeft", run: (view) => arrowSkip(view, false) },
	{ key: "ArrowRight", run: (view) => arrowSkip(view, true) },
	{ key: "Backspace", run: (view) => deleteSkip(view, false) },
	{ key: "Delete", run: (view) => deleteSkip(view, true) },
];

/** Floating popup shown on hover: truncated URL + copy/open/edit actions. */
class LinkPopup {
	private el: HTMLElement;
	private urlEl: HTMLElement;
	private actionsEl: HTMLElement;
	private hideTimer: number | null = null;
	private current: LinkData | null = null;
	private isEditing = false;

	constructor(private view: EditorView) {
		this.el = createDiv({ cls: "link-hover-reveal-popup" });
		this.urlEl = this.el.createDiv({ cls: "link-hover-reveal-popup-url" });
		this.actionsEl = this.el.createDiv({
			cls: "link-hover-reveal-popup-actions",
		});
		document.body.appendChild(this.el);

		this.buildActions();

		this.el.addEventListener("mouseenter", () => this.cancelHide());
		this.el.addEventListener("mouseleave", () => this.scheduleHide());
	}

	private buildActions() {
		this.actionsEl.empty();

		const copyBtn = this.actionsEl.createEl("button", {
			cls: "clickable-icon",
		});
		setIcon(copyBtn, "copy");
		copyBtn.setAttribute("aria-label", "Copy link");
		copyBtn.addEventListener("click", () => {
			if (!this.current) return;
			// The URL only ever leaves the plugin on an explicit click here.
			void navigator.clipboard
				.writeText(this.current.url)
				.then(() => new Notice("Link copied"));
		});

		const openBtn = this.actionsEl.createEl("button", {
			cls: "clickable-icon",
		});
		setIcon(openBtn, "external-link");
		openBtn.setAttribute("aria-label", "Open link");
		openBtn.addEventListener("click", () => {
			if (!this.current) return;
			window.open(this.current.url, "_blank");
		});

		const editBtn = this.actionsEl.createEl("button", {
			cls: "clickable-icon",
		});
		setIcon(editBtn, "pencil");
		editBtn.setAttribute("aria-label", "Edit link");
		editBtn.addEventListener("click", () => this.enterEditMode());
	}

	/** Buttons shown while editing: explicit Save / Cancel, no implicit commit. */
	private buildEditActions(input: HTMLInputElement) {
		this.actionsEl.empty();

		const saveBtn = this.actionsEl.createEl("button", {
			cls: "clickable-icon",
		});
		setIcon(saveBtn, "check");
		saveBtn.setAttribute("aria-label", "Save");
		// Prevent the button from stealing focus (and firing input's blur)
		// before its own click handler runs.
		saveBtn.addEventListener("mousedown", (evt) => evt.preventDefault());
		saveBtn.addEventListener("click", () => this.saveEdit(input.value));

		const cancelBtn = this.actionsEl.createEl("button", {
			cls: "clickable-icon",
		});
		setIcon(cancelBtn, "x");
		cancelBtn.setAttribute("aria-label", "Cancel");
		cancelBtn.addEventListener("mousedown", (evt) => evt.preventDefault());
		cancelBtn.addEventListener("click", () => this.cancelEdit());
	}

show(trigger: HTMLElement, data: LinkData) {
		this.render(trigger.getBoundingClientRect(), data);
	}

	/** Same popup, positioned from doc coords instead of a hovered element —
	 * used by the "Edit link at cursor" command, which doesn't require the
	 * mouse at all. Opens straight into edit mode, since that's the whole
	 * point of invoking it via shortcut. */
	showAt(rect: { left: number; bottom: number }, data: LinkData) {
		this.render(rect, data);
		this.enterEditMode();
	}

	private render(rect: { left: number; bottom: number }, data: LinkData) {
		// Don't let hovering a different link (or re-triggering the
		// shortcut) hijack an in-progress edit.
		if (this.isEditing) return;

		this.cancelHide();
		this.current = data;
		this.renderDisplay();

		this.el.setCssStyles({
			left: `${rect.left}px`,
			top: `${rect.bottom + 4}px`,
		});
		this.el.addClass("is-visible");
	}

	scheduleHide() {
		// While editing, only Save/Cancel/Escape close the popup — moving
		// the mouse away must not interrupt or lose the edit.
		if (this.isEditing) return;

		this.cancelHide();
		this.hideTimer = window.setTimeout(() => {
			this.el.removeClass("is-visible");
			this.current = null;
		}, 200);
	}

	cancelHide() {
		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}
	}

	destroy() {
		this.el.remove();
	}

	private renderDisplay() {
		if (!this.current) return;
		this.urlEl.empty();
		this.urlEl.removeClass("is-editing");
		this.urlEl.setText(this.current.url);
	}

	private enterEditMode() {
		if (!this.current) return;
		this.cancelHide();
		this.isEditing = true;

		const link = this.current;
		this.urlEl.empty();
		this.urlEl.addClass("is-editing");

		const input = this.urlEl.createEl("input", { type: "text" });
		input.value = link.url;
		input.addEventListener("click", (evt) => evt.stopPropagation());
		input.focus();
		input.select();

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.saveEdit(input.value);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.cancelEdit();
			}
		});
		// Focus leaving the input for any other reason (e.g. clicking into
		// the document) discards the edit instead of silently saving it.
		input.addEventListener("blur", () => {
			if (this.isEditing) this.cancelEdit();
		});

		this.buildEditActions(input);
	}

	private saveEdit(rawValue: string) {
		if (!this.current) return;
		const link = this.current;
		const newUrl = rawValue.trim();

		this.isEditing = false;
		if (newUrl && newUrl !== link.url) {
			this.view.dispatch({
				changes: {
					from: link.from,
					to: link.to,
					insert: `[${link.title}](${newUrl})`,
				},
			});
			this.current = { ...link, url: newUrl };
		}
		this.exitEditMode();
	}

	private cancelEdit() {
		this.isEditing = false;
		this.exitEditMode();
	}

	private exitEditMode() {
		this.buildActions();
		this.renderDisplay();
		// If the pointer isn't over the popup anymore, resume the normal
		// hover-driven auto-hide instead of leaving it open forever.
		if (!this.el.matches(":hover")) {
			this.scheduleHide();
		}
		// The input this popup is destroying was focused — hand keyboard
		// control back to the editor so the cursor is visible and arrow
		// keys/typing keep working instead of scrolling the page.
		this.view.focus();
	}
}

// Small delay before the popup appears, so briefly passing the mouse over a
// link while navigating doesn't pop it open — only lingering does.
const HOVER_SHOW_DELAY_MS = 150;

const linkHoverRevealViewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		atomic: DecorationSet;
		links: LinkRange[];
		popup: LinkPopup;
		private view: EditorView;
		private showTimer: number | null = null;

		private onMouseOver = (evt: MouseEvent) => {
			const target: HTMLElement | null | undefined = (
				evt.target as HTMLElement
			)?.closest?.(`.${TITLE_CLASS}`);
			if (!target || this.showTimer !== null) return;

			const from = Number(target.dataset.lhrFrom);
			const to = Number(target.dataset.lhrTo);
			const title = target.dataset.lhrTitle ?? "";
			const url = target.dataset.lhrUrl ?? "";
			if (Number.isNaN(from) || Number.isNaN(to) || !url) return;

			this.showTimer = window.setTimeout(() => {
				this.showTimer = null;
				this.popup.show(target, { from, to, title, url });
			}, HOVER_SHOW_DELAY_MS);
		};

		private onMouseOut = (evt: MouseEvent) => {
			const target = (evt.target as HTMLElement)?.closest?.(
				`.${TITLE_CLASS}`
			);
			if (!target) return;

			if (this.showTimer !== null) {
				// Left before the delay elapsed — never actually shown.
				window.clearTimeout(this.showTimer);
				this.showTimer = null;
				return;
			}
			this.popup.scheduleHide();
		};

		// Capture phase, ahead of both CM6's own handling and Obsidian's
		// click-to-open-link handling, so we can reliably own the event
		// regardless of where else it's listened to.
		private onCaptureMouseDown = (evt: MouseEvent) => {
			const target: HTMLElement | null | undefined = (
				evt.target as HTMLElement
			)?.closest?.(`.${TITLE_CLASS}`);
			if (!target) return;

			const url = target.dataset.lhrUrl;
			if ((evt.metaKey || evt.ctrlKey) && url) {
				evt.preventDefault();
				evt.stopPropagation();
				window.open(url, "_blank");
				return;
			}

			// Plain click: place the cursor ourselves, then swallow the
			// event so nothing else treats this as "open the link".
			const pos = this.view.posAtCoords({
				x: evt.clientX,
				y: evt.clientY,
			});
			if (pos != null) {
				this.view.dispatch({ selection: { anchor: pos } });
			}
			this.view.focus();
			evt.preventDefault();
			evt.stopPropagation();
		};

		private onCaptureClick = (evt: MouseEvent) => {
			const target = (evt.target as HTMLElement)?.closest?.(
				`.${TITLE_CLASS}`
			);
			if (!target) return;
			// Already fully handled on mousedown; just make sure the
			// resulting click can't trigger anything else.
			evt.preventDefault();
			evt.stopPropagation();
		};

		/** Link (if any) whose title contains the cursor — used by the
		 * "Edit link at cursor" command. */
		findLinkAtCursor(): LinkRange | undefined {
			const head = this.view.state.selection.main.head;
			// `from`/`to`, not the title's own bounds: the cursor resting
			// against either edge of the link is painted right next to the
			// title text, so that's "at" the link from the user's side.
			return this.links.find((l) => head >= l.from && head <= l.to);
		}

		/** Opens the same popup as hover, positioned under the given link,
		 * based on cursor position instead of the mouse. Anchored to the
		 * actual cursor position — coordsAtPos right at titleFrom sits on
		 * the boundary of the hidden "[" widget and can resolve to null. */
		openPopupFor(link: LinkRange) {
			const pos = this.view.state.selection.main.head;
			const rect =
				this.view.coordsAtPos(pos) ?? this.view.coordsAtPos(link.titleFrom);
			if (!rect) return;
			this.popup.showAt(rect, {
				from: link.from,
				to: link.to,
				title: link.title,
				url: link.url,
			});
		}

		constructor(view: EditorView) {
			this.view = view;
			const built = buildDecorations(view);
			this.decorations = built.decorations;
			this.atomic = built.atomic;
			this.links = built.links;
			this.popup = new LinkPopup(view);

			view.dom.addEventListener("mouseover", this.onMouseOver);
			view.dom.addEventListener("mouseout", this.onMouseOut);
			view.dom.addEventListener("mousedown", this.onCaptureMouseDown, true);
			view.dom.addEventListener("click", this.onCaptureClick, true);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				const built = buildDecorations(update.view);
				this.decorations = built.decorations;
				this.atomic = built.atomic;
				this.links = built.links;
			}
		}

		destroy() {
			if (this.showTimer !== null) window.clearTimeout(this.showTimer);
			this.view.dom.removeEventListener("mouseover", this.onMouseOver);
			this.view.dom.removeEventListener("mouseout", this.onMouseOut);
			this.view.dom.removeEventListener(
				"mousedown",
				this.onCaptureMouseDown,
				true
			);
			this.view.dom.removeEventListener("click", this.onCaptureClick, true);
			this.popup.destroy();
		}
	},
	{
		decorations: (v) => v.decorations,
		provide: (plugin) =>
			EditorView.atomicRanges.of(
				(view) => view.plugin(plugin)?.atomic ?? Decoration.none
			),
	}
);

const MOD_HELD_CLASS = "link-hover-reveal-mod-held";

export default class LinkHoverRevealPlugin extends Plugin {
	async onload() {
		this.registerEditorExtension([
			Prec.highest(linkHoverRevealViewPlugin),
			Prec.highest(keymap.of(linkBoundaryKeymap)),
			canonicalCursor,
		]);

		// A real Obsidian command (not a CM6 keymap) so it shows up in
		// Settings → Hotkeys and users can bind it to whatever they want.
		// No default hotkey on purpose: anything we picked could collide
		// with an existing user or built-in binding.
		this.addCommand({
			id: "edit-link-at-cursor",
			name: "Edit link at cursor",
			editorCheckCallback: (checking, editor) => {
				const cmView = (editor as Editor & { cm?: EditorView }).cm;
				const instance = cmView?.plugin(linkHoverRevealViewPlugin);
				const link = instance?.findLinkAtCursor();
				if (!instance || !link) return false;

				if (!checking) instance.openPopupFor(link);
				return true;
			},
		});

		// Toggle a body-level class while Cmd/Ctrl is held so hovered link
		// titles show a pointer cursor only while the modifier is active.
		const syncModClass = (evt: KeyboardEvent | MouseEvent) => {
			document.body.classList.toggle(
				MOD_HELD_CLASS,
				evt.metaKey || evt.ctrlKey
			);
		};
		this.registerDomEvent(document, "keydown", syncModClass);
		this.registerDomEvent(document, "keyup", syncModClass);
		this.registerDomEvent(window, "blur", () =>
			document.body.classList.remove(MOD_HELD_CLASS)
		);
	}

	onunload() {
		document.body.classList.remove(MOD_HELD_CLASS);
	}
}
