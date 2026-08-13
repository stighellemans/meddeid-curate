export function isAppleDevice(navigatorLike = globalThis.navigator) {
  const platform = navigatorLike?.userAgentData?.platform ?? navigatorLike?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function shortcutModifier(navigatorLike = globalThis.navigator) {
  return isAppleDevice(navigatorLike) ? '⌘' : 'Ctrl+';
}
