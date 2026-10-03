package com.syncmusic.host

import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay

private val Bg = Color(0xFF0B0D14)
private val Card = Color(0xFF141827)
private val Line = Color(0xFF232A40)
private val Ok = Color(0xFF5EE6A8)
private val Dim = Color(0xFF8E98B5)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Ok, background = Bg, surface = Card)) {
                Surface(color = Bg) { Root() }
            }
        }
    }
}

@Composable
private fun Root(vm: HostViewModel = viewModel()) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    var splash by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) { delay(900); splash = false }

    when {
        splash -> Splash()
        ui.sessionId == null -> Home(ui, vm)
        else -> ControlPanel(ui, vm)
    }
}

@Composable
private fun Splash() = Box(Modifier.fillMaxSize(), Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text("🎵", fontSize = 56.sp)
        Text("SYNC MUSIC", color = Ok, fontWeight = FontWeight.Bold, letterSpacing = 4.sp)
    }
}

@Composable
private fun Home(ui: HostUi, vm: HostViewModel) {
    var name by remember { mutableStateOf("My Music") }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(40.dp))
        Text("SYNC MUSIC", color = Ok, fontSize = 26.sp, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)
        Text(
            "Turn any number of nearby phones into wireless speakers. " +
                "They only need to open the speaker web page in a browser — no app, no QR, no room code.",
            color = Dim,
        )
        OutlinedTextField(name, { name = it }, label = { Text("Session name") }, singleLine = true,
            modifier = Modifier.fillMaxWidth())
        Button(
            onClick = { vm.createSession(name) },
            enabled = ui.hostState != HostState.CREATING_SESSION,
            modifier = Modifier.fillMaxWidth().height(56.dp),
            shape = RoundedCornerShape(14.dp),
        ) { Text(if (ui.hostState == HostState.CREATING_SESSION) "CREATING…" else "CREATE SESSION") }
        ui.error?.let { Text(it, color = Color(0xFFFF7A7A)) }
    }
}

