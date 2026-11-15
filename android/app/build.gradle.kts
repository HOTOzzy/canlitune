plugins { id("com.android.application") }

android {
    namespace = "com.canlitune.app"
    compileSdk = 34
    ndkVersion = "26.3.11579264"

    defaultConfig {
        applicationId = "com.canlitune.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "2.0"
        externalNativeBuild {
            cmake {
                cppFlags += listOf("-std=c++17", "-O3")
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    signingConfigs {
        // Fixed side-loading key kept in the repo so every CI build can be installed over the previous one.
        // (Not a store key: anyone can build this open-source app anyway.)
        create("sideload") {
            storeFile = file("canlitune-sideload.jks")
            storePassword = "canlitune"
            keyAlias = "canlitune"
            keyPassword = "canlitune"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    buildFeatures { prefab = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.oboe:oboe:1.9.0")
    implementation("androidx.core:core:1.13.1")
}
