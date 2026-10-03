package com.syncmusic.host.net

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * REST client. Secrets (hostToken) live only in EncryptedSharedPreferences and
 * are sent as a bearer token over HTTPS — never embedded in the APK.
 */
class SyncApi(private val baseUrl: String) {

    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.MINUTES)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private suspend fun exec(req: Request): String = withContext(Dispatchers.IO) {
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) throw IOException(friendly(res.code, body))
            body
        }
    }

    private fun friendly(code: Int, body: String) = when (code) {
        401 -> "Not authorised for this session."
        404 -> "Host session ended."
        413 -> "File too large."
        415 -> "Unsupported audio type. Use MP3, AAC/M4A or WAV."
        503 -> "Server is currently at capacity. Please try again later."
        else -> "Request failed ($code). ${body.take(200)}"
    }

    suspend fun createSession(name: String): CreateSessionResponse {
        val body = """{"name":${json.encodeToString(kotlinx.serialization.builtins.serializer(), name)}}"""
            .toRequestBody("application/json".toMediaTypeOrNull())
        val res = exec(Request.Builder().url("$baseUrl/api/session/create").post(body).build())
        return json.decodeFromString(CreateSessionResponse.serializer(), res)
    }

    suspend fun endSession(sessionId: String, token: String) {
        exec(Request.Builder().url("$baseUrl/api/session/$sessionId")
            .delete().header("Authorization", "Bearer $token").build())
    }

    suspend fun listAudio(sessionId: String, token: String): List<AudioTrack> {
        val res = exec(Request.Builder().url("$baseUrl/api/audio?sessionId=$sessionId")
            .header("Authorization", "Bearer $token").build())
        return json.decodeFromString(TrackList.serializer(), res).tracks
    }

    suspend fun setPlaylist(sessionId: String, token: String, trackIds: List<String>): List<AudioTrack> {
        val payload = """{"trackIds":[${trackIds.joinToString(",") { "\"$it\"" }}]}"""
            .toRequestBody("application/json".toMediaTypeOrNull())
        val res = exec(Request.Builder().url("$baseUrl/api/session/$sessionId/playlist")
            .post(payload).header("Authorization", "Bearer $token").build())
        return json.decodeFromString(PlaylistResponse.serializer(), res).playlist
    }

    /**
     * Uploads the audio ONCE to object storage. Speakers then fetch it from
     * storage/CDN with a signed URL — the host never streams to each phone.
     */
    suspend fun uploadAudio(
        resolver: ContentResolver,
        uri: Uri,
        sessionId: String,
        token: String,
        title: String,
        artist: String,
        durationSeconds: Double,
        onProgress: (Float) -> Unit = {},
    ): AudioTrack = withContext(Dispatchers.IO) {
        val name = resolver.query(uri, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (i >= 0 && c.moveToFirst()) c.getString(i) else null
        } ?: "audio.mp3"
        val mime = resolver.getType(uri) ?: "audio/mpeg"
        val size = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L

        val fileBody = object : RequestBody() {
            override fun contentType(): MediaType? = mime.toMediaTypeOrNull()
            override fun contentLength(): Long = size
            override fun writeTo(sink: BufferedSink) {
                resolver.openInputStream(uri)!!.use { input ->
                    val src = input.source()
                    var written = 0L
                    val buf = okio.Buffer()
                    while (true) {
                        val read = src.read(buf, 64 * 1024)
                        if (read == -1L) break
                        sink.write(buf, read)
                        written += read
                        if (size > 0) onProgress(written.toFloat() / size)
                    }
                }
            }
        }

        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("title", title)
            .addFormDataPart("artist", artist)
            .addFormDataPart("duration", durationSeconds.toString())
            .addFormDataPart("file", name, fileBody)
            .build()

        val res = exec(Request.Builder()
            .url("$baseUrl/api/audio/upload?sessionId=$sessionId")
            .post(multipart)
            .header("Authorization", "Bearer $token")
            .build())
        json.decodeFromString(AudioTrack.serializer(), res)
    }
}
