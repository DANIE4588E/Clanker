/**
 * Builds made with APP_VARIANT=preview install beside the regular app instead of over it: they get
 * their own Android package id (so their own data) and are named "Clanker Preview". The clanker://
 * scheme stays the same, so a bridge's pairing QR code still opens in either one.
 *
 * Google sign-in for plugins returns to the app on the reversed client ID scheme
 * (com.googleusercontent.apps.<id>), which has to be registered in the build, so it is added here
 * from EXPO_PUBLIC_GOOGLE_PLUGIN_CLIENT_ID (.env.local) when that is set.
 *
 * Everything else comes from app.json.
 */
const googleClientId = (process.env.EXPO_PUBLIC_GOOGLE_PLUGIN_CLIENT_ID ?? '').trim();
const googleScheme = googleClientId
  ? `com.googleusercontent.apps.${googleClientId.replace(/\.apps\.googleusercontent\.com$/, '')}`
  : null;

module.exports = ({ config }) => {
  const schemes = [config.scheme].flat().filter(Boolean);
  const withSchemes = {
    ...config,
    scheme: googleScheme && !schemes.includes(googleScheme) ? [...schemes, googleScheme] : config.scheme,
  };
  if (process.env.APP_VARIANT !== 'preview') return withSchemes;
  return {
    ...withSchemes,
    name: `${config.name} Preview`,
    android: { ...config.android, package: `${config.android.package}.preview` },
  };
};
