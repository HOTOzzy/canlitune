package com.canlitune.app;

/** JNI entry points into the Oboe + C++ DSP engine (see src/main/cpp/native-lib.cpp). */
final class NativeAudio {
    static { System.loadLibrary("canlitune"); }
    private NativeAudio() {}

    static native String nStart(int sdkInt, int micDeviceId, int outDeviceId);
    static native void nStop();
    static native void nSetParams(String[] keys, double[] values);
    static native void nMeasure();
    static native float[] nTelemetry();

    static native void nBeatBegin(long frames, double sampleRate);
    static native void nBeatChunk(byte[] int16StereoLE);
    static native void nBeatCtl(int cmd, double value);

    static native boolean nRecStart(String wavPath);
    static native long nRecStop();
}
