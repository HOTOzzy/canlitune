# CanlıTune — canlı Auto-Tune (web + Android + iPhone)

Canlı mikrofon için perde düzeltme: YIN perde tespiti, gam kuantalayıcı (Retune / Humanize / Flex-Tune / doğal vibrato),
iki perde kaydırıcı (ultra düşük gecikmeli periyot-senkron ekleme ve formant koruyan TD-PSOLA), ikinci ses (double/oktav),
kompresör, saturasyon, delay, reverb, geri besleme koruması ve kaynaklı 12 sanatçı/stil preseti.

| Platform | Ses yolu | İndir / aç |
|---|---|---|
| Web (her telefon) | Web Audio AudioWorklet | GitHub Pages adresi (Settings → Pages) |
| Android | **Oboe** (AAudio, exclusive, low-latency, VoicePerformance mikrofon) | Releases → `CanliTune.apk` |
| iPhone | **RemoteIO AudioUnit** (Measurement modu, ~128 örnek tampon) | Releases → `CanliTune-unsigned.ipa` (Sideloadly/AltStore ile kendi Apple ID'nle imzala) veya Mac'te Xcode |

Üç platform da **aynı arayüzü** (`web/`) ve **aynı DSP'yi** kullanır: `web/dsp-core.js` ve onun bit düzeyinde eşdeğer C++ portu `core/CanliTuneEngine.hpp`.

## Yapı
```
core/        C++ DSP çekirdeği (header-only) + kilitsiz parametre kuyruğu (NativeBridge.hpp) + testler
web/         JS DSP, mobil arayüz, presets.json, testler, build.js (dist/index.html üretir ve uygulamalara kopyalar)
android/     Gradle + CMake + Oboe (prefab) + JNI + WebView kabuğu
ios/         XcodeGen projesi, Objective-C++ RemoteIO motoru, SwiftUI + WKWebView kabuğu
.github/     CI: testler → APK (Release'e eklenir) → iOS derleme + imzasız .ipa → GitHub Pages
```

## Testler
```
node --expose-gc web/test/dsp.test.js                       # 39 DSP testi
g++ -std=c++17 -O2 -pthread -o core/test/rt_test core/test/rt_test.cpp && ./core/test/rt_test   # ses iş parçacığında 0 bellek ayırma
g++ -std=c++17 -O2 -o core/test/ctrun core/test/ctrun.cpp && node core/test/equivalence.test.js core/test/ctrun  # JS == C++
node web/build.js
```

## Yerel derleme
- Android: Android Studio ile `android/` klasörünü aç → Run. (Önce `node web/build.js`.)
- iPhone: Mac'te `brew install xcodegen && cd ios && xcodegen && open CanliTune.xcodeproj` → kendi takımını seç → Run.

Kulaklık kullanın: hoparlörden dinlemek mikrofona geri besleme yapar.
