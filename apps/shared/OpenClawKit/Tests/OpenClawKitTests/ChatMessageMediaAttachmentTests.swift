import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("Chat media attachments")
struct ChatMessageMediaAttachmentTests {
    @Test(arguments: [
        ("video/quicktime", "clip.mov"), ("video/mp4", "clip.mp4"),
        ("audio/mp4", "voice.m4a"), ("audio/mpeg", "audio.mp3"), ("audio/wav", "audio.wav"),
        ("image/jpeg", "photo.jpg"), ("image/png", "photo.png"), ("image/heic", "photo.heic"),
        ("image/gif", "image.gif"), ("application/pdf", "document.pdf"),
        ("text/plain", "notes.txt"), ("application/octet-stream", "archive.bin"),
    ])
    func `canonical inbound attachments survive history and cache`(mime: String, file: String) throws {
        let payload: [String: Any] = [
            "role": "user", "content": "Shared attachment",
            "__openclaw": ["media": [[
                "url": "media://inbound/" + file, "contentType": mime,
                "fileName": file, "sizeBytes": 1234, "durationMs": 2500,
                "width": 640, "height": 480,
            ]]],
        ]
        let message = try JSONDecoder().decode(
            OpenClawChatMessage.self, from: JSONSerialization.data(withJSONObject: payload))
        let attachment = try #require(message.content.first { $0.isInlineAttachment })
        #expect(attachment.url == "media://inbound/" + file)
        #expect(attachment.mimeType == mime)
        #expect(attachment.fetchableMediaReference == (attachment.mediaKind == nil ? nil : attachment.url))
        #expect(attachment.fileName == file)
        #expect(attachment.sizeBytes == 1234)
        #expect(attachment.durationSeconds == 2.5)
        #expect(attachment.width == 640)
        #expect(attachment.height == 480)
        let cached = try #require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)
        let restored = try JSONDecoder().decode(OpenClawChatMessage.self, from: JSONEncoder().encode(cached))
        #expect(restored.content.filter(\.isInlineAttachment) == [attachment])
    }

