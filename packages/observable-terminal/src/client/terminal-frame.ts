/// <reference lib="dom" />

import { layoutAfterEvent, softwareKeyboardArranged } from "@agents-in-the-cloud/shared";

/**
 * A changed size is applied only once it has held this long, so a rotation
 * resizes the PTY once (iOS hides the status bar a few hundred ms after rotating).
 */
const settleMs = 1000;

/** Rows kept visible below the cursor while typing with a soft keyboard. */
const contextRows = 3;

export interface TerminalFrameOptions {
  /** Clips the terminal; the composer and key row shrink it. */
  stage: HTMLElement;
  /** Holds the terminal at a fixed pixel size. */
  host: HTMLElement;
  /** The terminal's size for the current layout (a pane may shrink it while its composer is open). */
  measure(): { width: number; height: number };
  /** The host's size changed; the viewer fits and reports its new rows and columns. */
  resized(): void;
}

/**
 * Keeps a terminal's rows and columns fixed while the composer, the key row or
 * the soft keyboard take space: the stage clips it, and a focused terminal is
 * offset to keep its cursor above the keyboard. The PTY is resized only when
 * the space itself changes (composer toggle, rotation, window size), with the
 * keyboard down — right away for a finished layout transaction, whose geometry
 * is final in one step, and once the new size has settled otherwise.
 */
export class TerminalFrame {
  private size?: { width: number; height: number };
  private pending?: ReturnType<typeof setTimeout>;
  private readonly cursor = new MutationObserver((records) => {
    if (records.some(({ target }) => target instanceof HTMLTextAreaElement && target.classList.contains("gespenst__input"))) this.frameCursor();
  });

  constructor(private readonly options: TerminalFrameOptions) {
    this.cursor.observe(options.host, { subtree: true, attributes: true, attributeFilter: ["style"] });
    document.addEventListener(layoutAfterEvent, this.layoutChanged);
  }

  dispose(): void {
    clearTimeout(this.pending);
    this.cursor.disconnect();
    document.removeEventListener(layoutAfterEvent, this.layoutChanged);
  }

  private readonly layoutChanged = (): void => {
    this.frameCursor();
    // A finished transaction commits final geometry in one step (composer open
    // or closed, keyboard shown or gone), so resize right away and within the
    // same rendered frame as everything else the transaction moved. The observer
    // path below stays for untransactional changes like rotation and resizing.
    if (!softwareKeyboardArranged()) this.applyMeasured();
  };

  /** Re-measure after the space around the terminal may have changed. */
  update(): void {
    // The keyboard is out of the way only temporarily; rows and columns wait for it to go.
    if (softwareKeyboardArranged()) return;
    const size = this.measured();
    if (!size) return;
    clearTimeout(this.pending);
    this.pending = undefined;
    if (this.size && this.size.width === size.width && this.size.height === size.height) return;
    if (!this.size) {
      this.apply(size);
      return;
    }
    // Never touches a scheduled fast apply: an observer callback that happens to
    // run before it must not demote the transaction's resize into the settle window.
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (!softwareKeyboardArranged()) this.apply(size);
    }, settleMs);
  }

  /** Apply the geometry a finished transaction just committed, if it differs. */
  private applyMeasured(): void {
    const size = this.measured();
    if (!size) return;
    clearTimeout(this.pending); // exact geometry supersedes a pending settled apply
    this.pending = undefined;
    if (this.size && this.size.width === size.width && this.size.height === size.height) return;
    this.apply(size);
  }

  private measured(): { width: number; height: number } | undefined {
    const { width, height } = this.options.measure();
    if (width <= 0 || height <= 0) return;
    return { width: Math.floor(width), height: Math.floor(height) };
  }

  private apply(size: { width: number; height: number }): void {
    this.size = size;
    this.options.host.style.width = `${size.width}px`;
    this.options.host.style.height = `${size.height}px`;
    this.frameCursor();
    this.options.resized();
  }

  /** While typing with a soft keyboard, offset the terminal so its cursor, plus a few rows of context, sits above the keyboard and key row. */
  frameCursor(): void {
    const { host, stage } = this.options;
    const input = host.querySelector<HTMLTextAreaElement>(".gespenst__input");
    if (!input || document.activeElement !== input || !softwareKeyboardArranged() || !this.size) {
      host.style.removeProperty("top");
      host.style.removeProperty("bottom");
      return;
    }
    const visible = stage.clientHeight;
    const lineHeight = Number.parseFloat(input.style.lineHeight);
    const cursorBottom = Number.parseFloat(input.style.top) + lineHeight;
    // Keep a few rows below the cursor in view for context (a TUI's footer, the next lines).
    const top = Math.max(visible - this.size.height, Math.min(0, Math.round(visible - cursorBottom - contextRows * lineHeight)));
    host.style.top = `${top}px`;
    host.style.bottom = "auto";
  }
}
