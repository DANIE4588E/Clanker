/**
 * Plugin sign-ins return to the app on links like clanker://oauth/<provider>?code=… or Google's
 * com.googleusercontent.apps.<id>:/oauth2redirect?code=…. The sign-in that opened the browser takes
 * the code from them; they aren't pages, so they mustn't navigate. Everything else (a bridge's
 * pairing link, say) passes through unchanged.
 *
 * Runs outside the app's context, so it stays self-contained.
 */
const OAUTH_REDIRECT = /^[a-z][\w.+-]*:\/\/oauth\/|^com\.googleusercontent\.apps\.[^:]+:\/oauth2redirect/i;

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    if (!OAUTH_REDIRECT.test(path)) return path;
    // A sign-in redirect that started the app (the app was closed while the browser was up) has
    // nothing waiting for it: open the app normally. While the app runs, stay where it is.
    return initial ? '/' : null;
  } catch {
    return initial ? '/' : null;
  }
}
