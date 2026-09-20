package ai.openclaw.app.ui

import ai.openclaw.app.GatewayPairedDeviceSummary
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w400dp-h500dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PairedDeviceLabelTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun pairedRowsPreferOperatorLabelsAndRetainFallbacks() {
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.background(ClawTheme.colors.surface)) {
          listOf(
            device("desktop", "Original desktop", "workstation"),
            device("cli", null, "server"),
            device("phone", "Phone", null),
            device("unnamed", null, null),
          ).forEach { device ->
            PairedDeviceRow(device, canRemove = false, actionEnabled = false, onRemove = {})
          }
        }
      }
    }
    composeRule.waitForIdle()
    System.getenv("OPENCLAW_LABEL_SCREENSHOT")?.let { path ->
      File(path).apply { parentFile?.mkdirs() }.outputStream().use {
        check(
          composeRule
            .onRoot()
            .captureToImage()
            .asAndroidBitmap()
            .compress(Bitmap.CompressFormat.PNG, 100, it),
        )
      }
    }
    composeRule.onNodeWithText("workstation").assertIsDisplayed()
    composeRule.onNodeWithText("Original desktop · operator · 0/0 active tokens").assertIsDisplayed()
    composeRule.onNodeWithText("server").assertIsDisplayed()
    composeRule.onNodeWithText("Phone").assertIsDisplayed()
    composeRule.onNodeWithText("Paired device").assertIsDisplayed()
  }

  private fun device(
    id: String,
    name: String?,
    label: String?,
  ) = GatewayPairedDeviceSummary(
    deviceId = id,
    displayName = name,
    remoteIp = null,
    roles = listOf("operator"),
    scopes = emptyList(),
    tokens = emptyList(),
    approvedAtMs = null,
    operatorLabel = label,
  )
}