    @Test func `canonical facts do not duplicate content or legacy audio projections`() throws {
        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(#"""
        {"role":"user","content":[{"type":"video","url":"media://inbound/clip.mov","mimeType":"video/quicktime"}],
         "MediaPaths":["/private/voice.m4a"],"MediaTypes":["audio/mp4"],"__openclaw":{"media":[
          {"url":"media://inbound/clip.mov","contentType":"video/quicktime"},
          {"url":"media://inbound/voice.m4a","contentType":"audio/mp4","fileName":"voice.m4a"},
          {"url":"media://inbound/voice.m4a","contentType":"audio/mp4","fileName":"voice.m4a"},
          {"url":"file:///private/secret.mov","contentType":"video/quicktime"}
         ]}}
        """#.utf8))
        #expect(message.content.filter(\.isInlineAttachment).count == 2)
        #expect(message.content.filter { $0.mediaKind == .audio }.count == 1)
        #expect(message.content.allSatisfy { $0.fetchableMediaReference != nil })
    }

    @Test func `sent image survives canonical history and transcript cache`() throws {
        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(#"""
        {"role":"user","content":"abcdefgh","__openclaw":{"media":[
            {"url":"media://inbound/66dfc5c5-6ecc-4b29-95d7-448c34e1b2da.jpg",
             "contentType":"image/jpeg","kind":"image","sizeBytes":5775}
        ],"mediaImageLayout":{"slots":[{"kind":"inline","factIndex":0}]}}}
        """#.utf8))
        let image = try #require(message.content.first { $0.mediaKind == .image })
        #expect(image.url == "media://inbound/66dfc5c5-6ecc-4b29-95d7-448c34e1b2da.jpg")
        #expect(image.mimeType == "image/jpeg")
        #expect(image.content == nil)
        let cached = try #require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)
        let restored = try JSONDecoder().decode(OpenClawChatMessage.self, from: JSONEncoder().encode(cached))
        #expect(restored.content.contains { $0.url == image.url })
    }

    @Test func `decodes canonical managed image fields`() throws {
        let message = try JSONDecoder().decode(
            OpenClawChatMessage.self,
            from: Data(
                """
                {
                  "role": "assistant",
                  "content": [{
                    "type": "image",
                    "artifactId": "artifact_managed_image_11111111-1111-4111-8111-111111111111",
                    "url": "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
                    "openUrl": "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
                    "alt": "Chart",
                    "mimeType": "image/png",
                    "width": 1200,
                    "height": 800,
                    "sizeBytes": 2048
                  }]
                }
                """.utf8))

        let image = try #require(message.content.first)
        #expect(image.artifactId == "artifact_managed_image_11111111-1111-4111-8111-111111111111")
        #expect(image.alt == "Chart")
        #expect(image.mimeType == "image/png")
        #expect(image.width == 1200)
        #expect(image.height == 800)
        #expect(image.sizeBytes == 2048)
        #expect(image.isInlineAttachment)
    }

    @Test func `decodes url-only managed video as fetchable inline media`() throws {
        let message = try JSONDecoder().decode(
            OpenClawChatMessage.self,
            from: Data(
                """
                {
                  "role": "assistant",
                  "content": [{
                    "type": "video",
                    "url": "/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full",
                    "mimeType": "video/mp4",
                    "fileName": "demo.mp4",
                    "durationMs": 1250,
                    "playback": "transcode",
                    "width": 1920,
                    "height": 1080
                  }]
                }
                """.utf8))

        let video = try #require(message.content.first)
        #expect(video.artifactId == "artifact_managed_media_22222222-2222-4222-8222-222222222222")
        #expect(video.mediaKind == .video)
        #expect(video.durationSeconds == 1.25)
        #expect(video.playback == .transcode)
        #expect(video.isInlineAttachment)
    }

    @Test(arguments: [
        (OpenClawChatMediaKind.image, "artifact_managed_image_11111111-1111-4111-8111-111111111111", true),
        (OpenClawChatMediaKind.image, "artifact_managed_media_11111111-1111-4111-8111-111111111111", false),
        (OpenClawChatMediaKind.audio, "artifact_managed_media_11111111-1111-4111-8111-111111111111", true),
        (OpenClawChatMediaKind.video, "artifact_managed_media_11111111-1111-4111-8111-111111111111", true),
        (OpenClawChatMediaKind.video, "artifact_managed_image_11111111-1111-4111-8111-111111111111", false),
    ])
    func `routes managed artifact ids only to their media family`(
        kind: OpenClawChatMediaKind,
        artifactID: String,
        expected: Bool)
    {
        #expect(kind.acceptsManagedArtifactID(artifactID) == expected)
    }

    @Test @MainActor func `distinct images never reconcile as the same final message`() {
        let first = Self.message(artifactId: "artifact_managed_image_11111111-1111-4111-8111-111111111111")
        let second = Self.message(artifactId: "artifact_managed_image_22222222-2222-4222-8222-222222222222")

        #expect(
            OpenClawChatViewModel.finalMessageContentFingerprint(for: first) !=
                OpenClawChatViewModel.finalMessageContentFingerprint(for: second))
        #expect(
            OpenClawChatViewModel.messageContentFingerprint(for: first) !=
                OpenClawChatViewModel.messageContentFingerprint(for: second))
    }

    @Test func `derives stable identity for shipped managed image blocks`() throws {
        let message = try JSONDecoder().decode(
            OpenClawChatMessage.self,
            from: Data(
                """
                {
                  "role": "assistant",
                  "content": [{
                    "type": "image",
                    "url": "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
                    "mimeType": "image/png"
                  }]
                }
                """.utf8))

        #expect(
            message.content.first?.artifactId ==
                "artifact_managed_image_11111111-1111-4111-8111-111111111111")
    }

    @Test func `transcript cache preserves references without image bytes`() throws {
        let message = Self.message(
            artifactId: "artifact_managed_image_11111111-1111-4111-8111-111111111111")
        let cached = try #require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)
        let image = try #require(cached.content.first)

        #expect(image.artifactId == message.content.first?.artifactId)
        #expect(image.url == message.content.first?.url)
        #expect(image.content == nil)
    }

    private static func message(artifactId: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant",
            content: [
                OpenClawChatMessageContent(
                    type: "image",
                    text: nil,
                    mimeType: "image/png",
                    fileName: nil,
                    artifactId: artifactId,
                    url: "/api/chat/media/outgoing/main/\(artifactId)/full",
                    content: nil),
            ],
            timestamp: nil)
    }
}
