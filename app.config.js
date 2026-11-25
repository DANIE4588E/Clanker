/**
 * Builds made with APP_VARIANT=preview install beside the regular app instead of over it: they get
 * their own Android package id (so their own data) and are named "Clanker Preview". The clanker://
 * scheme stays the same, so a bridge's pairing QR code still opens in either one.
 *
 * Everything else comes from app.json.
 */
module.exports = ({ config }) => {
  if (process.env.APP_VARIANT !== 'preview') return config;
  return {
    ...config,
    name: `${config.name} Preview`,
    android: { ...config.android, package: `${config.android.package}.preview` },
  };
};
