import { router } from 'expo-router';
import { useEffect } from 'react';

/**
 * Where a plugin sign-in redirect lands if it reaches navigation: +native-intent normally stops
 * those links, but routes load lazily in some development setups, which skips it. The sign-in that
 * opened the browser already has the code, so this screen just closes.
 */
export function OAuthReturn() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);
  return null;
}
