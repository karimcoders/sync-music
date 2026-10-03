package com.syncmusic.host.net

/**
 * NTP-style server clock estimation (mirror of packages/sync-engine).
 * The Host never trusts its own wall clock for scheduling: it always converts
 * to server time before sending or interpreting a timestamp.
 */
class ClockSync(private val window: Int = 12) {
    private data class Sample(val offset: Double, val rtt: Long)
    private val samples = ArrayDeque<Sample>()

    @Volatile var offsetMs: Double = 0.0; private set
    @Volatile var rttMs: Double = 0.0; private set
    @Volatile var synced: Boolean = false; private set

    fun addSample(t1: Long, t2: Long, t3: Long, t4: Long) {
        val rtt = ((t4 - t1) - (t3 - t2)).coerceAtLeast(0)
        val offset = ((t2 - t1) + (t3 - t4)) / 2.0
        samples.addLast(Sample(offset, rtt))
        while (samples.size > window) samples.removeFirst()
        val best = samples.sortedBy { it.rtt }.take(maxOf(1, samples.size / 3))
        offsetMs = best.sumOf { it.offset } / best.size
        rttMs = best.sumOf { it.rtt.toDouble() } / best.size
        synced = samples.size >= 3
    }

    fun serverNow(): Long = System.currentTimeMillis() + offsetMs.toLong()
    val latencyMs: Double get() = rttMs / 2.0
    fun reset() { samples.clear(); synced = false }
}
