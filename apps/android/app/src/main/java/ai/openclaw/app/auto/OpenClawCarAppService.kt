package ai.openclaw.app.auto

import ai.openclaw.app.NodeApp
import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

class OpenClawCarAppService : CarAppService() {
  override fun createHostValidator(): HostValidator {
    return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
  }

  override fun onCreateSession(): Session {
    val app = application as NodeApp
    return OpenClawCarSession(app)
  }
}