@Composable
private fun ControlPanel(ui: HostUi, vm: HostViewModel) {
    val ctx = LocalContextSafe()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) {
            runCatching { ctx.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            val mmr = MediaMetadataRetriever()
            var title = "Unknown title"; var artist = "Unknown artist"; var dur = 0.0
            runCatching {
                mmr.setDataSource(ctx, uri)
                title = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE) ?: title
                artist = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST) ?: artist
                dur = (mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) / 1000.0
            }
            mmr.release()
            vm.addSong(uri, title, artist, dur)
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { Spacer(Modifier.height(24.dp)) }

        item {
            Section {
                Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                    Text("SYNC MUSIC", color = Ok, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)
                    Text(
                        when (ui.socket) {
                            com.syncmusic.host.net.SocketStatus.CONNECTED -> "● LIVE"
                            com.syncmusic.host.net.SocketStatus.RECONNECTING -> "● RECONNECTING"
                            com.syncmusic.host.net.SocketStatus.CONNECTING -> "● CONNECTING"
                            else -> "● OFFLINE"
                        },
                        color = if (ui.socket == com.syncmusic.host.net.SocketStatus.CONNECTED) Ok else Color(0xFFFFC46B),
                    )
                }
                Spacer(Modifier.height(8.dp))
                Text(ui.sessionName, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                // DYNAMIC speaker count — no maximum is displayed or enforced.
                Text("Connected Speakers: ${ui.speakerCount}", color = Dim)
                Spacer(Modifier.height(10.dp))
                Text("Speaker page", color = Dim, fontSize = 12.sp)
                Text(ui.speakerUrl, color = Ok)
                Text("Share this link any way you like. Speakers just open it and tap Enable Speaker.",
                    color = Dim, fontSize = 12.sp)
            }
        }

        item {
            Section {
                val track = ui.playlist.getOrNull(ui.trackIndex)
                Text("🎵 Current Song", color = Dim, fontSize = 12.sp)
                Text(track?.title ?: "No song selected", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text(track?.artist ?: "—", color = Dim)
                Spacer(Modifier.height(10.dp))
                val dur = (track?.duration ?: 0.0).coerceAtLeast(0.01)
                Slider(
                    value = (ui.position / dur).toFloat().coerceIn(0f, 1f),
                    onValueChange = { vm.seek(it * dur) },
                )
                Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                    Text(fmt(ui.position), color = Dim); Text(fmt(track?.duration ?: 0.0), color = Dim)
                }
                Spacer(Modifier.height(6.dp))
                Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(10.dp)) {
                    OutlinedButton({ vm.previous() }, Modifier.weight(1f)) { Text("Prev") }
                    Button(
                        { if (ui.hostState == HostState.PLAYING) vm.pause() else vm.play() },
                        Modifier.weight(1.4f),
                    ) { Text(if (ui.hostState == HostState.PLAYING) "PAUSE" else "PLAY") }
                    OutlinedButton({ vm.next() }, Modifier.weight(1f)) { Text("Next") }
                }
                Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(10.dp)) {
                    OutlinedButton({ vm.stop() }, Modifier.weight(1f)) { Text("Stop") }
                    OutlinedButton({ vm.resyncAll() }, Modifier.weight(1f)) { Text("Resync All") }
                }
                Spacer(Modifier.height(6.dp))
                Text("Master volume (software volume on every speaker)", color = Dim, fontSize = 12.sp)
                Slider(ui.volume, { vm.setVolume(it) })
                Text("Each phone's hardware volume stays controlled by its own Android OS.",
                    color = Dim, fontSize = 11.sp)
            }
        }

        item {
            Section {
                Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                    Text("PLAYLIST", color = Dim, letterSpacing = 2.sp)
                    TextButton({ picker.launch(arrayOf("audio/mpeg", "audio/mp4", "audio/aac", "audio/x-m4a", "audio/wav")) }) {
                        Text("+ ADD SONG")
                    }
                }
                if (ui.uploading) LinearProgressIndicator(progress = { ui.uploadProgress }, modifier = Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                    Text("Auto next", color = Dim)
                    Switch(ui.autoNext, { vm.setAutoNext(it) })
                }
            }
        }

        itemsIndexed(ui.playlist, key = { _, t -> t.id }) { i, t ->
            Section {
                Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${"%02d".format(i + 1)}. ${t.title}",
                            color = if (i == ui.trackIndex) Ok else Color.White)
                        Text(t.artist, color = Dim, fontSize = 12.sp)
                    }
                    TextButton({ vm.playTrackAt(i) }) { Text("Play") }
                    TextButton({ vm.movePlaylistItem(i, i - 1) }) { Text("↑") }
                    TextButton({ vm.movePlaylistItem(i, i + 1) }) { Text("↓") }
                    TextButton({ vm.removeTrack(t.id) }) { Text("✕") }
                }
            }
        }

        item {
            Section {
                Text("CONNECTED SPEAKERS", color = Dim, letterSpacing = 2.sp)
                Text("Connected Speakers: ${ui.speakerCount}", color = Color.White, fontWeight = FontWeight.Bold)
                Text("Average sync drift: ${ui.averageDriftMs}ms · average latency: ${ui.averageLatencyMs}ms",
                    color = Dim, fontSize = 12.sp)
                Text("Measured, not guaranteed — wireless playback is never perfectly identical.",
                    color = Dim, fontSize = 11.sp)
            }
        }

        // Large lists stay cheap: LazyColumn only composes what is on screen.
        items(ui.speakers, key = { it.id }) { sp ->
            Section {
                Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(sp.name, color = Color.White)
                        Text("${sp.group} · ${sp.status}", color = Dim, fontSize = 12.sp)
                    }
                    Text("${sp.latencyMs.toInt()}ms", color = Dim)
                    Spacer(Modifier.width(10.dp))
                    Text("${sp.driftMs.toInt()}ms", color = if (kotlin.math.abs(sp.driftMs) < 50) Ok else Color(0xFFFFC46B))
                }
            }
        }

        if (ui.speakerListTruncated) item {
            Text("Showing the first page of speakers — count above is the full session total.",
                color = Dim, fontSize = 12.sp)
        }

        item {
            Section {
                Text("GROUPS", color = Dim, letterSpacing = 2.sp)
                Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
                    listOf("ALL", "A", "B", "C").forEach { g ->
                        OutlinedButton({ vm.muteGroup(if (g == "ALL") "ALL" else "GROUP $g", true) }, Modifier.weight(1f)) {
                            Text("Mute $g", fontSize = 12.sp)
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(8.dp)) {
                    listOf("ALL", "A", "B", "C").forEach { g ->
                        OutlinedButton({ vm.muteGroup(if (g == "ALL") "ALL" else "GROUP $g", false) }, Modifier.weight(1f)) {
                            Text("Unmute $g", fontSize = 12.sp)
                        }
                    }
                }
            }
        }

        item {
            ui.error?.let { Text(it, color = Color(0xFFFF7A7A)) }
            ui.info?.let { Text(it, color = Color(0xFFFFC46B)) }
            OutlinedButton({ vm.endSession() }, Modifier.fillMaxWidth()) { Text("END SESSION") }
            Spacer(Modifier.height(30.dp))
        }
    }
}

@Composable
private fun Section(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(Card, RoundedCornerShape(16.dp)).padding(16.dp),
        content = content,
    )
}

@Composable
private fun LocalContextSafe() = androidx.compose.ui.platform.LocalContext.current

private fun fmt(s: Double): String {
    val t = if (s.isFinite() && s > 0) s.toInt() else 0
    return "%02d:%02d".format(t / 60, t % 60)
}
