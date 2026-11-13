#import "CTAudioEngine.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <vector>
#include "NativeBridge.hpp"

// Everything the real-time render callback touches lives here; allocated before start.
struct CTRenderState {
  AudioUnit unit = nullptr;
  canlitune::NativeBridge bridge;
  std::vector<float> in, L, R;
  AudioBufferList inList;  // one mono buffer pointing at `in`
  UInt32 maxFrames = 4096;
};

static OSStatus RenderCB(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts,
                         UInt32 bus, UInt32 frames, AudioBufferList *io) {
  CTRenderState *st = (CTRenderState *)ref;
  if (frames > st->maxFrames) {  // never expected; fail silent rather than allocate
    for (UInt32 b = 0; b < io->mNumberBuffers; b++) memset(io->mBuffers[b].mData, 0, io->mBuffers[b].mDataByteSize);
    return noErr;
  }
  st->inList.mNumberBuffers = 1;
  st->inList.mBuffers[0].mNumberChannels = 1;
  st->inList.mBuffers[0].mDataByteSize = frames * sizeof(float);
  st->inList.mBuffers[0].mData = st->in.data();
  OSStatus err = AudioUnitRender(st->unit, flags, ts, 1, frames, &st->inList);
  if (err != noErr) memset(st->in.data(), 0, frames * sizeof(float));
  float *outL = (float *)io->mBuffers[0].mData;
  float *outR = io->mNumberBuffers > 1 ? (float *)io->mBuffers[1].mData : nullptr;
  st->bridge.render(st->in.data(), outL, outR, (int)frames);
  return noErr;
}

@implementation CTAudioEngine {
  CTRenderState *_st;
  BOOL _running;
}

- (instancetype)init {
  if ((self = [super init])) {
    _st = new CTRenderState();
    NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
    [nc addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
    [nc addObserver:self selector:@selector(interrupted:) name:AVAudioSessionInterruptionNotification object:nil];
    [nc addObserver:self selector:@selector(mediaReset:) name:AVAudioSessionMediaServicesWereResetNotification object:nil];
  }
  return self;
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self teardown];
  delete _st;
}

static NSString *ErrJSON(NSString *e) { return [NSString stringWithFormat:@"{\"ok\":false,\"err\":\"%@\"}", e]; }

- (void)startWithCompletion:(void (^)(NSString *))completion {
  AVAudioSession *s = AVAudioSession.sharedInstance;
  [s requestRecordPermission:^(BOOL granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!granted) { completion(ErrJSON(@"Mikrofon izni yok (Ayarlar → CanlıTune → Mikrofon)")); return; }
      completion([self startNow]);
    });
  }];
}

