package expo.modules.clankerupdate

import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

class UnreadableApkException :
  CodedException("ERR_APK_UNREADABLE", "The download isn't a readable APK. Download the update again.", null)

class OtherAppException :
  CodedException("ERR_APK_OTHER_APP", "This download isn't an update for this app, so it won't be installed.", null)

/** SHA-256 digests of a package's signing certificates: the ones it is signed with now, and every one it proves it may use. */
private class Signers(val current: Set<String>, val lineage: Set<String>)

private fun sha256(signature: Signature) =
  MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }

@Suppress("DEPRECATION")
private fun signersOf(info: PackageInfo?): Signers? {
  if (info == null) return null
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    info.signingInfo?.let { signing ->
      val current = signing.apkContentsSigners.orEmpty().map(::sha256).toSet()
      // With several signers there is no rotation history to speak of.
      val history = if (signing.hasMultipleSigners()) emptySet() else signing.signingCertificateHistory.orEmpty().map(::sha256).toSet()
      if (current.isNotEmpty()) return Signers(current, current + history)
    }
  }
  val signatures = info.signatures.orEmpty().map(::sha256).toSet()
  return if (signatures.isEmpty()) null else Signers(signatures, signatures)
}

@Suppress("DEPRECATION")
private fun signingFlags(certificates: Boolean) =
  if (certificates && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES
  else PackageManager.GET_SIGNATURES

class ClankerUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ClankerUpdate")

    /**
     * Whether the APK at `uri` is signed by the certificate the running app is signed with (or,
     * on Android 9+, by a newer key whose rotation proof includes it), which is what Android
     * requires to install it over this app.
     */
    AsyncFunction("isSignedBySameKey") { uri: String ->
      val context = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app context is gone.", null)
      val path = if (uri.startsWith("file:")) Uri.parse(uri).path ?: uri else uri
      if (!File(path).isFile) throw UnreadableApkException()
      val pm = context.packageManager

      @Suppress("DEPRECATION")
      fun archive(certificates: Boolean) = pm.getPackageArchiveInfo(path, signingFlags(certificates))
      // Some Android 9 builds leave signingInfo out for archives; the older flag still works there.
      val apkInfo = archive(true) ?: throw UnreadableApkException()
      if (apkInfo.packageName != context.packageName) throw OtherAppException()
      val apk = signersOf(apkInfo) ?: signersOf(archive(false)) ?: throw UnreadableApkException()

      @Suppress("DEPRECATION")
      val app = signersOf(pm.getPackageInfo(context.packageName, signingFlags(true)))
        ?: signersOf(pm.getPackageInfo(context.packageName, signingFlags(false)))
        ?: return@AsyncFunction false

      apk.current == app.current ||
        // A rotated key: the update is signed by one new certificate whose lineage includes ours.
        (apk.current.size == 1 && app.current.size == 1 && app.current.first() in apk.lineage)
    }
  }
}
