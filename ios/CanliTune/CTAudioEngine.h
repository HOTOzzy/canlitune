#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Low-latency full-duplex engine: RemoteIO AudioUnit -> CanlıTune C++ DSP -> output.
@interface CTAudioEngine : NSObject
/// Requests mic permission if needed, configures AVAudioSession, starts audio.
/// Completion receives a JSON string: {"ok":true,...} or {"ok":false,"err":"..."}; called on the main queue.
- (void)startWithCompletion:(void (^)(NSString *json))completion;
- (void)stop;
- (void)setParams:(NSDictionary<NSString *, id> *)params;
- (void)measure;
/// 16 numbers: 12 engine telemetry + sampleRate, framesPerBuffer, outLatencyMs, inLatencyMs
- (NSArray<NSNumber *> *)telemetry;
@end

NS_ASSUME_NONNULL_END
