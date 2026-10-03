package com.syncmusic.host

import android.app.Application
import android.content.ComponentName
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.MoreExecutors
import com.syncmusic.host.net.*
import com.syncmusic.host.playback.HostPlaybackService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

enum class HostState { IDLE, CREATING_SESSION, WAITING, PLAYING, PAUSED, STOPPED }

data class HostUi(
    val hostState: HostState = HostState.IDLE,
    val socket: SocketStatus = SocketStatus.DISCONNECTED,
    val sessionId: String? = null,
    val sessionName: String = "",
    val speakerUrl: String = "",
    /** DYNAMIC. There is no maximum; never rendered as "x / N". */
    val speakerCount: Int = 0,
    val speakers: List<SpeakerInfo> = emptyList(),
    val speakerListTruncated: Boolean = false,
    val averageDriftMs: Int = 0,
    val averageLatencyMs: Int = 0,
    val playlist: List<AudioTrack> = emptyList(),
    val trackIndex: Int = -1,
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val playing: Boolean = false,
    val volume: Float = 1f,
    val autoNext: Boolean = true,
    val uploading: Boolean = false,
    val uploadProgress: Float = 0f,
    val error: String? = null,
    val info: String? = null,
)

class HostViewModel(app: Application) : AndroidViewModel(app) {

    private val baseUrl = BuildConfig.BASE_URL.trimEnd('/')
    private val api = SyncApi(baseUrl)
    private val store = SecureStore(app)
    private var socket: HostSocket? = null
    private var controller: MediaController? = null

    private val _ui = MutableStateFlow(HostUi())
    val ui = _ui.asStateFlow()

    init {
        bindPlayer()
        // resume a session that survived an app restart
        val sid = store.sessionId; val tok = store.hostToken
        if (sid != null && tok != null) attach(sid, tok, resuming = true)
        viewModelScope.launch {
            while (true) {
                delay(500)
                val c = controller ?: continue
                if (c.isPlaying) _ui.update {
                    it.copy(position = c.currentPosition / 1000.0, duration = (c.duration.coerceAtLeast(0)) / 1000.0)
                }
            }
        }
    }

