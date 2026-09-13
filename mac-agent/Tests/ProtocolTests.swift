import XCTest
@testable import YaokongtaiAgent

final class ProtocolTests: XCTestCase {
    func testFreshCommandAndExpiry() throws {
        let fresh = RemoteCommand(id: UUID(), protocolVersion: 1, type: "system.volume", payload: .init(value: 0.5), issuedAt: Date(), expiresAt: Date().addingTimeInterval(9), elevationToken: nil)
        XCTAssertTrue(fresh.isFresh)
        let expired = RemoteCommand(id: UUID(), protocolVersion: 1, type: "system.sleep", payload: .init(), issuedAt: Date().addingTimeInterval(-20), expiresAt: Date().addingTimeInterval(-1), elevationToken: "verified")
        XCTAssertFalse(expired.isFresh)
    }

    func testHighImpactRequiresElevation() throws {
        let controller = SystemController()
        let command = RemoteCommand(id: UUID(), protocolVersion: 1, type: "system.sleep", payload: .init(), issuedAt: Date(), expiresAt: Date().addingTimeInterval(9), elevationToken: nil)
        XCTAssertThrowsError(try controller.execute(command)) { error in XCTAssertEqual(error as? AgentError, .permissionDenied) }
    }

    func testArbitraryApplicationPathIsRejectedBeforeExecution() throws {
        let controller = SystemController()
        let command = RemoteCommand(id: UUID(), protocolVersion: 1, type: "app.launch", payload: .init(bundleID: "/Applications/Test.app;rm"), issuedAt: Date(), expiresAt: Date().addingTimeInterval(9), elevationToken: nil)
        XCTAssertThrowsError(try controller.execute(command))
    }
}
