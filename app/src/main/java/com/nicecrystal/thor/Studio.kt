package com.nicecrystal.thor

import android.content.Context
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiManager
import android.media.midi.MidiReceiver
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.random.Random

/** Everything both screens, the buttons and the MIDI keyboard share: the sounds, the pads, the throws. */
object Studio {
    // parameter numbers, the same order as the engine
    const val POSITION = 0; const val LENGTH = 1; const val SCAN = 2; const val SIZE = 3; const val DENSITY = 4; const val PITCH = 5
    const val SPRAY = 7; const val SHATTER = 8; const val REV = 9; const val SPREAD = 10; const val ATTACK = 11; const val SUSTAIN = 12; const val MIX = 13
    const val TONE = 16; const val RESO = 17; const val DRIVE = 18; const val CRUSH = 19; const val CHORUS = 20; const val DELAY = 21; const val DTIME = 22; const val DFEED = 23; const val SPACE = 24; const val DECAY = 25
    const val PLAY = 28; const val FREEZE = 29; const val KEYLOCK = 31; const val GRID = 32; const val XPOSE = 34; const val BEND = 35

    class Sound(val name: String, val asset: String?, var file: java.io.File? = null) { val id = nextId++; var bars = 0; var peaks: String = ""; var seconds = 0f; var l: FloatArray? = null; var r: FloatArray? = null; var keyRoot = -2; var keyMinor = true }

