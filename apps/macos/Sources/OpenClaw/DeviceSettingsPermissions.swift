import OpenClawIPC
import OpenClawKit

extension DeviceSettingsPermission {
    static let macOSPermissions: [Self] = [
        .notifications, .accessibility, .screenRecording, .microphone,
        .camera, .speechRecognition, .location, .automation,
    ]

    var capability: Capability? {
        switch self {
        case .notifications: .notifications
        case .accessibility: .accessibility
        case .screenRecording: .screenRecording
        case .microphone: .microphone
        case .camera: .camera
        case .speechRecognition: .speechRecognition
        case .location: .location
        case .automation: .appleScript
        case .contacts, .calendars, .reminders, .photos: nil
        }
    }
}

extension DeviceSettingsPermissionStatus {
    init(_ status: CapabilityAuthorizationStatus?) {
        switch status {
        case .granted: self = .granted
        // Binary macOS checks cannot distinguish a denial from an unrequested grant.
        // Preserve requestable states so Settings does not skip the native TCC prompt.
        case .notGranted: self = .notGranted
        case .unknown: self = .unknown
        case nil: self = .unavailable
        }
    }
}
