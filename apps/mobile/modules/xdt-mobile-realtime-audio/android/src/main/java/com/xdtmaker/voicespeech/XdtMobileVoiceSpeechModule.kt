package com.xdtmaker.voicespeech

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale
import java.util.UUID

/** TTS only: Android PCM capture remains owned by expo-audio's AudioStream. */
class XdtMobileVoiceSpeechModule : Module() {
  private data class Reply(
    val requestId: String,
    val text: String,
    val language: String?,
    val promise: Promise,
    val utteranceId: String = UUID.randomUUID().toString()
  )

  private val main = Handler(Looper.getMainLooper())
  private var engine: TextToSpeech? = null
  private var initialized = false
  private var engineGeneration = 0
  private var foreground = true
  private var pending: Reply? = null
  private var watchdog: Runnable? = null
  private var audioManager: AudioManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  override fun definition() = ModuleDefinition {
    Name("XdtMobileVoiceSpeech")
    AsyncFunction("speak") { options: Map<String, Any?>, promise: Promise ->
      speak(options, promise)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopSpeech") { requestId: String ->
      if (pending?.requestId == requestId) finish("cancelled")
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersForeground { main.post { foreground = true } }
    OnActivityEntersBackground { main.post {
      foreground = false
      finish("cancelled")
    } }
    OnDestroy { main.post {
      foreground = false
      finish("cancelled")
      engineGeneration += 1
      runCatching { engine?.shutdown() }
      engine = null
      initialized = false
    } }
  }

  private fun speak(options: Map<String, Any?>, promise: Promise) {
    finish("cancelled")
    val id = options["requestId"] as? String
    val text = options["text"] as? String
    if (id.isNullOrEmpty() || text.isNullOrEmpty() || text.length > TextToSpeech.getMaxSpeechInputLength()) {
      promise.reject("ERR_VOICE_SPEECH_INPUT", "Spoken reply exceeds the system speech input limit.", null)
      return
    }
    if (!foreground || appContext.currentActivity == null) {
      promise.resolve("cancelled")
      return
    }
    pending = Reply(id, text, options["language"] as? String, promise)
    armWatchdog(15_000)
    if (initialized) {
      startPending()
      return
    }
    if (engine != null) return
    val context = appContext.reactContext?.applicationContext
    if (context == null) {
      finish(error = "ERR_VOICE_SPEECH_UNAVAILABLE")
      return
    }
    val generation = ++engineGeneration
    try {
      engine = TextToSpeech(context) { status -> main.post {
        if (generation != engineGeneration) return@post
        if (status != TextToSpeech.SUCCESS) {
          finish(error = "ERR_VOICE_SPEECH_UNAVAILABLE")
          runCatching { engine?.shutdown() }
          engine = null
        } else {
          initialized = true
          installProgressListener()
          startPending()
        }
      } }
    } catch (_: Exception) {
      finish(error = "ERR_VOICE_SPEECH_UNAVAILABLE")
      runCatching { engine?.shutdown() }
      engine = null
    }
  }

  private fun startPending() {
    val reply = pending ?: return
    val tts = engine ?: return
    if (!foreground) {
      finish("cancelled")
      return
    }
    try {
      val locale = reply.language?.takeIf { it.isNotBlank() }?.let(Locale::forLanguageTag) ?: Locale.getDefault()
      if (tts.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
        finish(error = "ERR_VOICE_SPEECH_LANGUAGE")
        return
      }
      tts.setAudioAttributes(attributes)
      if (!acquireAudioFocus(reply.utteranceId)) {
        finish(error = "ERR_VOICE_SPEECH_AUDIO")
        return
      }
      if (tts.speak(reply.text, TextToSpeech.QUEUE_FLUSH, null, reply.utteranceId) != TextToSpeech.SUCCESS) {
        finish(error = "ERR_VOICE_SPEECH_FAILED")
      }
    } catch (_: Exception) {
      finish(error = "ERR_VOICE_SPEECH_FAILED")
    }
  }

  private fun installProgressListener() {
    engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) { main.post {
        if (pending?.utteranceId == utteranceId) armWatchdog(600_000)
      } }
      override fun onDone(utteranceId: String?) { main.post {
        if (pending?.utteranceId == utteranceId) finish("done")
      } }
      @Deprecated("Required by the platform's abstract listener")
      override fun onError(utteranceId: String?) { speechError(utteranceId) }
      override fun onError(utteranceId: String?, errorCode: Int) { speechError(utteranceId) }
      override fun onStop(utteranceId: String?, interrupted: Boolean) { main.post {
        if (pending?.utteranceId == utteranceId) finish("cancelled")
      } }
    })
  }

  private fun speechError(utteranceId: String?) { main.post {
    if (pending?.utteranceId == utteranceId) finish(error = "ERR_VOICE_SPEECH_FAILED")
  } }

  private fun armWatchdog(delay: Long) {
    watchdog?.let(main::removeCallbacks)
    watchdog = Runnable { finish(error = "ERR_VOICE_SPEECH_TIMEOUT") }
    main.postDelayed(watchdog!!, delay)
  }

  @Suppress("DEPRECATION")
  private fun acquireAudioFocus(utteranceId: String): Boolean {
    val manager = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
    val listener = AudioManager.OnAudioFocusChangeListener { change -> main.post {
      if (change < 0 && pending?.utteranceId == utteranceId) finish("cancelled")
    } }
    audioManager = manager
    focusListener = listener
    val result = if (Build.VERSION.SDK_INT >= 26) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(listener, main)
        .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  @Suppress("DEPRECATION")
  private fun releaseAudioFocus() {
    val manager = audioManager
    val request = focusRequest
    val listener = focusListener
    audioManager = null
    focusRequest = null
    focusListener = null
    if (Build.VERSION.SDK_INT >= 26 && request != null) manager?.abandonAudioFocusRequest(request)
    else if (listener != null) manager?.abandonAudioFocus(listener)
  }

  private fun finish(result: String? = null, error: String? = null) {
    val reply = pending ?: return
    pending = null
    watchdog?.let(main::removeCallbacks)
    watchdog = null
    runCatching { engine?.stop() }
    runCatching { releaseAudioFocus() }
    // An engine whose asynchronous initialization never called back must not
    // poison subsequent attempts. Ignore its late callback after releasing it.
    if (error != null && !initialized) {
      engineGeneration += 1
      runCatching { engine?.shutdown() }
      engine = null
    }
    if (error != null) reply.promise.reject(error, "The system could not play the spoken reply.", null)
    else reply.promise.resolve(result ?: "done")
  }
}
