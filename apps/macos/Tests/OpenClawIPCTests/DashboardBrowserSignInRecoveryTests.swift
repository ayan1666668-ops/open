import CryptoKit
import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class DashboardSignInNavigationObserver: NSObject, WKNavigationDelegate {
    let controller: DashboardWindowController
    private var continuation: CheckedContinuation<Void, Error>?

    init(controller: DashboardWindowController) {
        self.controller = controller
    }

    func navigate(_ action: () throws -> Void) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            do {
                try action()
            } catch {
                self.continuation = nil
                continuation.resume(throwing: error)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.controller.webView(webView, didFinish: navigation)
        self.continuation?.resume()
        self.continuation = nil
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        self.controller.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        self.controller.webView(webView, didReceive: challenge, completionHandler: completionHandler)
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        self.continuation?.resume(throwing: error)
        self.continuation = nil
    }
}

@MainActor
struct DashboardBrowserSignInRecoveryTests {
    @Test func `live browser identity sign-in reloads the chat in its own cookie store`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let store = WKWebsiteDataStore.nonPersistent()
        let baseURL = server.url("/control/")
        let auth = DashboardWindowAuth.browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
        let controller = DashboardWindowController(
            url: baseURL,
            auth: auth,
            websiteDataStore: store,
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let observer = DashboardSignInNavigationObserver(controller: controller)
        controller.webView.navigationDelegate = observer
        try await observer.navigate { controller.show(url: baseURL, auth: auth) }
        _ = try await controller.webView.evaluateJavaScript("""
        history.replaceState({}, '', '/control/chat/fixture?view=thread');
        localStorage.setItem('sign-in-draft', 'Keep this unsent draft');
        document.cookie = 'sign-in-fixture=retained; path=/';
        """)
        let chatURL = try #require(controller.webView.url)

        try await observer.navigate {
            controller.reconnectGateway(.primary)
            // The old signed-out-only entry point returns without navigating.
            try #require(controller.webView.isLoading)
        }

        #expect(controller.webView.url == chatURL)
        #expect(controller.dashboardBaseURL == baseURL)
        #expect(controller.webView.configuration.websiteDataStore === store)
        #expect(try await controller.webView.evaluateJavaScript(
            "localStorage.getItem('sign-in-draft')") as? String == "Keep this unsent draft")
        #expect(try await controller.webView.evaluateJavaScript(
            "document.cookie.includes('sign-in-fixture=retained')") as? Bool == true)
    }

    @Test func `saved browser sign-in restores only its account and retires the route with its window`() async throws {
        let tls = try await DashboardTLSFixture()
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity)
        defer { server.stop() }
        func makeSession(subject: String) throws -> GatewayBrowserSession {
            try GatewayBrowserSession(
                origin: server.url(),
                issuer: #require(URL(string: "https://identity.cloudflareaccess.com/")),
                audience: "fixture",
                subject: subject,
                token: "synthetic",
                expiresAt: Date().addingTimeInterval(300))
        }
        let session = try makeSession(subject: "account")
        let otherAccount = try makeSession(subject: "other-account")
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let baseURL = server.url("/control/")
        let auth = DashboardWindowAuth.browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
        let controller = DashboardWindowController(
            url: baseURL,
            auth: auth,
            websiteDataStore: store.dataStore,
            tlsParams: GatewayTLSParams(
                required: true,
                expectedFingerprint: SHA256.hash(data: tls.certificate).map { String(format: "%02x", $0) }.joined(),
                allowTOFU: false,
                storeKey: nil),
            browserSessionLease: store.lease(for: session),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let observer = DashboardSignInNavigationObserver(controller: controller)
        controller.webView.navigationDelegate = observer
        try await observer.navigate { controller.show(url: baseURL, auth: auth) }
        _ = try await controller.webView.evaluateJavaScript(
            "history.replaceState({}, '', '/control/chat/fixture?view=thread')")
        let chatURL = try #require(controller.webView.url)

        // Close synchronously after admission, before the sign-in task can
        // access the profile catalog or start a browser helper.
        controller.reconnectGateway(.profile("fixture"))
        #expect(controller.browserSignInReturnURL(session: session, dashboardURL: baseURL) == chatURL)
        #expect(controller.browserSignInReturnURL(session: otherAccount, dashboardURL: baseURL) == nil)
        #expect(controller.browserSignInReturnURL(session: session, dashboardURL: server.url("/other/")) == nil)
        controller.closeDashboard()
        #expect(controller.browserSignInReturnURL(session: session, dashboardURL: baseURL) == nil)
    }
}
