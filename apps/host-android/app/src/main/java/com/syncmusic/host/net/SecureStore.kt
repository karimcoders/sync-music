package com.syncmusic.host.net

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Session credentials at rest are encrypted; nothing is hard-coded in the app. */
class SecureStore(context: Context) {
    private val prefs = runCatching {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "sync_music_secure", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse { context.getSharedPreferences("sync_music_fallback", Context.MODE_PRIVATE) }

    var sessionId: String?
        get() = prefs.getString("sessionId", null)
        set(v) = prefs.edit().putString("sessionId", v).apply()

    var hostToken: String?
        get() = prefs.getString("hostToken", null)
        set(v) = prefs.edit().putString("hostToken", v).apply()

    fun clear() = prefs.edit().clear().apply()
}
