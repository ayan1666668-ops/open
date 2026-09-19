package ai.openclaw.app.ui.chat

import ai.openclaw.app.AppearanceTextScale
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.ui.AgentPicker
import ai.openclaw.app.ui.AgentPickerState
import ai.openclaw.app.ui.FoldAwareSheetState
import ai.openclaw.app.ui.SidebarAttentionIndicator
import ai.openclaw.app.ui.SidebarAttentionKind
import ai.openclaw.app.ui.SidebarAttentionRequest
import ai.openclaw.app.ui.WindowDisplayFeatureSnapshot
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.sidebarPalette
import ai.openclaw.app.ui.summarizeSidebarAttention
import android.content.Context
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeWindowTextDensityTest {
  @get:Rule val composeRule = createComposeRule()

  private fun assertLarge(text: String) {
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText(text, useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
    assertEquals(
      1.4f * AppearanceTextScale.Large.factor,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
  }

  private fun show(content: @Composable (ChatModelPickerSession) -> Unit) {
    composeRule.setContent {
      val activity = LocalActivity.current
      val view = LocalView.current
      val lifecycle = LocalLifecycleOwner.current.lifecycle
      val opening =
        remember {
          val geometry = FoldAwareSheetState(activity, view, lifecycle) {}
          geometry.publishFeatures(WindowDisplayFeatureSnapshot(ready = true))
          ChatModelPickerSession(ChatComposerOwner(null, "main", "main"), "main", geometry)
        }
      CompositionLocalProvider(LocalDensity provides Density(1f, 1.4f)) {
        ClawDesignTheme(textScale = AppearanceTextScale.Large) { content(opening) }
      }
    }
  }

  @Test fun attentionPopupKeepsSelectedTextScale() {
    val attention =
      checkNotNull(
        summarizeSidebarAttention(
          listOf(SidebarAttentionRequest(SidebarAttentionKind.Question, "fixture", "main", "Fixture question", 1, 1)),
          null,
        ),
      )
    show { SidebarAttentionIndicator(attention, sidebarPalette(ClawTheme.colors)) }
    composeRule.onNodeWithTag("sidebar-attention-question").performClick()
    assertLarge("Fixture question")
  }

  @Test fun agentDropdownKeepsSelectedTextScaleAndSelection() {
    var selected: String? = null
    show {
      AgentPicker(AgentPickerState(listOf(GatewayAgentSummary("main", "Main", null, null)), "missing"), { selected = it })
    }
    composeRule.onNodeWithText("missing").performClick()
    assertLarge("Main")
    composeRule.onNodeWithText("Main").performClick()
    assertEquals("main", selected)
  }

  @Test fun effortSheetKeepsSelectedTextScale() {
    show { opening ->
      ChatEffortSheet(opening, emptyList(), "off", false, false, false, true, {}, {}, {})
    }
    assertLarge("Fast mode")
  }

  @Test fun branchSheetKeepsSelectedTextScale() {
    show { opening -> BranchSwitcherSheet(opening, emptyList(), true, {}, {}) }
    assertLarge("Switch branch")
  }

  @Test fun modelSheetKeepsSelectedTextScale() {
    show { opening ->
      ChatModelPickerSheet(
        opening = opening,
        admit = { true },
        admitPermissions = { true },
        sections = ChatModelPickerSections(emptyList(), emptyList(), emptyList()),
        favorites = emptySet(),
        selectedModelLabel = "Fixture model",
        modelSelectionLocked = false,
        contextUsage = ChatContextUsage(null, null, null),
        messages = emptyList(),
        permissionMode = null,
        permissionModePending = false,
        permissionPickerEnabled = false,
        permissionUnavailableReason = null,
        canSelectFullPermission = false,
        onPermissionModeChange = { false },
        onDismiss = {},
        onSelect = {},
        onOpenProviders = {},
        onSignIn = null,
        onToggleFavorite = {},
      )
    }
    assertLarge("Fixture model")
  }

  @Test fun backgroundTasksSheetKeepsSelectedTextScale() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("density-fixture", Context.MODE_PRIVATE))
    val store = ViewModelStore()
    val model = MainViewModel(app, prefs, SavedStateHandle())
    store.put("fixture", model)
    try {
      show { opening -> BackgroundTasksSheet(model, opening, { true }, {}) }
      assertLarge("Background tasks")
    } finally {
      store.clear()
    }
  }
}
