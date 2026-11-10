import { isApplePlatform } from "@agents-in-the-cloud/shared";
import { Controller } from "@hotwired/stimulus";
import { formatShortcutBinding } from "../shortcut-binding.ts";

/** The server cannot know the viewer's keyboard, so it renders raw bindings and this controller labels them. */
export class ShortcutBindingController extends Controller<HTMLElement> {
  initialize(): void {
    // SAFETY: The server renders this value from a canonical shortcut binding.
    this.element.textContent = formatShortcutBinding(this.element.dataset.shortcutBinding!);
  }
}
