/// <reference lib="dom" />

/** Apple platforms use ⌘ where other platforms use Ctrl for application shortcuts. */
export function isApplePlatform(): boolean {
  // SAFETY: userAgentData is absent on Safari and Firefox, which fall through to the user agent.
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData;
  if (userAgentData?.platform) return /mac|ios/i.test(userAgentData.platform);
  // macOS user agents always say "Mac"; iOS names the device. iPadOS masquerades as Mac,
  // which is fine here: its hardware keyboards use ⌘ too.
  return /Mac|iPhone|iPod/.test(navigator.userAgent);
}

/** Canonical bindings write the system prefix ⌘ as "Meta"; other platforms reach the same commands via Ctrl. */
export function shortcutPrefixBinding(binding: string, applePlatform: boolean): string {
  return applePlatform ? binding : binding.split("+").map((part) => part === "Meta" ? "Control" : part).join("+");
}
