import { expect, test } from "bun:test";
import { formatShortcutBinding } from "../src/shortcut-binding.ts";

function stubNavigator(userAgent: string, userAgentDataPlatform?: string): void {
  const navigatorLike = { userAgent, userAgentData: userAgentDataPlatform === undefined ? undefined : { platform: userAgentDataPlatform } };
  Object.defineProperty(globalThis, "navigator", { value: navigatorLike, configurable: true });
}

function onApple(): void {
  stubNavigator("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15");
}

function elsewhere(): void {
  stubNavigator("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Linux");
}

test("labels canonical bindings with ⌘⌥ glyphs on Apple platforms", () => {
  onApple();
  expect(formatShortcutBinding("Meta+Alt+Comma")).toBe("⌘⌥,");
  expect(formatShortcutBinding("Meta+Alt+Shift+Backspace")).toBe("⌘⌥⇧⌫");
});

test("labels canonical bindings as Ctrl combos elsewhere", () => {
  elsewhere();
  expect(formatShortcutBinding("Meta+Alt+Comma")).toBe("Ctrl+Alt+,");
  expect(formatShortcutBinding("Meta+Alt+Shift+Backspace")).toBe("Ctrl+Alt+Shift+Backspace");
  expect(formatShortcutBinding("Control+Alt+KeyK")).toBe("Ctrl+Alt+K");
});
