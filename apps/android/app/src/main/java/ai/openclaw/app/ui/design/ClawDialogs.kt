package ai.openclaw.app.ui.design

import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.material3.AlertDialog as MaterialAlertDialog
import androidx.compose.ui.window.Dialog as NativeDialog

/** Native windows replace LocalDensity. Preserve the already-scaled parent without scaling twice. */
@Composable
internal fun ClawDialog(
  onDismissRequest: () -> Unit,
  properties: DialogProperties = DialogProperties(),
  content: @Composable () -> Unit,
) {
  val density = LocalDensity.current
  NativeDialog(onDismissRequest = onDismissRequest, properties = properties) {
    CompositionLocalProvider(LocalDensity provides density, content = content)
  }
}

/** Keep Material's dialog behavior/defaults while restoring density in every content slot. */
@Composable
internal fun ClawAlertDialog(
  onDismissRequest: () -> Unit,
  confirmButton: @Composable () -> Unit,
  modifier: Modifier = Modifier,
  dismissButton: (@Composable () -> Unit)? = null,
  icon: (@Composable () -> Unit)? = null,
  title: (@Composable () -> Unit)? = null,
  text: (@Composable () -> Unit)? = null,
  shape: Shape = AlertDialogDefaults.shape,
  containerColor: Color = AlertDialogDefaults.containerColor,
  iconContentColor: Color = AlertDialogDefaults.iconContentColor,
  titleContentColor: Color = AlertDialogDefaults.titleContentColor,
  textContentColor: Color = AlertDialogDefaults.textContentColor,
  tonalElevation: Dp = AlertDialogDefaults.TonalElevation,
  properties: DialogProperties = DialogProperties(),
) {
  val density = LocalDensity.current
  MaterialAlertDialog(
    onDismissRequest = onDismissRequest,
    confirmButton = { CompositionLocalProvider(LocalDensity provides density, content = confirmButton) },
    modifier = modifier,
    dismissButton = preserveDialogDensity(density, dismissButton),
    icon = preserveDialogDensity(density, icon),
    title = preserveDialogDensity(density, title),
    text = preserveDialogDensity(density, text),
    shape = shape,
    containerColor = containerColor,
    iconContentColor = iconContentColor,
    titleContentColor = titleContentColor,
    textContentColor = textContentColor,
    tonalElevation = tonalElevation,
    properties = properties,
  )
}

private fun preserveDialogDensity(
  density: Density,
  content: (@Composable () -> Unit)?,
): (@Composable () -> Unit)? = content?.let { { CompositionLocalProvider(LocalDensity provides density, content = it) } }
