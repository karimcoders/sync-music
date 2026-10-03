package com.syncmusic.host.net

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.*
import kotlin.math.min
import kotlin.math.pow

enum class SocketStatus { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

/**
 * Host control socket.
 *  - automatic exponential-backoff reconnect (never requires an app restart)
 *  - continuous NTP-style clock sync
 *  - all control frames are tiny; the server fans them out to N speakers
 */
class HostSocket(
    private val api: SyncApi,
    private val wsUrl: String,
    private val scope: CoroutineScope,
) {
    val clock = ClockSync()

    private val _status = MutableStateFlow(SocketStatus.DISCONNECTED)
    val status = _status.asStateFlow()

    private val _frames = MutableSharedFlow<ServerFrame>(extraBufferCapacity = 64)
    val frames = _frames.asSharedFlow()

    private var ws: WebSocket? = null
    private var attempt = 0
    private var closedByUs = false
    private var clockJob: Job? = null
    private var sessionId: String? = null
    private var hostToken: String? = null

    fun connect(sessionId: String, hostToken: String) {
        this.sessionId = sessionId
        this.hostToken = hostToken
        closedByUs = false
        _status.value = if (attempt == 0) SocketStatus.CONNECTING else SocketStatus.RECONNECTING

        val req = Request.Builder().url(wsUrl).build()
        ws = api.client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                _status.value = SocketStatus.CONNECTED
                send(ClientMessage.HostJoin(sessionId, hostToken))
                startClockSync()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = runCatching { json.decodeFromString(ServerFrame.serializer(), text) }.getOrNull() ?: return
                if (frame.type == "CLOCK_SYNC_REPLY") {
                    val t4 = System.currentTimeMillis()
                    clock.addSample(frame.clientTime ?: t4, frame.serverReceiveTime ?: t4, frame.serverSendTime ?: t4, t4)
                }
                scope.launch { _frames.emit(frame) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = scheduleReconnect()
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = scheduleReconnect()
        })
    }

    private fun scheduleReconnect() {
        clockJob?.cancel()
        if (closedByUs) { _status.value = SocketStatus.DISCONNECTED; return }
        _status.value = SocketStatus.RECONNECTING
        attempt++
        val delayMs = min(15_000.0, 500.0 * 2.0.pow(min(attempt, 5))).toLong()
        scope.launch {
            delay(delayMs)
            val sid = sessionId; val tok = hostToken
            if (!closedByUs && sid != null && tok != null) connect(sid, tok)
        }
    }

    private fun startClockSync() {
        clockJob?.cancel()
        clockJob = scope.launch {
            repeat(5) { send(ClientMessage.ClockSyncMsg(System.currentTimeMillis())); delay(120) }
            while (isActive) { delay(15_000); send(ClientMessage.ClockSyncMsg(System.currentTimeMillis())) }
        }
    }

    fun send(msg: ClientMessage) {
        val payload = json.encodeToString(ClientMessage.serializer(), msg)
        ws?.send(payload)
    }

    fun close() {
        closedByUs = true
        clockJob?.cancel()
        ws?.close(1000, "bye")
        ws = null
        _status.value = SocketStatus.DISCONNECTED
    }
}
