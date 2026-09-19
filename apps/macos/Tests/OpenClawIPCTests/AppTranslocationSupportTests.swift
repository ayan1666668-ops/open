import Darwin
import Foundation
@testable import OpenClaw
import Testing

@Suite("App Translocation Support Tests")
struct AppTranslocationSupportTests {
    @Test
    func `detects App Translocation paths`() {
        #expect(AppTranslocationSupport.isAppTranslocatedPath(
            "/private/var/folders/x/AppTranslocation/y/d/OpenClaw.app",
        ))
        #expect(AppTranslocationSupport.isAppTranslocatedPath(
            "/private/var/folders/x/AppTranslocation/y/d/OpenClaw.app/Contents/MacOS/OpenClaw",
        ))
        #expect(!AppTranslocationSupport.isAppTranslocatedPath("/Applications/OpenClaw.app"))
        #expect(!AppTranslocationSupport.isAppTranslocatedPath(
            "/Users/tester/Applications/OpenClaw.app",
        ))
    }

    @Test
    func `running under App Translocation checks executable or bundle path`() {
        #expect(AppTranslocationSupport.isRunningUnderAppTranslocation(
            executablePath: "/private/var/folders/x/AppTranslocation/y/d/OpenClaw.app/Contents/MacOS/OpenClaw",
            bundlePath: "/Applications/OpenClaw.app",
        ))
        #expect(AppTranslocationSupport.isRunningUnderAppTranslocation(
            executablePath: "/Applications/OpenClaw.app/Contents/MacOS/OpenClaw",
            bundlePath: "/private/var/folders/x/AppTranslocation/y/d/OpenClaw.app",
        ))
        #expect(!AppTranslocationSupport.isRunningUnderAppTranslocation(
            executablePath: "/Applications/OpenClaw.app/Contents/MacOS/OpenClaw",
            bundlePath: "/Applications/OpenClaw.app",
        ))
    }

    @Test
    func `clears residual quarantine attributes including nested files`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("AppTranslocationSupportTests-\(UUID().uuidString)", isDirectory: true)
        let nestedDir = root.appendingPathComponent("Contents/Resources", isDirectory: true)
        let nestedFile = nestedDir.appendingPathComponent("asset.txt")
        defer { try? FileManager.default.removeItem(at: root) }

        try FileManager.default.createDirectory(at: nestedDir, withIntermediateDirectories: true)
        try Data("payload".utf8).write(to: nestedFile)
        try Data("root".utf8).write(to: root.appendingPathComponent("Info.plist"))

        #expect(setxattr(
            root.path,
            "com.apple.quarantine",
            "0000",
            4,
            0,
            0,
        ) == 0)
        #expect(setxattr(
            nestedFile.path,
            "com.apple.quarantine",
            "0001",
            4,
            0,
            0,
        ) == 0)

        #expect(AppTranslocationSupport.hasQuarantineAttribute(atPath: root.path))
        #expect(AppTranslocationSupport.hasQuarantineAttribute(atPath: nestedFile.path))

        #expect(AppTranslocationSupport.clearQuarantineAttributes(at: root))
        #expect(!AppTranslocationSupport.hasQuarantineAttribute(atPath: root.path))
        #expect(!AppTranslocationSupport.hasQuarantineAttribute(atPath: nestedFile.path))
    }

    @Test
    func `stuck relocation copy mentions quarantine and Peekaboo`() {
        #expect(AppTranslocationSupport.stuckRelocationTitle.contains("App Translocation"))
        #expect(AppTranslocationSupport.stuckRelocationMessage.contains("com.apple.quarantine"))
        #expect(AppTranslocationSupport.stuckRelocationMessage.contains("Peekaboo"))
        #expect(AppTranslocationSupport.stuckRelocationMessage.contains("xattr -dr"))
    }
}
