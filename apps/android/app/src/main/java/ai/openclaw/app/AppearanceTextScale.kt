package ai.openclaw.app

/** Device-local text size; system accessibility font scaling still applies. */
enum class AppearanceTextScale(
  val rawValue: String,
  val displayLabel: String,
  val factor: Float,
) {
  Small("small", "Small", 0.90f),
  Standard("standard", "Standard", 1.00f),
  Large("large", "Large", 1.15f),
  ;

  companion object {
    fun fromRawValue(value: String?): AppearanceTextScale = entries.firstOrNull { it.rawValue == value?.trim()?.lowercase() } ?: Standard

    fun fromDisplayLabel(label: String): AppearanceTextScale = entries.firstOrNull { it.displayLabel.equals(label, ignoreCase = true) } ?: Standard
  }
}
