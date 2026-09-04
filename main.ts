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
import { Prec, RangeSetBuilder } from "@codemirror/state";

// Matches markdown links, e.g. [My bookmark title](https://example.com)
// Negative lookbehind excludes image embeds: ![alt](url)
const LINK_RE = /(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

const TITLE_CLASS = "link-hover-reveal-title";
const BRACKET_CLASS = "link-hover-reveal-bracket";

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
			const [raw, title, url] = match;
			const start = from + match.index;
			const end = start + raw.length;
			const titleStart = start + 1; // right after "["
			const titleEnd = titleStart + title.length; // right before "]"
			const bracketEnd = titleEnd + 1; // right after "]"

			// Keep the "[" and "]" hidden and atomic by default — but the
			// moment the cursor is anywhere in or touching the title,
			// reveal both as plain text instead (the "(url)" part stays
			// hidden always; only the brackets mirror each other). This is
			// the same "hidden until the cursor arrives" pattern Obsidian's
			// own live preview uses for [[wikilinks]]: it removes all the
			// ambiguity around navigating or deleting a character that
			// isn't actually rendered, because while you're near it, it
			// *is* rendered.
			//
			// The range is `start`..`end` — the whole link, brackets and
			// hidden url included, not just up to the title itself — so
			// both brackets are already visible the moment the cursor
			// lands right next to the link from either outside edge,
			// before it actually crosses over. `end` (not `bracketEnd`)
			// matters here: it's what makes resting right after the whole
			// link — on the far side of the always-hidden "(url)" — count
			// too, mirroring resting right before it on the near side.
			const cursorInTitle = view.state.selection.ranges.some(
				(r) => r.to >= start && r.from <= end
			);
			if (cursorInTitle) {
				deco.add(start, titleStart, Decoration.mark({ class: BRACKET_CLASS }));
			} else {
				deco.add(start, titleStart, Decoration.replace({}));
				atomic.add(start, titleStart, Decoration.replace({}));
			}

			// The title stays real, editable text — just styled.
			deco.add(
				titleStart,
				titleEnd,
				Decoration.mark({
					class: TITLE_CLASS,
					attributes: {
						"data-lhr-from": String(start),
						"data-lhr-to": String(end),
						"data-lhr-title": title,
						"data-lhr-url": url,
					},
				})
			);

			if (cursorInTitle) {
				deco.add(titleEnd, bracketEnd, Decoration.mark({ class: BRACKET_CLASS }));
			} else {
				deco.add(titleEnd, bracketEnd, Decoration.replace({}));
				atomic.add(titleEnd, bracketEnd, Decoration.replace({}));
			}

			// Hide "(url)" — always, regardless of cursor position. The
			// cursor hops over it, never lands inside.
			deco.add(bracketEnd, end, Decoration.replace({}));
			atomic.add(bracketEnd, end, Decoration.replace({}));

			links.push({
				from: start,
				to: end,
				titleFrom: titleStart,
				titleTo: titleEnd,
				title,
				url,
			});
		}
	}

	return { decorations: deco.finish(), atomic: atomic.finish(), links };
}

/** The trailing "(url)" run is many characters wide, so by default,
 * crossing it with a single arrow press can land the cursor stuck inside
 * (atomic-range correction bounces it around instead of clearing the whole
 * run). This jumps straight from one side to the other in one motion.
 *
 * Note the boundary is `titleTo + 1` (right after "]"), not `titleTo` —
 * the "]" itself mirrors the "[" and is revealed/real whenever the cursor
 * is anywhere in the title (see buildDecorations), so it's already a
 * normal, single-step crossing; only "(url)" past it stays always hidden.
 *
 * The leading "[" doesn't need any of this — it's exactly 1 hidden
 * character, so a plain arrow press already crosses it in one
 * deterministic step, same as this function would produce anyway. The one
 * thing that step can't avoid is *looking* like nothing happened, since
 * the "[" renders as zero width either way — but "fixing" that would mean
 * also swallowing whatever real character sits next to it (e.g. a space),
 * which is worse than the harmless dead-looking press it'd be trying to
 * avoid. */
