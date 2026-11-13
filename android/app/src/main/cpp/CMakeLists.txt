cmake_minimum_required(VERSION 3.22.1)
project(canlitune CXX)
set(CMAKE_CXX_STANDARD 17)
add_library(canlitune SHARED native-lib.cpp)
# shared DSP core lives at <repo>/core
target_include_directories(canlitune PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../core)
find_package(oboe REQUIRED CONFIG)
target_link_libraries(canlitune oboe::oboe log)