    private var nextId = 1
    val sounds = mutableListOf(Sound("GLASS BELLS", "bells.wav"), Sound("CRYSTAL", "crystal.wav"), Sound("SNOW VOICE", "voice.wav"), Sound("DUSTY BOOM-BAP", "beat1.wav"), Sound("GLASS HOUSE", "beat2.wav"))
    val moods = listOf("DREAM", "GLITCH", "GHOST", "MACHINE", "HELL")
    // five pages of four sliders, in the order the bottom screen shows them
    val sliders = intArrayOf(PITCH, DENSITY, TONE, SPACE, LENGTH, SCAN, SPRAY, SHATTER, SPREAD, ATTACK, SUSTAIN, MIX, RESO, DRIVE, CRUSH, CHORUS, DELAY, DTIME, DFEED, DECAY)
    @Volatile var usbSeen = ""; @Volatile var midiCount = 0; @Volatile var midiLast = ""
    @Volatile var cur = 0; @Volatile var live = false; @Volatile var mood = 0; @Volatile var sel = 0; @Volatile var version = 0
    @Volatile var midiName = ""; @Volatile var micOk = false
    @Volatile var bpm = 128.0
    // ---- rooms, the room's result, the deck
    @Volatile var room = "grain"; @Volatile var result: Sound? = null; @Volatile var hearing = false; @Volatile var deckOn = false
    val deck = java.util.concurrent.CopyOnWriteArrayList<Sound>()
    @Volatile var act = ""; @Volatile var actSeq = 0; @Volatile var outRecording = false
    private val rooms = listOf("grain", "crystal", "hybrid", "vocal")
    /** Changing rooms silences everything: the instrument, the preview and the deck. */
    fun enter(r: String) {
        if (r !in rooms || r == room) return
        Native.setParam(PLAY, 0f); Native.allOff(); if (live) goLive(false)
        hear(false); if (deckOn) deckToggle()
        room = r; Native.setGrainGate(r == "grain"); version++
    }
    fun hear(on: Boolean) { hearing = on && result != null; Native.loopPlay(0, hearing) }
    private var resBuf: java.io.ByteArrayOutputStream? = null
    fun resBegin() { resBuf = java.io.ByteArrayOutputStream() }
    fun resChunk(b64: String) { try { resBuf?.write(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)) } catch (e: Exception) { android.util.Log.e("NiceCrystal", "chunk", e) } }
    /** A loop a room has just made (16-bit, left and right interleaved): it becomes the room's result and starts playing. */
    fun resEnd(name: String, bars: Int) {
        val b = resBuf?.toByteArray() ?: return; resBuf = null
        val sh = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer(); val n = sh.remaining() / 2; if (n < 256) return
        val l = FloatArray(n); val r = FloatArray(n); for (i in 0 until n) { l[i] = sh.get(2 * i) / 32768f; r[i] = sh.get(2 * i + 1) / 32768f }
        val s = Sound(name.take(28), null); s.l = l; s.r = r; s.seconds = n / 48000f; s.bars = bars; s.peaks = peaksOf(l, r, 480); s.keyRoot = -1
        result = s; Native.loopSet(0, l, r); hear(true); version++
    }
    /** KEEP: the result joins your sounds (and is saved), so any room can use it. */
    fun keepResult() { val s = result ?: return; if (sounds.contains(s)) { say("ALREADY KEPT"); return }; Thread { detectKey(s); keep(s); sounds.add(0, s); cur++; say("KEPT AS A SOUND"); version++ }.start() }
    fun toDeck() {
        val s = result ?: return; val l = s.l ?: return; val r = s.r ?: l
        if (deck.size >= 8) { say("THE DECK IS FULL"); return }
        deck.add(s); Native.loopSet(deck.size, l, r); hear(false)
        if (!deckOn) { deckOn = true; Native.deckPlay(true) } else Native.loopPlay(deck.size, true)
        version++
    }
    fun deckToggle() { if (deck.isEmpty()) { deckOn = false; return }; deckOn = !deckOn; Native.deckPlay(deckOn) }
    fun deckRemove(i: Int) {
        if (i < 0 || i >= deck.size) return; val was = deckOn; Native.deckPlay(false); deck.removeAt(i)
        for (k in 1..8) Native.loopClear(k); deck.forEachIndexed { k, s -> Native.loopSet(k + 1, s.l!!, s.r ?: s.l!!) }
        deckOn = was && deck.isNotEmpty(); if (deckOn) Native.deckPlay(true); version++
    }
    /** REC OUT: everything you hear, written as a WAV into Music/NiceCrystal333 where other apps can find it. */
    fun outRec() {
        if (!outRecording) { outRecording = Native.outRecStart(); return }
        outRecording = false
        Thread {
            try {
                val pcm = Native.outRecStop() ?: run { say("TOO SHORT TO SAVE"); return@Thread }; val c = app ?: return@Thread
                val name = "NiceCrystal333 " + SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.US).format(Date()) + ".wav"
                val bb = ByteBuffer.allocate(44 + pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
                bb.put("RIFF".toByteArray()).putInt(36 + pcm.size * 2).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(2).putInt(48000).putInt(48000 * 4).putShort(4).putShort(16).put("data".toByteArray()).putInt(pcm.size * 2)
                bb.asShortBuffer().put(pcm)
                val v = android.content.ContentValues().apply { put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name); put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "audio/wav"); put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Music/NiceCrystal333") }
                val uri = c.contentResolver.insert(android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v) ?: run { say("COULD NOT SAVE"); return@Thread }
                c.contentResolver.openOutputStream(uri)?.use { it.write(bb.array()) }
                say("SAVED IN MUSIC / NICECRYSTAL333")
            } catch (e: Exception) { android.util.Log.e("NiceCrystal", "out rec", e); say("COULD NOT SAVE") }
        }.start()
    }
    fun note(t: String) { say(t) }
    @Volatile var share = ""
    /** A sound for the rooms' own engine: left then right, 32-bit floats. */
    fun soundBytes(id: Int): ByteArray? {
        val s = sounds.firstOrNull { it.id == id } ?: return null
        if (s.l == null) { try { if (s.asset != null) decodeWav(app!!.assets.open("sounds/" + s.asset).use { it.readBytes() }, s) else if (s.file != null) decodeWav(s.file!!.readBytes(), s) } catch (e: Exception) { return null } }
        val l = s.l ?: return null; val r = s.r ?: l; if (s.keyRoot == -2) detectKey(s)
        val bb = ByteBuffer.allocate(l.size * 8).order(ByteOrder.LITTLE_ENDIAN); val fb = bb.asFloatBuffer(); fb.put(l); fb.put(r); return bb.array()
    }
    private var app: Context? = null
    private var booted = false; private var visible = 0
    private val main = Handler(Looper.getMainLooper())
    private var lx = 0f; private var ly = 0f; private var rx = 0f; private var ry = 0f; private var pitchF = 0f
    private var hatX = 0; private var hatY = 0; private var ticks = 0

    fun boot(ctx: Context) {
        if (booted) return; booted = true; app = ctx.applicationContext
        Native.start(); Native.setClock(bpm); Native.setParam(KEYLOCK, 1f); Native.setKeyLock(true)
        // your own takes, grabs and imported files come first, newest first; the built-in sounds follow
        try { soundDir()?.listFiles { f -> f.name.endsWith(".wav") }?.sortedByDescending { it.lastModified() }?.forEachIndexed { i, f -> sounds.add(i, Sound(f.name.removeSuffix(".wav"), null, f)) } } catch (e: Exception) { android.util.Log.e("NiceCrystal", "library", e) }
        loadSound(0); startMidi(ctx.applicationContext); main.post(ticker)
    }
    fun shown() { visible++; if (visible == 1 && booted) Native.start() }
    fun hidden() { visible = max(0, visible - 1); if (visible == 0) { Native.setParam(PLAY, 0f); Native.allOff(); main.postDelayed({ if (visible == 0) Native.stop() }, 400) } }
    fun micGranted() { micOk = true; pickInput() }
    @Volatile var inputName = "built-in microphone"; @Volatile var usbInput = false; @Volatile var recording = false
    private var lastInput = -1
    /** A USB audio device (the FM-1) beats the built-in microphone. Called again every two seconds, so plugging in is enough. */
    private fun pickInput() {
        if (!micOk) return
        try {
            val am = app?.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager ?: return
            val usb = am.getDevices(android.media.AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_USB_DEVICE || it.type == android.media.AudioDeviceInfo.TYPE_USB_HEADSET }
            val id = usb?.id ?: 0; usbInput = usb != null
            val label = usb?.productName?.toString() ?: ""
            inputName = if (usb == null) "built-in microphone" else if (label.isBlank()) "USB audio" else label
            if (id != lastInput) { lastInput = id; Thread { Native.openInput(id); if (live) Native.setParam(MIX, if (usbInput) 0.55f else 1f) }.start() }
        } catch (e: Exception) { android.util.Log.e("NiceCrystal", "input", e) }
    }
    /** RECORD: tap to start (turns LIVE on), tap again to stop. What came in becomes the sound, ready to mess with. */
    fun rec() {
        if (!recording) { if (!live) goLive(true); recording = Native.recStart(); return }
        recording = false
        Thread {
            val g = Native.recStop() ?: return@Thread; val n = g.size / 2
            val s = Sound("TAKE " + SimpleDateFormat("HH.mm.ss", Locale.US).format(Date()), null)
            s.l = g.copyOfRange(0, n); s.r = g.copyOfRange(n, 2 * n); s.seconds = n / 48000f; s.peaks = peaksOf(s.l!!, s.r!!, 480); detectKey(s); keep(s)
            sounds.add(0, s); cur = 0; live = false; Native.setLive(false); Native.loadSample(s.l!!, s.r!!, 48000)
            Native.setParam(MIX, 0.5f); Native.setParam(POSITION, 0f); Native.setParam(LENGTH, 1f); Native.setParam(PLAY, 1f); version++
        }.start()
    }

    // ---- sounds
    fun loadSound(i: Int) {
        val n = sounds.size; cur = ((i % n) + n) % n; val s = sounds[cur]
        Thread {
            try {
                if (s.l == null && s.asset != null) { val b = app!!.assets.open("sounds/" + s.asset).use { it.readBytes() }; decodeWav(b, s) }
                if (s.l == null && s.file != null) decodeWav(s.file!!.readBytes(), s)
                val l = s.l ?: return@Thread; val r = s.r ?: l
                if (s.peaks.isEmpty()) s.peaks = peaksOf(l, r, 480)
                if (s.keyRoot == -2) detectKey(s)
                if (live) { live = false; Native.setLive(false) }
                Native.loadSample(l, r, 48000); version++
            } catch (e: Exception) { android.util.Log.e("NiceCrystal", "load failed", e) }
        }.start()
    }
    private fun decodeWav(b: ByteArray, s: Sound) {
        val bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN); var pos = 12; var ch = 2; var bits = 16
        while (pos + 8 <= b.size) {
            val id = String(b, pos, 4, Charsets.US_ASCII); val size = bb.getInt(pos + 4)
            if (id == "fmt ") { ch = bb.getShort(pos + 10).toInt(); bits = bb.getShort(pos + 22).toInt() }
            else if (id == "data") {
                val frames = minOf(size, b.size - pos - 8) / (ch * bits / 8); val l = FloatArray(frames); val r = FloatArray(frames); var p = pos + 8
                for (f in 0 until frames) { l[f] = bb.getShort(p) / 32768f; r[f] = if (ch > 1) bb.getShort(p + 2) / 32768f else l[f]; p += ch * 2 }
                s.l = l; s.r = r; s.seconds = frames / 48000f; return
            }
            pos += 8 + size + (size and 1)
        }
    }
    // ---- keeping sounds: every take, grab and imported file is written to the app's sounds folder as a WAV
    @Volatile var notice = ""; private var noticeUntil = 0L
    private fun say(t: String) { notice = t; noticeUntil = System.currentTimeMillis() + 3500 }
    var importer: (() -> Unit)? = null
    private fun soundDir(): java.io.File? { val c = app ?: return null; val d = java.io.File(c.getExternalFilesDir(null) ?: c.filesDir, "sounds"); d.mkdirs(); return d }
    private fun keep(s: Sound) {
        try {
            val l = s.l ?: return; val r = s.r ?: l; val dir = soundDir() ?: return; val safe = s.name.replace(Regex("[^A-Za-z0-9 ._-]"), " ").trim().ifEmpty { "SOUND" }
            var f = java.io.File(dir, "$safe.wav"); var k = 2; while (f.exists()) { f = java.io.File(dir, "$safe $k.wav"); k++ }
            val n = l.size; val bb = ByteBuffer.allocate(44 + n * 4).order(ByteOrder.LITTLE_ENDIAN)
            bb.put("RIFF".toByteArray()).putInt(36 + n * 4).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(2).putInt(48000).putInt(48000 * 4).putShort(4).putShort(16).put("data".toByteArray()).putInt(n * 4)
            for (i in 0 until n) { bb.putShort((l[i].coerceIn(-1f, 1f) * 32767f).roundToInt().toShort()); bb.putShort((r[i].coerceIn(-1f, 1f) * 32767f).roundToInt().toShort()) }
            f.writeBytes(bb.array()); s.file = f
        } catch (e: Exception) { android.util.Log.e("NiceCrystal", "save", e); say("COULD NOT SAVE") }
    }
    /** Removes the loaded sound if it is one of yours (built-in sounds stay). */
    fun removeCurrent() { val s = sounds[cur]; if (s.asset != null || sounds.size < 2) return; try { s.file?.delete() } catch (e: Exception) {}; sounds.removeAt(cur); say("REMOVED"); loadSound(cur) }
    fun pickFile() { importer?.invoke() }
    /** A file chosen from the Thor's storage: any audio the device can decode, up to 90 seconds, brought to 48 kHz. */
    fun importUri(uri: android.net.Uri) {
        val c = app ?: return; say("READING THE FILE")
        Thread {
            try {
                var name = "IMPORT"
                c.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { q -> if (q.moveToFirst()) name = (q.getString(0) ?: name).substringBeforeLast('.') }
                val ex = android.media.MediaExtractor(); ex.setDataSource(c, uri, null)
                var fmt: android.media.MediaFormat? = null
                for (i in 0 until ex.trackCount) { val f = ex.getTrackFormat(i); if (f.getString(android.media.MediaFormat.KEY_MIME)?.startsWith("audio/") == true) { ex.selectTrack(i); fmt = f; break } }
                val format = fmt ?: run { say("NO AUDIO IN THAT FILE"); return@Thread }
                var rate = format.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE); var ch = format.getInteger(android.media.MediaFormat.KEY_CHANNEL_COUNT)
                val codec = android.media.MediaCodec.createDecoderByType(format.getString(android.media.MediaFormat.KEY_MIME)!!); codec.configure(format, null, null, 0); codec.start()
                val pcm = java.io.ByteArrayOutputStream(); val info = android.media.MediaCodec.BufferInfo(); var inDone = false; var outDone = false; var idle = 0
                while (!outDone && idle < 500) {
                    if (!inDone) { val ii = codec.dequeueInputBuffer(10000); if (ii >= 0) { val n = ex.readSampleData(codec.getInputBuffer(ii)!!, 0); if (n < 0) { codec.queueInputBuffer(ii, 0, 0, 0, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true } else { codec.queueInputBuffer(ii, 0, n, ex.sampleTime, 0); ex.advance() } } }
                    val oi = codec.dequeueOutputBuffer(info, 10000)
                    if (oi >= 0) { idle = 0; val buf = codec.getOutputBuffer(oi)!!; val b = ByteArray(info.size); buf.position(info.offset); buf.get(b); pcm.write(b); codec.releaseOutputBuffer(oi, false)
                        if (info.flags and android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 || pcm.size() > rate.toLong() * ch * 2 * 90) outDone = true }
                    else if (oi == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { val f = codec.outputFormat; rate = f.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE); ch = f.getInteger(android.media.MediaFormat.KEY_CHANNEL_COUNT) }
                    else idle++
                }
                try { codec.stop() } catch (e: Exception) {}; codec.release(); ex.release()
                val sh = ByteBuffer.wrap(pcm.toByteArray()).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer(); val frames = sh.remaining() / max(1, ch)
                if (frames < rate / 10) { say("COULD NOT READ THAT FILE"); return@Thread }
                val n = (frames.toLong() * 48000 / rate).toInt(); val l = FloatArray(n); val r = FloatArray(n); val step = rate / 48000.0
                for (i in 0 until n) { val p = i * step; val i0 = minOf(frames - 1, p.toInt()); val i1 = minOf(frames - 1, i0 + 1); val t = (p - i0).toFloat()
                    val a0 = sh.get(i0 * ch) / 32768f; val a1 = sh.get(i1 * ch) / 32768f; l[i] = a0 + (a1 - a0) * t
                    if (ch > 1) { val b0 = sh.get(i0 * ch + 1) / 32768f; val b1 = sh.get(i1 * ch + 1) / 32768f; r[i] = b0 + (b1 - b0) * t } else r[i] = l[i] }
                val s = Sound(name.uppercase(Locale.US).take(28), null); s.l = l; s.r = r; s.seconds = n / 48000f; s.peaks = peaksOf(l, r, 480); detectKey(s); keep(s)
                sounds.add(0, s); notice = ""; loadSound(0)
            } catch (e: Exception) { android.util.Log.e("NiceCrystal", "import", e); say("COULD NOT READ THAT FILE") }
        }.start()
    }
    private fun peaksOf(l: FloatArray, r: FloatArray, bins: Int): String {
        val sb = StringBuilder(); val n = l.size
        for (k in 0 until bins) { val a = (n.toLong() * k / bins).toInt(); val e = max(a + 1, (n.toLong() * (k + 1) / bins).toInt()); var pk = 0f; var i = a; while (i < e) { val v = max(abs(l[i]), abs(r[i])); if (v > pk) pk = v; i += 4 }; if (k > 0) sb.append(','); sb.append((pk * 1000).roundToInt() / 1000f) }
        return sb.toString()
    }
    /** Which key the sound is in: how strongly each of the twelve notes rings, matched against major and minor. */
    private fun detectKey(s: Sound) {
        val l = s.l ?: return; val r = s.r ?: l; val dec = 4; val fs = 48000.0 / dec; val n = minOf(l.size / dec, (fs * 24).toInt()); s.keyRoot = -1
        if (n < 4096) return
        val x = FloatArray(n) { i -> var a = 0f; for (k in 0 until dec) a += l[i * dec + k] + r[i * dec + k]; a / (2 * dec) }
        val win = 4096; val hop = 2048; val hann = FloatArray(win) { (0.5 - 0.5 * kotlin.math.cos(2 * Math.PI * it / win)).toFloat() }
        val chroma = DoubleArray(12); var total = 0.0
        var st = 0
        while (st + win <= n) {
            for (midi in 36..83) {
                val w = 2 * Math.PI * 440.0 * Math.pow(2.0, (midi - 69) / 12.0) / fs; val c = 2 * kotlin.math.cos(w); var s1 = 0.0; var s2 = 0.0
                for (i in 0 until win) { val s0 = x[st + i] * hann[i] + c * s1 - s2; s2 = s1; s1 = s0 }
                val mag = Math.sqrt(max(0.0, s1 * s1 + s2 * s2 - c * s1 * s2)); chroma[midi % 12] += mag; total += mag
            }
            st += hop
        }
        if (total < 1e-3) return
        val maj = doubleArrayOf(6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88); val min = doubleArrayOf(6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
        fun corr(p: DoubleArray, root: Int): Double { var mx = 0.0; var my = 0.0; for (i in 0 until 12) { mx += chroma[(i + root) % 12]; my += p[i] }; mx /= 12; my /= 12; var a = 0.0; var b = 0.0; var d = 0.0; for (i in 0 until 12) { val u = chroma[(i + root) % 12] - mx; val v = p[i] - my; a += u * v; b += u * u; d += v * v }; return a / Math.sqrt(b * d + 1e-12) }
        var best = -2.0; var second = -2.0
        for (root in 0 until 12) for (m in 0..1) { val c = corr(if (m == 1) min else maj, root); if (c > best) { second = best; best = c; s.keyRoot = root; s.keyMinor = m == 1 } else if (c > second) second = c }
        if (best < 0.45) s.keyRoot = -1   // drums and noise: no clear key
    }
    // with a USB device you hear what comes in as well as the grains; with the microphone only the grains, or it would howl
    fun goLive(on: Boolean) { if (!on && recording) { rec(); return }; live = on; Native.setLive(on); if (on) Native.setParam(MIX, if (usbInput) 0.55f else 1f); version++ }
    fun grab() { if (live) Native.grab() }

    // ---- pads, throws, chaos
    fun set(i: Int, v: Float) { Native.setParam(i, v) }
    fun toggle(i: Int) { val p = Native.getParams(); Native.setParam(i, if (p[i] > 0.5f) 0f else 1f) }
    private val throwDefs = mapOf(
        "FILTER" to listOf(TONE to 0.14f, RESO to 0.45f), "SPACE" to listOf(SPACE to 1f, DECAY to 0.9f),
        "STUTTER" to listOf(LENGTH to 0.22f, SCAN to 0.5f, GRID to 4f), "HALF" to listOf(XPOSE to -12f))
    private val held = HashMap<String, List<Pair<Int, Float>>>()
    @Synchronized fun throwOn(name: String) { val d = throwDefs[name] ?: return; if (held.containsKey(name)) return; val p = Native.getParams(); held[name] = d.map { it.first to p[it.first] }; d.forEach { Native.setParam(it.first, it.second) } }
    @Synchronized fun throwOff(name: String) { held.remove(name)?.forEach { Native.setParam(it.first, it.second) } }
    fun heldThrows(): String = synchronized(this) { held.keys.joinToString(",") }
    fun pad(name: String, down: Boolean) {
        when (name) {
            "PLAY" -> if (down) toggle(PLAY)
            "FREEZE" -> if (down) toggle(FREEZE)
            "REVERSE" -> if (down) toggle(REV)
            "CHAOS" -> if (down) chaos()
            "MOOD" -> if (down) mood = (mood + 1) % moods.size
            else -> if (down) throwOn(name) else throwOff(name)
        }
    }
    /** New settings in the current mood. Pitch only ever moves by octaves or a fifth, so it stays in key. */
    fun chaos() {
        val r = Random; fun f(a: Float, b: Float) = a + (b - a) * r.nextFloat()
        set(POSITION, r.nextFloat()); set(LENGTH, f(0.45f, 1f)); set(SPREAD, f(0.4f, 1f))
        when (moods[mood]) {
            "DREAM" -> { set(SIZE, f(0.6f, 0.9f)); set(DENSITY, f(0.45f, 0.7f)); set(SPRAY, f(0.2f, 0.6f)); set(SHATTER, f(0f, 0.3f)); set(REV, f(0f, 0.3f)); set(SPACE, f(0.5f, 0.9f)); set(TONE, f(0.35f, 0.5f)); set(DELAY, f(0f, 0.4f)); set(DRIVE, 0f); set(CHORUS, f(0.2f, 0.7f)) }
            "GLITCH" -> { set(SIZE, f(0.1f, 0.4f)); set(DENSITY, f(0.6f, 0.95f)); set(SPRAY, f(0.5f, 1f)); set(SHATTER, f(0.4f, 0.9f)); set(REV, f(0.2f, 0.6f)); set(SPACE, f(0.1f, 0.4f)); set(TONE, f(0.45f, 0.7f)); set(DELAY, f(0.2f, 0.6f)); set(DRIVE, f(0f, 0.3f)); set(CHORUS, 0f) }
            "GHOST" -> { set(SIZE, f(0.7f, 1f)); set(DENSITY, f(0.25f, 0.5f)); set(SPRAY, f(0.6f, 1f)); set(SHATTER, f(0.2f, 0.5f)); set(REV, f(0.6f, 1f)); set(SPACE, f(0.7f, 1f)); set(TONE, f(0.55f, 0.75f)); set(DELAY, f(0.3f, 0.6f)); set(DRIVE, 0f); set(CHORUS, f(0.3f, 0.8f)) }
            "MACHINE" -> { set(SIZE, f(0.25f, 0.5f)); set(DENSITY, f(0.5f, 0.8f)); set(SPRAY, f(0f, 0.2f)); set(SHATTER, f(0f, 0.4f)); set(REV, 0f); set(SPACE, f(0.1f, 0.35f)); set(TONE, f(0.3f, 0.5f)); set(DELAY, f(0.3f, 0.7f)); set(DRIVE, f(0.2f, 0.5f)); set(CHORUS, 0f) }
            else -> { set(SIZE, f(0.3f, 0.8f)); set(DENSITY, f(0.7f, 1f)); set(SPRAY, f(0.6f, 1f)); set(SHATTER, f(0.6f, 1f)); set(REV, f(0.3f, 0.7f)); set(SPACE, f(0.4f, 0.8f)); set(TONE, f(0.2f, 0.45f)); set(DELAY, f(0.4f, 0.8f)); set(DRIVE, f(0.6f, 1f)); set(CHORUS, f(0f, 0.5f)) }
        }
        pitchF = listOf(-12f, 0f, 0f, 0f, 7f, 12f).random(); set(PITCH, 0.5f + pitchF / 48f)
        if (moods[mood] == "MACHINE") set(GRID, listOf(2f, 4f, 4f, 6f).random()) else set(GRID, 0f)
    }

    // ---- physical controls
    fun key(e: KeyEvent): Boolean {
        val down = e.action == KeyEvent.ACTION_DOWN; val first = down && e.repeatCount == 0
        if (e.keyCode == KeyEvent.KEYCODE_BUTTON_START) { if (first) enter(rooms[(rooms.indexOf(room) + 1) % rooms.size]); return true }
        if (room != "grain") {
            val name = when (e.keyCode) { KeyEvent.KEYCODE_BUTTON_A -> "A"; KeyEvent.KEYCODE_BUTTON_B -> "B"; KeyEvent.KEYCODE_BUTTON_X -> "X"; KeyEvent.KEYCODE_BUTTON_Y -> "Y"
                KeyEvent.KEYCODE_DPAD_LEFT -> "LEFT"; KeyEvent.KEYCODE_DPAD_RIGHT -> "RIGHT"; KeyEvent.KEYCODE_DPAD_UP -> "UP"; KeyEvent.KEYCODE_DPAD_DOWN -> "DOWN"; KeyEvent.KEYCODE_BUTTON_L1 -> "L1"; KeyEvent.KEYCODE_BUTTON_R1 -> "R1"; else -> return false }
            if (down && (first || name == "UP" || name == "DOWN")) { act = name; actSeq++ }
            return true
        }
        when (e.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A -> if (first) pad("PLAY", true)
            KeyEvent.KEYCODE_BUTTON_B -> if (first) pad("FREEZE", true)
            KeyEvent.KEYCODE_BUTTON_X -> if (first) pad("REVERSE", true)
            KeyEvent.KEYCODE_BUTTON_Y -> if (first) pad("CHAOS", true)
            KeyEvent.KEYCODE_BUTTON_L1 -> if (first) throwOn("STUTTER") else if (!down) throwOff("STUTTER")
            KeyEvent.KEYCODE_BUTTON_R1 -> if (first) throwOn("HALF") else if (!down) throwOff("HALF")
            KeyEvent.KEYCODE_BUTTON_L2 -> if (first) throwOn("FILTER") else if (!down) throwOff("FILTER")
            KeyEvent.KEYCODE_BUTTON_R2 -> if (first) throwOn("SPACE") else if (!down) throwOff("SPACE")
            KeyEvent.KEYCODE_BUTTON_SELECT -> if (first) goLive(!live)
            KeyEvent.KEYCODE_BUTTON_THUMBL -> if (first) loadSound(cur + 1)
            KeyEvent.KEYCODE_BUTTON_THUMBR -> if (first) grab()
            KeyEvent.KEYCODE_DPAD_LEFT -> if (down) dpad(-1, 0)
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (down) dpad(1, 0)
            KeyEvent.KEYCODE_DPAD_UP -> if (down) dpad(0, 1)
            KeyEvent.KEYCODE_DPAD_DOWN -> if (down) dpad(0, -1)
            else -> return false
        }
        return true
    }
    private fun dpad(dx: Int, dy: Int) {
        if (dx != 0) sel = (sel + dx + sliders.size) % sliders.size
        if (dy != 0) { val i = sliders[sel]; if (i == PITCH) { pitchF = (((Native.getParams()[PITCH] - 0.5f) * 48f).roundToInt() + dy).toFloat().coerceIn(-24f, 24f); set(PITCH, 0.5f + pitchF / 48f) } else set(i, (Native.getParams()[i] + dy * 0.04f).coerceIn(0f, 1f)) }
    }
    fun motion(e: MotionEvent): Boolean {
        if (e.source and InputDevice.SOURCE_JOYSTICK != InputDevice.SOURCE_JOYSTICK || e.action != MotionEvent.ACTION_MOVE) return false
        fun dz(v: Float) = if (abs(v) < 0.18f) 0f else v
        lx = dz(e.getAxisValue(MotionEvent.AXIS_X)); ly = dz(e.getAxisValue(MotionEvent.AXIS_Y)); rx = dz(e.getAxisValue(MotionEvent.AXIS_Z)); ry = dz(e.getAxisValue(MotionEvent.AXIS_RZ))
        val lt = max(e.getAxisValue(MotionEvent.AXIS_LTRIGGER), e.getAxisValue(MotionEvent.AXIS_BRAKE)); val rt = max(e.getAxisValue(MotionEvent.AXIS_RTRIGGER), e.getAxisValue(MotionEvent.AXIS_GAS))
        if (lt > 0.5f) throwOn("FILTER") else if (lt < 0.3f && trigL) throwOff("FILTER"); trigL = lt > 0.5f || (trigL && lt >= 0.3f)
        if (rt > 0.5f) throwOn("SPACE") else if (rt < 0.3f && trigR) throwOff("SPACE"); trigR = rt > 0.5f || (trigR && rt >= 0.3f)
        val hx = e.getAxisValue(MotionEvent.AXIS_HAT_X).roundToInt(); val hy = e.getAxisValue(MotionEvent.AXIS_HAT_Y).roundToInt()
        if (hx != hatX) { hatX = hx; if (hx != 0) dpad(hx, 0) }; if (hy != hatY) { hatY = hy; if (hy != 0) dpad(0, -hy) }
        return true
    }
    private var trigL = false; private var trigR = false; private var pitching = false
    private val ticker = object : Runnable {
        override fun run() {
            if (visible > 0) {
                if (lx != 0f || ly != 0f || rx != 0f || ry != 0f) {
                    val p = Native.getParams(); val dt = 0.016f
                    if (lx != 0f) set(POSITION, (p[POSITION] + lx * dt * 0.6f).coerceIn(0f, 1f))
                    if (ly != 0f) set(SIZE, (p[SIZE] - ly * dt * 0.6f).coerceIn(0f, 1f))
                    if (ry != 0f) set(DENSITY, (p[DENSITY] - ry * dt * 0.6f).coerceIn(0f, 1f))
                    if (rx != 0f) { if (!pitching) { pitching = true; pitchF = (p[PITCH] - 0.5f) * 48f }; pitchF = (pitchF + rx * dt * 14f).coerceIn(-24f, 24f); set(PITCH, 0.5f + pitchF.roundToInt() / 48f) }
                }
                if (rx == 0f) pitching = false
                if (ticks % 120 == 60) { scanDevices(); pickInput() }
                if (recording && Native.recSeconds() > 59.5f) rec()
                if (outRecording && Native.outRecSeconds() > 299f) outRec()
                if (++ticks % 12 == 0) Native.takeGrab()?.let { g ->
                    val n = g.size / 2; val s = Sound("GRAB " + SimpleDateFormat("HH.mm.ss", Locale.US).format(Date()), null)
                    s.l = g.copyOfRange(0, n); s.r = g.copyOfRange(n, 2 * n); s.seconds = n / 48000f; s.peaks = peaksOf(s.l!!, s.r!!, 480); Thread { detectKey(s); keep(s); version++ }.start()
                    sounds.add(0, s); cur = 0; live = false; Native.setParam(MIX, 0.5f); Native.setParam(PLAY, 1f); version++
                }
            }
            main.postDelayed(this, 16)
        }
    }

    // ---- MIDI keyboards and synths over USB or Bluetooth
    private val midiIn = object : MidiReceiver() {
        override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
            var i = offset; val end = offset + count
            midiCount++; midiLast = (offset until minOf(end, offset + 3)).joinToString(" ") { String.format("%02X", msg[it].toInt() and 0xFF) }
            while (i < end) {
                val st = msg[i].toInt() and 0xFF
                if (st < 0x80) { i++; continue }
                when (st and 0xF0) {
                    0x90 -> { if (i + 2 < end) { val n = msg[i + 1].toInt() and 0x7F; val v = msg[i + 2].toInt() and 0x7F; if (v > 0) Native.noteOn(n, 0.3f + 0.7f * v / 127f) else Native.noteOff(n) }; i += 3 }
                    0x80 -> { if (i + 1 < end) Native.noteOff(msg[i + 1].toInt() and 0x7F); i += 3 }
                    0xB0 -> { if (i + 2 < end && (msg[i + 1].toInt() and 0x7F) == 64) Native.sustain((msg[i + 2].toInt() and 0x7F) >= 64); i += 3 }
                    0xE0 -> { if (i + 2 < end) { val v = ((msg[i + 2].toInt() and 0x7F) shl 7) or (msg[i + 1].toInt() and 0x7F); Native.setParam(BEND, (v - 8192) / 8192f * 2f) }; i += 3 }
                    0xC0, 0xD0 -> i += 2
                    0xF0 -> { if (st == 0xF0) { while (i < end && (msg[i].toInt() and 0xFF) != 0xF7) i++ }; i++ }
                    else -> i += 3
                }
            }
        }
    }
    private val opened = HashSet<Int>(); private var midi: MidiManager? = null
    private fun midiLabel(d: MidiDeviceInfo) = d.properties.getString(MidiDeviceInfo.PROPERTY_NAME) ?: d.properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT) ?: "MIDI"
    private fun openMidi(d: MidiDeviceInfo) {
        val mm = midi ?: return; if (d.outputPortCount == 0 || !opened.add(d.id)) return
        mm.openDevice(d, { dev -> if (dev != null) { for (p in 0 until d.outputPortCount) dev.openOutputPort(p)?.connect(midiIn); midiName = midiLabel(d) } else opened.remove(d.id) }, main)
    }
    private fun startMidi(ctx: Context) {
        midi = ctx.getSystemService(Context.MIDI_SERVICE) as? MidiManager
        val mm = midi ?: run { midiName = ""; usbSeen = "this device has no MIDI service"; return }
        try {
            mm.registerDeviceCallback(object : MidiManager.DeviceCallback() {
                override fun onDeviceAdded(device: MidiDeviceInfo) { openMidi(device) }
                override fun onDeviceRemoved(device: MidiDeviceInfo) { opened.remove(device.id); if (midiName == midiLabel(device)) midiName = "" }
            }, main)
        } catch (e: Exception) { android.util.Log.e("NiceCrystal", "midi", e) }
        scanDevices()
    }
    /** Looks again for MIDI devices, and notes what is plugged into USB and what it offers (for the status row). */
    private fun scanDevices() {
        try { midi?.devices?.forEach { openMidi(it) } } catch (e: Exception) { android.util.Log.e("NiceCrystal", "midi scan", e) }
        try {
            val um = app?.getSystemService(Context.USB_SERVICE) as? android.hardware.usb.UsbManager ?: return
            usbSeen = um.deviceList.values.joinToString(" + ") { d ->
                var audio = false; var midiIf = false
                for (i in 0 until d.interfaceCount) { val f = d.getInterface(i); if (f.interfaceClass == 1) { if (f.interfaceSubclass == 3) midiIf = true; if (f.interfaceSubclass == 2) audio = true } }
                (d.productName ?: "USB device") + " (" + (if (audio) "audio" else "no audio") + ", " + (if (midiIf) "MIDI" else "no MIDI") + ")"
            }
        } catch (e: Exception) { usbSeen = "" }
    }

    // ---- what the screens draw
    fun state(): String {
        val p = Native.getParams(); val s = sounds[cur]; val sb = StringBuilder(640)
        sb.append("{\"sound\":\"").append(s.name.replace("\"", "'")).append("\",\"seconds\":").append(s.seconds).append(",\"live\":").append(live)
            .append(",\"room\":\"").append(room).append("\",\"cur\":").append(s.id).append(",\"hear\":").append(hearing).append(",\"deckOn\":").append(deckOn).append(",\"act\":\"").append(act).append("\",\"actSeq\":").append(actSeq).append(",\"outRec\":").append(if (outRecording) Native.outRecSeconds() else -1f).append(",\"result\":\"").append((result?.name ?: "").replace("\"", "'")).append("\",\"resultSec\":").append(result?.seconds ?: 0f).append(",\"resultBars\":").append(result?.bars ?: 0).append(",\"sounds\":[").append(sounds.joinToString(",") { "{\"id\":" + it.id + ",\"name\":\"" + it.name.replace("\"", "'") + "\",\"key\":" + it.keyRoot + ",\"minor\":" + it.keyMinor + "}" }).append("],\"deck\":[").append(deck.joinToString(",") { "{\"name\":\"" + it.name.replace("\"", "'") + "\",\"bars\":" + it.bars + "}" }).append("]").append(",\"share\":\"").append(share.replace("\\", "/").replace("\"", "'")).append("\"").append(",\"mood\":\"").append(moods[mood]).append("\",\"sel\":").append(sel).append(",\"version\":").append(version).append(",\"bpm\":").append(bpm.toInt())
            .append(",\"keyRoot\":").append(if (live) -1 else s.keyRoot).append(",\"keyMinor\":").append(s.keyMinor).append(",\"usb\":\"").append(usbSeen.replace("\"", "'")).append("\",\"midiCount\":").append(midiCount).append(",\"midiLast\":\"").append(midiLast).append("\",\"midi\":\"").append(midiName.replace("\"", "'")).append("\",\"notice\":\"").append(if (System.currentTimeMillis() < noticeUntil) notice else "").append("\",\"mine\":").append(s.asset == null).append(",\"mic\":").append(micOk).append(",\"input\":\"").append(inputName.replace("\"", "'")).append("\",\"rec\":").append(recording).append(",\"recSec\":").append(if (recording) Native.recSeconds() else 0f)
            .append(",\"info\":\"").append(Native.info().replace("\"", "'")).append("\",\"throws\":\"").append(heldThrows()).append("\",\"p\":[")
        for (i in p.indices) { if (i > 0) sb.append(','); sb.append(p[i]) }
        return sb.append("]}").toString()
    }
    fun peaks(): String = sounds[cur].peaks
    fun resultPeaks(): String = result?.peaks ?: ""
}
