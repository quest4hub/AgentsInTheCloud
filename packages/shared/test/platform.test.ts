import { expect, test } from "bun:test";
import { isApplePlatform, shortcutPrefixBinding } from "../src/platform.ts";

function stubNavigator(userAgent: string, userAgentDataPlatform?: string): void {
  const navigatorLike = { userAgent, userAgentData: userAgentDataPlatform === undefined ? undefined : { platform: userAgentDataPlatform } };
  Object.defineProperty(globalThis, "navigator", { value: navigatorLike, configurable: true });
}

for (const [description, ua, userAgentDataPlatform] of [
  ["macOS Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", undefined],
  ["macOS Chrome", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "macOS"],
  ["iPad with desktop site", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", undefined],
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "iOS"],
] as const) {
  test(`detects Apple platform: ${description}`, () => {
    stubNavigator(ua, userAgentDataPlatform);
    expect(isApplePlatform()).toBe(true);
  });
}

for (const [description, ua, userAgentDataPlatform] of [
  ["Linux Chrome", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Linux"],
  ["Linux Firefox", "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", undefined],
  ["Windows Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Windows"],
  ["Android Chrome", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "Android"],
] as const) {
  test(`detects non-Apple platform: ${description}`, () => {
    stubNavigator(ua, userAgentDataPlatform);
    expect(isApplePlatform()).toBe(false);
  });
}

for (const [binding, apple, expected] of [
  ["Meta+Alt+Comma", true, "Meta+Alt+Comma"],
  ["Meta+Alt+Comma", false, "Control+Alt+Comma"],
  ["Meta+Alt+Shift+Backspace", false, "Control+Alt+Shift+Backspace"],
  ["Control+Alt+KeyK", false, "Control+Alt+KeyK"],
] as const) {
  test(`resolves system prefix binding: ${binding} on ${apple ? "Apple" : "other"}`, () => {
    expect(shortcutPrefixBinding(binding, apple)).toBe(expected);
  });
}
