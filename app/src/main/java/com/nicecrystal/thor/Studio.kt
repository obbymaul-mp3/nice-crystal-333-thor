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

    class Sound(val name: String, val asset: String?) { var peaks: String = ""; var seconds = 0f; var l: FloatArray? = null; var r: FloatArray? = null; var keyRoot = -2; var keyMinor = true }

    val sounds = mutableListOf(Sound("GLASS BELLS", "bells.wav"), Sound("CRYSTAL", "crystal.wav"), Sound("SNOW VOICE", "voice.wav"), Sound("DUSTY BOOM-BAP", "beat1.wav"), Sound("GLASS HOUSE", "beat2.wav"))
    val moods = listOf("DREAM", "GLITCH", "GHOST", "MACHINE", "HELL")
    // five pages of four sliders, in the order the bottom screen shows them
    val sliders = intArrayOf(PITCH, DENSITY, TONE, SPACE, LENGTH, SCAN, SPRAY, SHATTER, SPREAD, ATTACK, SUSTAIN, MIX, RESO, DRIVE, CRUSH, CHORUS, DELAY, DTIME, DFEED, DECAY)
    @Volatile var usbSeen = ""
    @Volatile var cur = 0; @Volatile var live = false; @Volatile var mood = 0; @Volatile var sel = 0; @Volatile var version = 0
    @Volatile var midiName = ""; @Volatile var micOk = false
    val bpm = 128.0
    private var app: Context? = null
    private var booted = false; private var visible = 0
    private val main = Handler(Looper.getMainLooper())
    private var lx = 0f; private var ly = 0f; private var rx = 0f; private var ry = 0f; private var pitchF = 0f
    private var hatX = 0; private var hatY = 0; private var ticks = 0

    fun boot(ctx: Context) {
        if (booted) return; booted = true; app = ctx.applicationContext
        Native.start(); Native.setClock(bpm); Native.setParam(KEYLOCK, 1f); Native.setKeyLock(true)
        loadSound(0); startMidi(ctx.applicationContext); main.post(ticker)
    }
    fun shown() { visible++; if (visible == 1 && booted) Native.start() }
    fun hidden() { visible = max(0, visible - 1); if (visible == 0) { Native.setParam(PLAY, 0f); Native.allOff(); main.postDelayed({ if (visible == 0) Native.stop() }, 400) } }
    fun micGranted() { micOk = true; Native.openInput() }

    // ---- sounds
    fun loadSound(i: Int) {
        val n = sounds.size; cur = ((i % n) + n) % n; val s = sounds[cur]
        Thread {
            try {
                if (s.l == null && s.asset != null) { val b = app!!.assets.open("sounds/" + s.asset).use { it.readBytes() }; decodeWav(b, s) }
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
    fun goLive(on: Boolean) { live = on; Native.setLive(on); if (on) Native.setParam(MIX, 1f); version++ }
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
        when (e.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A -> if (first) pad("PLAY", true)
            KeyEvent.KEYCODE_BUTTON_B -> if (first) pad("FREEZE", true)
            KeyEvent.KEYCODE_BUTTON_X -> if (first) pad("REVERSE", true)
            KeyEvent.KEYCODE_BUTTON_Y -> if (first) pad("CHAOS", true)
            KeyEvent.KEYCODE_BUTTON_L1 -> if (first) throwOn("STUTTER") else if (!down) throwOff("STUTTER")
            KeyEvent.KEYCODE_BUTTON_R1 -> if (first) throwOn("HALF") else if (!down) throwOff("HALF")
            KeyEvent.KEYCODE_BUTTON_L2 -> if (first) throwOn("FILTER") else if (!down) throwOff("FILTER")
            KeyEvent.KEYCODE_BUTTON_R2 -> if (first) throwOn("SPACE") else if (!down) throwOff("SPACE")
            KeyEvent.KEYCODE_BUTTON_START -> if (first) pad("MOOD", true)
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
                if (ticks % 120 == 60) scanDevices()
                if (++ticks % 12 == 0) Native.takeGrab()?.let { g ->
                    val n = g.size / 2; val s = Sound("GRAB " + SimpleDateFormat("HH.mm.ss", Locale.US).format(Date()), null)
                    s.l = g.copyOfRange(0, n); s.r = g.copyOfRange(n, 2 * n); s.seconds = n / 48000f; s.peaks = peaksOf(s.l!!, s.r!!, 480); Thread { detectKey(s); version++ }.start()
                    sounds.add(0, s); cur = 0; live = false; version++
                }
            }
            main.postDelayed(this, 16)
        }
    }

    // ---- MIDI keyboards and synths over USB or Bluetooth
    private val midiIn = object : MidiReceiver() {
        override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
            var i = offset; val end = offset + count
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
            .append(",\"mood\":\"").append(moods[mood]).append("\",\"sel\":").append(sel).append(",\"version\":").append(version).append(",\"bpm\":").append(bpm.toInt())
            .append(",\"keyRoot\":").append(if (live) -1 else s.keyRoot).append(",\"keyMinor\":").append(s.keyMinor).append(",\"usb\":\"").append(usbSeen.replace("\"", "'")).append("\",\"midi\":\"").append(midiName.replace("\"", "'")).append("\",\"mic\":").append(micOk)
            .append(",\"info\":\"").append(Native.info().replace("\"", "'")).append("\",\"throws\":\"").append(heldThrows()).append("\",\"p\":[")
        for (i in p.indices) { if (i > 0) sb.append(','); sb.append(p[i]) }
        return sb.append("]}").toString()
    }
    fun peaks(): String = sounds[cur].peaks
}
