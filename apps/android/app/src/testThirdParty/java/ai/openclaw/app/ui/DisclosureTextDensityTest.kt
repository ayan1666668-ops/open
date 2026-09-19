package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceTextScale
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DisclosureTextDensityTest {
  @get:Rule val composeRule = createComposeRule()

  @Test fun disclosurePreservesLargeTextWithoutImplicitConsent() {
    var agreed = 0
    var dismissed = 0
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(1f, 1.4f)) {
        ClawDesignTheme(textScale = AppearanceTextScale.Large) {
          AccessibilityControlDisclosureDialog({ dismissed++ }, { agreed++ })
        }
      }
    }
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText("Allow control of other apps?", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
    assertEquals(
      1.4f * AppearanceTextScale.Large.factor,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
    composeRule.onNodeWithText("Not Now").performClick()
    assertEquals(1, dismissed)
    assertEquals(0, agreed)
  }
}
