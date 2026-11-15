package com.canlitune.app;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;

/** Converts a 16-bit stereo WAV (44-byte header) into an AAC .m4a so recordings are small enough to share. */
final class M4aEncoder {
    private M4aEncoder() {}

    private static int readFully(InputStream in, byte[] buf, int want) throws java.io.IOException {
        int got = 0;
        while (got < want) {
            int n = in.read(buf, got, want - got);
            if (n <= 0) break;
            got += n;
        }
        return got;
    }

    static boolean encode(File wav, File out, int sampleRate) {
        MediaCodec codec = null;
        MediaMuxer mux = null;
        boolean muxStarted = false;
        boolean ok = false;
        try (FileInputStream in = new FileInputStream(wav)) {
            if (in.skip(44) != 44) return false;
            MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 2);
            fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            fmt.setInteger(MediaFormat.KEY_BIT_RATE, 160000);
            fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            mux = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            byte[] buf = new byte[8192];
            int track = -1;
            boolean inDone = false, outDone = false;
            long frames = 0;
            while (!outDone) {
                if (!inDone) {
                    int ix = codec.dequeueInputBuffer(10000);
                    if (ix >= 0) {
                        ByteBuffer bb = codec.getInputBuffer(ix);
                        bb.clear();
                        int want = Math.min(buf.length, bb.remaining()) & ~3;
                        int n = readFully(in, buf, want) & ~3;
                        long pts = frames * 1000000L / sampleRate;
                        if (n <= 0) {
                            codec.queueInputBuffer(ix, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            bb.put(buf, 0, n);
                            codec.queueInputBuffer(ix, 0, n, pts, 0);
                            frames += n / 4;
                        }
                    }
                }
                int ox = codec.dequeueOutputBuffer(info, 10000);
                if (ox == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = mux.addTrack(codec.getOutputFormat());
                    mux.start();
                    muxStarted = true;
                } else if (ox >= 0) {
                    ByteBuffer ob = codec.getOutputBuffer(ox);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                    if (info.size > 0 && muxStarted) {
                        ob.position(info.offset);
                        ob.limit(info.offset + info.size);
                        mux.writeSampleData(track, ob, info);
                    }
                    codec.releaseOutputBuffer(ox, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                }
            }
            ok = muxStarted && frames > 0;
        } catch (Exception e) {
            android.util.Log.e("CanliTune", "m4a encode failed", e);
            ok = false;
        } finally {
            try { if (codec != null) { codec.stop(); codec.release(); } } catch (Exception ignored) {}
            try { if (mux != null) { if (muxStarted) mux.stop(); mux.release(); } } catch (Exception ignored) { ok = false; }
        }
        if (!ok) out.delete();
        return ok;
    }
}
