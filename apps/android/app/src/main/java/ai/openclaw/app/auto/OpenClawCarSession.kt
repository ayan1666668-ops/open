package ai.openclaw.app.auto

import ai.openclaw.app.NodeApp
import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session

class OpenClawCarSession(
  private val app: NodeApp,
) : Session() {
  override fun onCreateScreen(intent: Intent): Screen {
    return OpenClawCarScreen(carContext, app)
  }
}
