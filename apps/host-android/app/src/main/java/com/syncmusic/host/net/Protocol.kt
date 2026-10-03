package com.syncmusic.host.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Kotlin mirror of packages/protocol (TypeScript).
 * Keep both in sync — PROTOCOL_VERSION guards accidental drift.
 */
const val PROTOCOL_VERSION = 3

val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

/* ----------------------------- REST models ----------------------------- */

@Serializable
data class CreateSessionResponse(
    val sessionId: String,
    val hostId: String,
    val name: String,
    val status: String,
    val hostToken: String,
    val speakerUrl: String,
    val wsUrl: String,
)

@Serializable
data class AudioTrack(
    val id: String,
    val title: String,
    val artist: String = "Unknown artist",
    val filename: String = "",
    val mimeType: String = "",
    val size: Long = 0,
    val duration: Double = 0.0,
    val url: String = "",
    val createdAt: Long = 0,
)

@Serializable data class TrackList(val tracks: List<AudioTrack> = emptyList())
@Serializable data class PlaylistResponse(val playlist: List<AudioTrack> = emptyList())

/* -------------------------- WebSocket messages ------------------------- */

@Serializable
data class TransportState(
    val state: String = "idle",
    val trackId: String? = null,
    val position: Double = 0.0,
    val positionAtServerTime: Long = 0,
    val volume: Double = 1.0,
    val playlist: List<AudioTrack> = emptyList(),
    val trackIndex: Int = -1,
    val autoNext: Boolean = true,
)

@Serializable
data class SpeakerInfo(
    val id: String,
    val name: String,
    val group: String = "ALL",
    val status: String = "connected",
    val muted: Boolean = false,
    val latencyMs: Double = 0.0,
    val driftMs: Double = 0.0,
    val state: String = "idle",
    val bufferedSeconds: Double = 0.0,
    val joinedAt: Long = 0,
    val lastSeen: Long = 0,
)

/** Inbound frames are parsed loosely by "type" (see HostSocket). */
@Serializable
data class ServerFrame(
    val type: String,
    val serverTime: Long? = null,
    val protocolVersion: Int? = null,
    val sessionId: String? = null,
    val sessionName: String? = null,
    val hostOnline: Boolean? = null,
    val speakerCount: Int? = null,
    val transport: TransportState? = null,
    val speakers: List<SpeakerInfo>? = null,
    val averageDriftMs: Double? = null,
    val averageLatencyMs: Double? = null,
    val truncated: Boolean? = null,
    val clientTime: Long? = null,
    val serverReceiveTime: Long? = null,
    val serverSendTime: Long? = null,
    val code: String? = null,
    val message: String? = null,
)

@Serializable
sealed class ClientMessage {
    @Serializable @SerialName("HOST_JOIN")
    data class HostJoin(val sessionId: String, val hostToken: String) : ClientMessage()

    @Serializable @SerialName("CLOCK_SYNC")
    data class ClockSyncMsg(val clientTime: Long) : ClientMessage()

    @Serializable @SerialName("HOST_PLAY")
    data class Play(val audioId: String? = null, val position: Double? = null) : ClientMessage()

    @Serializable @SerialName("HOST_PAUSE") data object Pause : ClientMessage()
    @Serializable @SerialName("HOST_STOP") data object Stop : ClientMessage()
    @Serializable @SerialName("HOST_NEXT") data object Next : ClientMessage()
    @Serializable @SerialName("HOST_PREV") data object Prev : ClientMessage()
    @Serializable @SerialName("HOST_RESYNC_ALL") data object ResyncAll : ClientMessage()

    @Serializable @SerialName("HOST_SEEK") data class Seek(val position: Double) : ClientMessage()
    @Serializable @SerialName("HOST_VOLUME") data class Volume(val volume: Double) : ClientMessage()
    @Serializable @SerialName("HOST_AUTO_NEXT") data class AutoNext(val enabled: Boolean) : ClientMessage()

    @Serializable @SerialName("HOST_MUTE_GROUP")
    data class MuteGroup(val group: String, val muted: Boolean) : ClientMessage()

    @Serializable @SerialName("HOST_RENAME_SPEAKER")
    data class RenameSpeaker(val speakerId: String, val name: String? = null, val group: String? = null) : ClientMessage()

    @Serializable @SerialName("HOST_SET_PLAYLIST")
    data class SetPlaylist(val trackIds: List<String>) : ClientMessage()
}
