package com.nicecrystal.thor

/** The C++ engine. Everything here is safe to call from any thread. */
object Native {
    init { System.loadLibrary("nc333") }
    external fun start(): Boolean
    external fun stop()
    external fun openInput(): Boolean
    external fun setParam(i: Int, v: Float)
    external fun getParams(): FloatArray
    external fun noteOn(n: Int, vel: Float)
    external fun noteOff(n: Int)
    external fun allOff()
    external fun sustain(on: Boolean)
    external fun setLive(on: Boolean)
    external fun grab()
    external fun setClock(bpm: Double)
    external fun setKeyLock(on: Boolean)
    external fun loadSample(l: FloatArray, r: FloatArray, rate: Int)
    external fun takeGrab(): FloatArray?
    external fun snapshot(): FloatArray
    external fun info(): String
}
