# ONNX Runtime JNI looks up Java classes, constructors and members by name.
# Keep the Java binding intact in consuming apps' minified release builds.
# https://github.com/microsoft/onnxruntime/blob/v1.30.0/java/src/main/native/OrtJniUtil.c
-keep class ai.onnxruntime.** { *; }
