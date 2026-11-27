import { requireOptionalNativeModule } from 'expo';

type ClankerUpdateModule = {
  /**
   * Whether the APK at `uri` (a file:// URI or plain path) is signed by the same certificate as
   * the running app, allowing for a key rotation the APK proves (Android 9+). Rejects when the file
   * isn't a readable APK, or is a different app.
   */
  isSignedBySameKey(uri: string): Promise<boolean>;
};

/** Null on iOS and in builds made before this module was added. */
export const ClankerUpdate = requireOptionalNativeModule<ClankerUpdateModule>('ClankerUpdate');
