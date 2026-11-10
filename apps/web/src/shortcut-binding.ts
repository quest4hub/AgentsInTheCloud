import { isApplePlatform, shortcutPrefixBinding } from "@agents-in-the-cloud/shared";

/** Bindings name ⌘⌥ glyphs on Apple platforms; elsewhere the same keys are read as Ctrl+Alt. */
export function formatShortcutBinding(binding: string): string {
  const applePlatform = isApplePlatform();
  return shortcutPrefixBinding(binding, applePlatform).split("+")
    .map((part) => bindingPartLabel(part, applePlatform))
    .join(applePlatform ? "" : "+");
}

function bindingPartLabel(part: string, applePlatform: boolean): string {
  switch (part) {
    case "Meta": return applePlatform ? "⌘" : "Ctrl";
    case "Control": return applePlatform ? "⌃" : "Ctrl";
    case "Alt": return applePlatform ? "⌥" : "Alt";
    case "Shift": return applePlatform ? "⇧" : "Shift";
    case "Backspace": return applePlatform ? "⌫" : "Backspace";
    default: return keyLabel(part);
  }
}

function keyLabel(part: string): string {
  switch (part) {
    case "Comma": return ",";
    case "Period": return ".";
    case "Slash": return "/";
    case "Quote": return "'";
    case "Semicolon": return ";";
    case "Backslash": return "\\";
    case "BracketRight": return "]";
    default: return part.replace(/^Key/, "");
  }
}