- (NSString *)startNow {
  [self teardown];
  AVAudioSession *s = AVAudioSession.sharedInstance;
  NSError *e = nil;
  // Measurement mode: no system voice processing (AGC/NS/AEC) → lowest latency, uncoloured signal
  [s setCategory:AVAudioSessionCategoryPlayAndRecord
            mode:AVAudioSessionModeMeasurement
         options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetoothA2DP
           error:&e];
  if (e) return ErrJSON(e.localizedDescription);
  [s setPreferredSampleRate:48000 error:nil];
  [s setPreferredIOBufferDuration:128.0 / 48000.0 error:nil];  // iOS rounds to its nearest supported size
  [s setActive:YES error:&e];
  if (e) return ErrJSON(e.localizedDescription);
  double sr = s.sampleRate;

  AudioComponentDescription d = {kAudioUnitType_Output, kAudioUnitSubType_RemoteIO, kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent comp = AudioComponentFindNext(NULL, &d);
  if (!comp || AudioComponentInstanceNew(comp, &_st->unit) != noErr) return ErrJSON(@"RemoteIO açılamadı");
  UInt32 one = 1;
  AudioUnitSetProperty(_st->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, sizeof one);
  AudioUnitSetProperty(_st->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &one, sizeof one);

  AudioStreamBasicDescription f = {0};
  f.mSampleRate = sr; f.mFormatID = kAudioFormatLinearPCM;
  f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
  f.mBytesPerPacket = 4; f.mFramesPerPacket = 1; f.mBytesPerFrame = 4; f.mBitsPerChannel = 32;
  f.mChannelsPerFrame = 2;
  AudioUnitSetProperty(_st->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &f, sizeof f);   // to speaker
  f.mChannelsPerFrame = 1;
  AudioUnitSetProperty(_st->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &f, sizeof f);  // from mic

  UInt32 maxF = 4096;
  AudioUnitSetProperty(_st->unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxF, sizeof maxF);
  _st->maxFrames = maxF;
  _st->in.assign(maxF, 0.f); _st->L.assign(maxF, 0.f); _st->R.assign(maxF, 0.f);
  _st->bridge.prepare(sr, (int)maxF);
  _st->bridge.framesPerBurst.store((float)lround(s.IOBufferDuration * sr));

  AURenderCallbackStruct cb = {RenderCB, _st};
  AudioUnitSetProperty(_st->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb);
  if (AudioUnitInitialize(_st->unit) != noErr) { [self teardown]; return ErrJSON(@"AudioUnit başlatılamadı"); }
  if (AudioOutputUnitStart(_st->unit) != noErr) { [self teardown]; return ErrJSON(@"Ses başlatılamadı"); }
  _running = YES;
  return [NSString stringWithFormat:@"{\"ok\":true,\"sr\":%.0f,\"burst\":%.0f,\"inLat\":%.2f}", sr, s.IOBufferDuration * sr,
                                    (s.inputLatency + s.IOBufferDuration) * 1000];
}

- (void)teardown {
  if (_st->unit) {
    AudioOutputUnitStop(_st->unit);
    AudioUnitUninitialize(_st->unit);
    AudioComponentInstanceDispose(_st->unit);
    _st->unit = nullptr;
  }
}

- (void)stop {
  _running = NO;
  [self teardown];
  [AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
}

- (void)setParams:(NSDictionary<NSString *, id> *)params {
  for (NSString *k in params) {
    id v = params[k];
    if (![v respondsToSelector:@selector(doubleValue)]) continue;
    int idx = canlitune::paramIdFromName(k.UTF8String);
    if (idx >= 0) _st->bridge.pushParam(idx, [v doubleValue]);
  }
}

- (void)measure { _st->bridge.requestMeasure(); }

- (NSArray<NSNumber *> *)telemetry {
  float t[12];
  _st->bridge.readTelemetry(t);
  AVAudioSession *s = AVAudioSession.sharedInstance;
  NSMutableArray *a = [NSMutableArray arrayWithCapacity:16];
  for (int i = 0; i < 12; i++) [a addObject:@(std::isfinite(t[i]) ? t[i] : 0.f)];
  [a addObject:@(s.sampleRate)];
  [a addObject:@(lround(s.IOBufferDuration * s.sampleRate))];
  [a addObject:@((s.outputLatency + s.IOBufferDuration) * 1000)];
  [a addObject:@((s.inputLatency + s.IOBufferDuration) * 1000)];
  return a;
}

// Headphones in/out, Bluetooth, sample-rate changes: rebuild the unit at the new format.
- (void)routeChanged:(NSNotification *)n {
  if (!_running) return;
  dispatch_async(dispatch_get_main_queue(), ^{ if (self->_running) [self startNow]; });
}
- (void)interrupted:(NSNotification *)n {
  NSUInteger type = [n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
  if (type == AVAudioSessionInterruptionTypeEnded && _running)
    dispatch_async(dispatch_get_main_queue(), ^{ [self startNow]; });
}
- (void)mediaReset:(NSNotification *)n {
  if (_running) dispatch_async(dispatch_get_main_queue(), ^{ [self startNow]; });
}
@end
