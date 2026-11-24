import { fetch as expoFetch } from 'expo/fetch';

/**
 * expo/fetch without cookies. Its default, credentials: 'include', sends and stores cookies through
 * the app-wide Android cookie jar, and OkHttp 4.9's JavaNetCookieJar throws on some cookies it then
 * reads back: a quoted value ending in a space, like the signin_details cookie ai.google.dev sets
 * while redirecting, fails "value is not trimmed". OkHttp rethrows that on its own thread, which
 * kills the app. Nothing here authenticates with cookies, so none are kept or sent.
 */
export const fetch: typeof expoFetch = (input, init) => expoFetch(input, { credentials: 'omit', ...init });