    private fun bindPlayer() {
        val token = SessionToken(getApplication(), ComponentName(getApplication(), HostPlaybackService::class.java))
        val future = MediaController.Builder(getApplication(), token).buildAsync()
        future.addListener({
            controller = future.get()
            controller?.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    _ui.update { it.copy(playing = isPlaying) }
                }
            })
        }, MoreExecutors.directExecutor())
    }

    /* ------------------------------ session ----------------------------- */

    fun createSession(name: String) = viewModelScope.launch {
        _ui.update { it.copy(hostState = HostState.CREATING_SESSION, error = null) }
        runCatching { api.createSession(name) }
            .onSuccess { res ->
                store.sessionId = res.sessionId
                store.hostToken = res.hostToken
                _ui.update { it.copy(sessionName = res.name, speakerUrl = res.speakerUrl.ifBlank { "$baseUrl/speaker" }) }
                attach(res.sessionId, res.hostToken, resuming = false)
            }
            .onFailure { e -> _ui.update { it.copy(hostState = HostState.IDLE, error = e.message ?: "Unable to create session.") } }
    }

    private fun attach(sessionId: String, token: String, resuming: Boolean) {
        val s = HostSocket(api, "${baseUrl.replace("http", "ws")}/ws", viewModelScope)
        socket = s
        _ui.update { it.copy(sessionId = sessionId, hostState = HostState.WAITING,
            speakerUrl = it.speakerUrl.ifBlank { "$baseUrl/speaker" },
            info = if (resuming) "Resuming session…" else null) }
        viewModelScope.launch { s.status.collect { st -> _ui.update { it.copy(socket = st) } } }
        viewModelScope.launch { s.frames.collect(::onFrame) }
        s.connect(sessionId, token)
    }

    private fun onFrame(f: ServerFrame) {
        when (f.type) {
            "SESSION_STATE" -> {
                val t = f.transport ?: return
                val track = t.playlist.getOrNull(t.trackIndex)
                _ui.update {
                    it.copy(
                        sessionName = f.sessionName ?: it.sessionName,
                        speakerCount = f.speakerCount ?: it.speakerCount,
                        playlist = t.playlist,
                        trackIndex = t.trackIndex,
                        volume = t.volume.toFloat(),
                        autoNext = t.autoNext,
                        duration = track?.duration ?: it.duration,
                        hostState = when (t.state) {
                            "playing" -> HostState.PLAYING
                            "paused" -> HostState.PAUSED
                            "stopped" -> HostState.STOPPED
                            else -> HostState.WAITING
                        },
                        error = null,
                    )
                }
            }
            "SPEAKERS_SNAPSHOT" -> _ui.update {
                it.copy(
                    speakerCount = f.speakerCount ?: it.speakerCount,
                    speakers = f.speakers ?: it.speakers,
                    speakerListTruncated = f.truncated ?: false,
                    averageDriftMs = (f.averageDriftMs ?: 0.0).toInt(),
                    averageLatencyMs = (f.averageLatencyMs ?: 0.0).toInt(),
                )
            }
            "SYNC_PLAY" -> { /* host plays the same asset, scheduled below */ }
            "ERROR" -> _ui.update { it.copy(error = f.message ?: "Something went wrong.") }
            "SESSION_ENDED" -> { store.clear(); _ui.update { HostUi(info = "Session ended.") } }
        }
    }

    /* ------------------------------ controls ---------------------------- */

    fun play() {
        val ui = _ui.value
        val track = ui.playlist.getOrNull(ui.trackIndex.coerceAtLeast(0)) ?: return
        socket?.send(ClientMessage.Play(track.id, null))
        scheduleLocalPlay(track)
    }

    /**
     * The Host is itself a speaker: it schedules against the SAME server clock
     * so it starts together with the phones instead of ~1.5s early.
     */
    private fun scheduleLocalPlay(track: AudioTrack) = viewModelScope.launch {
        val c = controller ?: return@launch
        val s = socket ?: return@launch
        c.setMediaItem(MediaItem.fromUri(Uri.parse(track.url)))
        c.prepare()
        val startAt = s.clock.serverNow() + 1500
        val wait = (startAt - s.clock.serverNow()).coerceAtLeast(0)
        delay(wait)
        c.play()
    }

    fun pause() { socket?.send(ClientMessage.Pause); controller?.pause() }
    fun stop() { socket?.send(ClientMessage.Stop); controller?.stop() }
    fun seek(positionSeconds: Double) {
        socket?.send(ClientMessage.Seek(positionSeconds))
        controller?.seekTo((positionSeconds * 1000).toLong())
    }
    fun next() { socket?.send(ClientMessage.Next) }
    fun previous() { socket?.send(ClientMessage.Prev) }
    fun setVolume(v: Float) {
        _ui.update { it.copy(volume = v) }
        socket?.send(ClientMessage.Volume(v.toDouble()))   // software volume on each speaker
        controller?.volume = v                              // host's own software volume
        // NOTE: each phone's PHYSICAL volume stays under the control of its own OS.
    }
    fun resyncAll() { socket?.send(ClientMessage.ResyncAll) }
    fun muteGroup(group: String, muted: Boolean) { socket?.send(ClientMessage.MuteGroup(group, muted)) }
    fun renameSpeaker(id: String, name: String?, group: String?) {
        socket?.send(ClientMessage.RenameSpeaker(id, name, group))
    }
    fun setAutoNext(enabled: Boolean) { socket?.send(ClientMessage.AutoNext(enabled)) }

    fun movePlaylistItem(from: Int, to: Int) {
        val list = _ui.value.playlist.toMutableList()
        if (from !in list.indices || to !in list.indices) return
        list.add(to, list.removeAt(from))
        pushPlaylist(list)
    }
    fun removeTrack(id: String) = pushPlaylist(_ui.value.playlist.filterNot { it.id == id })
    fun playTrackAt(index: Int) {
        val t = _ui.value.playlist.getOrNull(index) ?: return
        socket?.send(ClientMessage.Play(t.id, 0.0))
        scheduleLocalPlay(t)
    }

    private fun pushPlaylist(list: List<AudioTrack>) = viewModelScope.launch {
        val sid = _ui.value.sessionId ?: return@launch
        val tok = store.hostToken ?: return@launch
        runCatching { api.setPlaylist(sid, tok, list.map { it.id }) }
            .onSuccess { pl -> _ui.update { it.copy(playlist = pl) } }
            .onFailure { e -> _ui.update { it.copy(error = e.message) } }
    }

    /* ------------------------------- upload ----------------------------- */

    fun addSong(uri: Uri, title: String, artist: String, durationSeconds: Double) = viewModelScope.launch {
        val sid = _ui.value.sessionId ?: return@launch
        val tok = store.hostToken ?: return@launch
        _ui.update { it.copy(uploading = true, uploadProgress = 0f, error = null, info = "Uploading…") }
        runCatching {
            api.uploadAudio(getApplication<Application>().contentResolver, uri, sid, tok, title, artist, durationSeconds) { p ->
                _ui.update { it.copy(uploadProgress = p) }
            }
        }.onSuccess { track ->
            val list = _ui.value.playlist + track
            _ui.update { it.copy(uploading = false, info = "Ready") }
            pushPlaylist(list)
        }.onFailure { e ->
            _ui.update { it.copy(uploading = false, error = e.message ?: "Upload failed.") }
        }
    }

    fun endSession() = viewModelScope.launch {
        val sid = _ui.value.sessionId; val tok = store.hostToken
        if (sid != null && tok != null) runCatching { api.endSession(sid, tok) }
        socket?.close(); store.clear(); controller?.stop()
        _ui.update { HostUi() }
    }

    override fun onCleared() { socket?.close(); controller?.release(); super.onCleared() }
}
