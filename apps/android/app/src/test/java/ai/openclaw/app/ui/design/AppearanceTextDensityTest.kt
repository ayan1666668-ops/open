package ai.openclaw.app.ui.design

import ai.openclaw.app.AppearanceTextScale
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class AppearanceTextDensityTest {
  @Test
  fun standardRetainsPlatformDensityAndAccessibilityCurve() {
    val system = Density(3f, 1.8f)
    assertSame(system, appearanceTextDensity(system, AppearanceTextScale.Standard))
  }

  @Test
  fun optionalSizePreservesNativeFontConverterAndDpGeometry() {
    val system =
      object : Density {
        override val density = 3f
        override val fontScale = 1.8f

        override fun TextUnit.toDp(): Dp = (value * 2f).dp

        override fun Dp.toSp(): TextUnit = (value / 2f).sp
      }
    val larger = appearanceTextDensity(system, AppearanceTextScale.Large)
    assertEquals(30f, larger.run { 10.dp.toPx() }, 0.001f)
    assertEquals(23f, larger.run { 10.sp.toDp().value }, 0.001f)
    assertEquals(69f, larger.run { 10.sp.toPx() }, 0.001f)
    assertEquals(10f, larger.run { 23.dp.toSp().value }, 0.001f)
    assertEquals(3f, larger.density, 0f)
  }
}
