import { Editor, Notice, Plugin, setIcon } from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { Prec, RangeSetBuilder } from "@codemirror/state";

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

			// Hide the "[" — cursor hops over it, never lands inside.
			deco.add(start, titleStart, Decoration.replace({}));
			atomic.add(start, titleStart, Decoration.replace({}));

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

			// Hide "](url)" — cursor hops over it, never lands inside.
			deco.add(titleEnd, end, Decoration.replace({}));
			atomic.add(titleEnd, end, Decoration.replace({}));

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
		this.registerEditorExtension(Prec.highest(linkHoverRevealViewPlugin));

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
