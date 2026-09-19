package ai.openclaw.app.ui.design

import ai.openclaw.app.AppearanceTextScale
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(minSdk = 34, maxSdk = 34, qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeDialogTextDensityTest {
  @get:Rule val composeRule = createComposeRule()
  private val layouts = mutableMapOf<String, TextLayoutResult>()

  @Composable
  private fun Probe(id: String) {
    Text("Sample", fontSize = 20.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Normal, letterSpacing = 0.sp, onTextLayout = { layouts[id] = it })
  }

  private fun assertMatchesScreen(vararg slots: String) {
    composeRule.runOnIdle {
      val screen = checkNotNull(layouts["screen"])
      for (slot in slots) {
        val dialog = checkNotNull(layouts[slot])
        assertEquals(slot, screen.layoutInput.density.fontScale, dialog.layoutInput.density.fontScale, 0.001f)
        assertEquals(slot, screen.layoutInput.density.density, dialog.layoutInput.density.density, 0.001f)
        assertEquals(slot, screen.size.width, dialog.size.width)
      }
    }
  }

  @Test
  fun alertDialogRetainsLargeTextInEverySlotAndUpdatesWhileOpen() {
    val scale = mutableStateOf(AppearanceTextScale.Large)
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(1f, 1.4f)) {
        ClawDesignTheme(textScale = scale.value) {
          Probe("screen")
          ClawAlertDialog(
            onDismissRequest = {},
            icon = { Probe("icon") },
            title = { Probe("title") },
            text = { Probe("text") },
            confirmButton = { Probe("confirm") },
            dismissButton = { Probe("dismiss") },
          )
        }
      }
    }
    assertMatchesScreen("icon", "title", "text", "confirm", "dismiss")
    composeRule.runOnIdle { scale.value = AppearanceTextScale.Standard }
    assertMatchesScreen("icon", "title", "text", "confirm", "dismiss")
  }

  @Test
  fun customDialogRetainsEffectiveDensityWithoutApplyingScaleTwice() {
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(1f, 1.4f)) {
        ClawDesignTheme(textScale = AppearanceTextScale.Large) {
          Probe("screen")
          ClawDialog(onDismissRequest = {}) { Probe("dialog") }
        }
      }
    }
    assertMatchesScreen("dialog")
  }
}
