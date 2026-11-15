package com.nicecrystal.thor

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityOptions
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.view.Display
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.lang.ref.WeakReference

/** What the pages call. The names match the `NC.` calls in assets/ui. */
class Bridge {
    @JavascriptInterface fun set(i: Int, v: Double) = Studio.set(i, v.toFloat())
    @JavascriptInterface fun pad(name: String, down: Boolean) = Studio.pad(name, down)
    @JavascriptInterface fun note(n: Int, down: Boolean) { if (down) Native.noteOn(n, 0.85f) else Native.noteOff(n) }
    @JavascriptInterface fun sound(step: Int) = Studio.loadSound(Studio.cur + step)
    @JavascriptInterface fun live(on: Boolean) = Studio.goLive(on)
    @JavascriptInterface fun grab() = Studio.grab()
    @JavascriptInterface fun rec() = Studio.rec()
    @JavascriptInterface fun add() = Studio.pickFile()
    @JavascriptInterface fun room(name: String) = Studio.enter(name)
    @JavascriptInterface fun bpm(v: Double) { Studio.bpm = v.coerceIn(40.0, 240.0); Native.setClock(Studio.bpm) }
    @JavascriptInterface fun resBegin() = Studio.resBegin()
    @JavascriptInterface fun resChunk(b64: String) = Studio.resChunk(b64)
    @JavascriptInterface fun resEnd(name: String, bars: Int) = Studio.resEnd(name, bars)
    @JavascriptInterface fun hear(on: Boolean) = Studio.hear(on)
    @JavascriptInterface fun keep() = Studio.keepResult()
    @JavascriptInterface fun toDeck() = Studio.toDeck()
    @JavascriptInterface fun deckToggle() = Studio.deckToggle()
    @JavascriptInterface fun deckRemove(i: Int) = Studio.deckRemove(i)
    @JavascriptInterface fun outRec() = Studio.outRec()
    @JavascriptInterface fun say(t: String) = Studio.note(t)
    @JavascriptInterface fun share(t: String) { Studio.share = t }
    @JavascriptInterface fun resultPeaks(): String = Studio.resultPeaks()
    @JavascriptInterface fun phases(): String = Native.loopPhases().joinToString(",")
    @JavascriptInterface fun remove() = Studio.removeCurrent()
    @JavascriptInterface fun select(i: Int) { Studio.sel = i }
    @JavascriptInterface fun state(): String = Studio.state()
    @JavascriptInterface fun peaks(): String = Studio.peaks()
    @JavascriptInterface fun snap(): String = Native.snapshot().joinToString(",")
}

/** One screen of the instrument. Two of these run at once on a Thor: the display and the controls. */
open class ScreenActivity : Activity() {
    protected lateinit var web: WebView
    protected var page = "single"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        page = intent.getStringExtra("page") ?: choosePage()
        web = WebView(this)
        web.settings.javaScriptEnabled = true; web.settings.domStorageEnabled = true
        web.setBackgroundColor(0xFF05050A.toInt()); web.overScrollMode = View.OVER_SCROLL_NEVER
        web.addJavascriptInterface(Bridge(), "NC")
        // the pages are served from the app's own files under one address, so they can use workers and fetch sounds
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url; if (u.host != "nc.local") return null; val path = u.path ?: return null
                return try {
                    if (path.startsWith("/sound/")) {
                        val bytes = Studio.soundBytes(path.removePrefix("/sound/").toInt()) ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
                        WebResourceResponse("application/octet-stream", null, java.io.ByteArrayInputStream(bytes))
                    } else {
                        val name = path.removePrefix("/"); val mime = when (name.substringAfterLast('.')) { "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"; "ttf" -> "font/ttf"; else -> "application/octet-stream" }
                        WebResourceResponse(mime, if (mime.startsWith("text") || mime.endsWith("javascript")) "utf-8" else null, assets.open(name))
                    }
                } catch (e: Exception) { WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0))) }
            }
        }
        setContentView(web)
        Studio.boot(this)
        web.loadUrl("https://nc.local/ui/$page.html")
    }
    /** Called on the screen the app was launched on. Returns the page for this screen. */
    protected open fun choosePage(): String = "single"

    override fun onStart() { super.onStart(); Studio.shown() }
    override fun onStop() { super.onStop(); Studio.hidden() }
    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) immersive() }
    @Suppress("DEPRECATION")
    private fun immersive() {
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean = Studio.key(event) || super.dispatchKeyEvent(event)
    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean = Studio.motion(event) || super.dispatchGenericMotionEvent(event)
}

class CompanionActivity : ScreenActivity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); MainActivity.other = WeakReference(this) }
}

class MainActivity : ScreenActivity() {
    companion object { var other: WeakReference<Activity>? = null }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Studio.importer = { runOnUiThread { try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*"), 7) } catch (e: Exception) { android.util.Log.e("NiceCrystal", "picker", e) } } }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) Studio.micGranted()
        else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) Studio.micGranted()
    }
    /** Two displays: the bigger one becomes the display, the smaller one the controls. One display: both on one page. */
    @Suppress("DEPRECATION")
    override fun choosePage(): String {
        try {
            val dm = getSystemService(DisplayManager::class.java); val mine = windowManager.defaultDisplay
            val other = dm.displays.firstOrNull { it.displayId != mine.displayId && it.state != Display.STATE_OFF && (it.flags and Display.FLAG_PRIVATE) == 0 } ?: return "single"
            fun area(d: Display) = d.mode.physicalWidth.toLong() * d.mode.physicalHeight
            val iAmDisplay = area(mine) >= area(other)
            val opts = ActivityOptions.makeBasic(); opts.launchDisplayId = other.displayId
            startActivity(Intent(this, CompanionActivity::class.java).putExtra("page", if (iAmDisplay) "bottom" else "top")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK), opts.toBundle())
            return if (iAmDisplay) "top" else "bottom"
        } catch (e: Exception) { android.util.Log.e("NiceCrystal", "second screen", e); return "single" }
    }
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 7 && resultCode == RESULT_OK) data?.data?.let { Studio.importUri(it) }
    }
    override fun onDestroy() { super.onDestroy(); if (isFinishing) { Studio.importer = null; other?.get()?.finish() } }
}
