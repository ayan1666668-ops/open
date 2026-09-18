package ai.openclaw.app.ui.chat

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatImageZoomTest {
  @Test
  fun offCenterPinchKeepsFocalPointUnderFinger() {
    val size = IntSize(400, 400)
    val result = transformChatImageZoom(ChatImageZoom(), size, size, Offset(300f, 200f), Offset.Zero, 2f)
    assertEquals(2f, result.scale, 0f)
    assertEquals(Offset(-100f, 0f), result.offset)
    // The original point 100px right of center remains at that same viewport position.
    assertEquals(100f, 100f * result.scale + result.offset.x, 0f)
  }

  @Test
  fun panIsBoundedByFittedImageRatherThanLetterbox() {
    val result = transformChatImageZoom(ChatImageZoom(), IntSize(400, 400), IntSize(800, 200), Offset(200f, 200f), Offset(900f, 900f), 2f)
    assertEquals(Offset(200f, 0f), result.offset)
  }

  @Test
  fun scaleIsBoundedAndReturningToFitResetsOffset() {
    val size = IntSize(400, 400)
    val enlarged = transformChatImageZoom(ChatImageZoom(), size, size, Offset(200f, 200f), Offset(30f, 20f), 10f)
    assertEquals(5f, enlarged.scale, 0f)
    assertEquals(ChatImageZoom(), transformChatImageZoom(enlarged, size, size, Offset.Zero, Offset.Zero, 0.1f))
    assertEquals(ChatImageZoom(), transformChatImageZoom(enlarged, IntSize.Zero, size, Offset.Zero, Offset.Zero, 1f))
  }
}
