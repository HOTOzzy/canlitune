package com.canlitune.app;

/** JNI entry points into the Oboe + C++ DSP engine (see src/main/cpp/native-lib.cpp). */
final class NativeAudio {
    static { System.loadLibrary("canlitune"); }
    private NativeAudio() {}

    static native String nStart(int sdkInt, int micDeviceId);
    static native void nStop();
    static native void nSetParams(String[] keys, double[] values);
    static native void nMeasure();
    static native float[] nTelemetry();
}
