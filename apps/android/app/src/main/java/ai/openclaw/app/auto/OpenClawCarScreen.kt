package ai.openclaw.app.auto

import ai.openclaw.app.NodeApp
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.Header
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Template
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

class OpenClawCarScreen(
  carContext: CarContext,
  private val app: NodeApp,
) : Screen(carContext) {

  private var isListening = false

  init {
    lifecycle.addObserver(
      object : DefaultLifecycleObserver {
        override fun onResume(owner: LifecycleOwner) {
          invalidate()
        }

        override fun onPause(owner: LifecycleOwner) {
          if (isListening) {
            stopVoiceInteraction()
          }
        }
      },
    )
  }

  override fun onGetTemplate(): Template {
    val runtime = app.ensureRuntime()
    val isConnected = runtime.gatewayConnectionDisplay.value.isConnected
    val messageText = when {
      !isConnected -> "Gateway desconectado. Verifique conexão."
      isListening -> "Ouvindo... Fale agora."
      else -> "Pronto. Diga a wake word ou toque no botão para falar."
    }

    val pttActionTitle = if (isListening) "Parar" else "Falar"

    val header = Header.Builder()
      .setTitle("OpenClaw Auto")
      .build()

    return MessageTemplate.Builder(messageText)
      .setHeader(header)
      .addAction(
        Action.Builder()
          .setTitle(pttActionTitle)
          .setOnClickListener {
            toggleVoiceInteraction()
          }
          .build(),
      )
      .build()
  }

  private fun toggleVoiceInteraction() {
    if (isListening) {
      stopVoiceInteraction()
    } else {
      startVoiceInteraction()
    }
  }

  private fun startVoiceInteraction() {
    val runtime = app.ensureRuntime()
    if (!runtime.gatewayConnectionDisplay.value.isConnected) return
    isListening = true
    invalidate()
  }

  private fun stopVoiceInteraction() {
    isListening = false
    invalidate()
  }
}