function arrowSkip(view: EditorView, forward: boolean): boolean {
	const links = view.plugin(linkHoverRevealViewPlugin)?.links;
	if (!links) return false;
	const { head, empty } = view.state.selection.main;
	if (!empty) return false;

	for (const l of links) {
		const bracketEnd = l.titleTo + 1;
		if (forward && head === bracketEnd) {
			view.dispatch({ selection: { anchor: l.to } });
			return true;
		}
		if (!forward && head === l.to) {
			view.dispatch({ selection: { anchor: bracketEnd } });
			return true;
		}
	}
	return false;
}

/** Backspace/Delete at a hidden boundary must never eat the invisible
 * markdown syntax (that silently corrupts the link) — it should act on the
 * nearest visible title character instead, same as it would look to the
 * user if the syntax weren't there at all.
 *
 * Same `titleTo + 1` note as arrowSkip above: the "]" itself is real
 * whenever the cursor is in the title, so deleting it there is a normal,
 * correct delete — only the always-hidden "(url)" past it needs guarding. */
function deleteSkip(view: EditorView, forward: boolean): boolean {
	const links = view.plugin(linkHoverRevealViewPlugin)?.links;
	if (!links) return false;
	const { head, empty } = view.state.selection.main;
	if (!empty) return false;

	// Note: nothing to do here for the leading "[" — it's only ever hidden
	// while the cursor is nowhere near it (see buildDecorations' reveal
	// logic), so Backspace/Delete can never land on it silently. Once
	// revealed it's plain text and default deletion is exactly right.
	for (const l of links) {
		const bracketEnd = l.titleTo + 1;
		if (!forward && head > bracketEnd && head <= l.to) {
			// Cursor is inside/after the hidden "(url)" — delete the last
			// visible title character instead of the real "(" underneath.
			view.dispatch({
				changes: { from: l.titleTo - 1, to: l.titleTo },
				selection: { anchor: l.titleTo - 1 },
			});
			return true;
		}
		if (forward && head >= bracketEnd && head < l.to) {
			// Cursor is inside the hidden "(url)" — nothing visible to
			// delete, just land back at a real boundary instead of eating it.
			view.dispatch({ selection: { anchor: l.to } });
			return true;
		}
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
		this.el.style.display = "none";
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
		copyBtn.addEventListener("click", async () => {
			if (!this.current) return;
			await navigator.clipboard.writeText(this.current.url);
			new Notice("Link copied");
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

		this.el.style.left = `${rect.left}px`;
		this.el.style.top = `${rect.bottom + 4}px`;
		this.el.style.display = "flex";
	}

	scheduleHide() {
		// While editing, only Save/Cancel/Escape close the popup — moving
		// the mouse away must not interrupt or lose the edit.
		if (this.isEditing) return;

		this.cancelHide();
		this.hideTimer = window.setTimeout(() => {
			this.el.style.display = "none";
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
			const target = (evt.target as HTMLElement)?.closest?.(
				`.${TITLE_CLASS}`
			) as HTMLElement | null;
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
			const target = (evt.target as HTMLElement)?.closest?.(
				`.${TITLE_CLASS}`
			) as HTMLElement | null;
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
			return this.links.find(
				(l) => head >= l.titleFrom && head <= l.titleTo
			);
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
			// selectionSet is included so the "[" reveal-near-cursor
			// decoration (see buildDecorations) tracks the cursor moving
			// in and out of a title, not just doc/viewport changes.
			if (
				update.docChanged ||
				update.viewportChanged ||
				update.selectionSet
			) {
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
		]);

		// A real Obsidian command (not a CM6 keymap) so it shows up in
		// Settings → Hotkeys and users can freely rebind it. CM6 keymaps
		// can't reliably win against Obsidian's own built-in hotkeys
		// (e.g. the default Mod-K is already "insert link"), so this uses
		// a separate default combo instead of fighting over that one.
		this.addCommand({
			id: "edit-link-at-cursor",
			name: "Edit link at cursor",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "k" }],
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
