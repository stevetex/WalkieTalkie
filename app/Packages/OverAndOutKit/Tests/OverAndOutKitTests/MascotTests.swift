import XCTest
@testable import OverAndOutKit

final class MascotTests: XCTestCase {
    func testImageNamesMatchTheAssetCatalogs() {
        XCTAssertEqual(Mascot.hiFi.imageName, "MascotHiFi")
        XCTAssertEqual(Mascot.bowLashesCocoa.imageName, "MascotBowLashesCocoa")
        XCTAssertEqual(Mascot.pirate.imageName, "MascotPirate")
        XCTAssertEqual(Mascot.allCases.count, 18)
    }

    func testUnknownOrMissingIDsHaveNoMascot() {
        XCTAssertEqual(Mascot(id: "fox"), .fox)
        XCTAssertEqual(Mascot(id: "pirate"), .pirate)
        XCTAssertNil(Mascot(id: "unicorn"))
        XCTAssertNil(Mascot(id: nil))
    }

    func testFavoritesComeFirstAndKeepTheirOrder() {
        let friends = [
            Friend(id: "a", name: "Ann", since: 0),
            Friend(id: "b", name: "Bea", since: 0, favorite: true),
            Friend(id: "c", name: "Cy", since: 0),
            Friend(id: "d", name: "Di", since: 0, favorite: true),
        ]
        XCTAssertEqual(Friend.favoritesFirst(friends).map(\.id), ["b", "d", "a", "c"])
    }

    func testFriendsDecodeWithoutTheNewFields() throws {
        let friend = try JSONDecoder().decode(Friend.self, from: Data(#"{"id":"u_1","name":"Ann","since":1}"#.utf8))
        XCTAssertFalse(friend.isFavorite)
        XCTAssertNil(friend.lastMessageAt)
        XCTAssertNil(friend.avatar)
    }
}
