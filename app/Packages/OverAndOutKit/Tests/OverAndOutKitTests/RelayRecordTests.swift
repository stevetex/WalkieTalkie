import Foundation
import Testing
@testable import OverAndOutKit

struct RelayRecordTests {
    @Test func encodesTypeLengthAndPayload() {
        let record = RelayRecord.encode(RelayRecord.json, Data("{}".utf8))
        #expect(Array(record) == [1, 0, 0, 0, 2, 0x7B, 0x7D])
    }

    @Test func parsesRecordsSplitAcrossChunks() throws {
        let stream = RelayRecord.encode(RelayRecord.json, Data(#"{"type":"ping"}"#.utf8))
            + RelayRecord.encode(RelayRecord.audio, Data([9, 8, 7]))
        var parser = RelayRecord.Parser()
        var records: [(type: UInt8, payload: Data)] = []
        // One byte at a time, the worst case for a streamed HTTP response.
        for byte in stream {
            records += try parser.push(Data([byte]))
        }
        #expect(records.map(\.type) == [RelayRecord.json, RelayRecord.audio])
        #expect(records[0].payload == Data(#"{"type":"ping"}"#.utf8))
        #expect(records[1].payload == Data([9, 8, 7]))
    }

    @Test func rejectsUnknownRecordTypes() {
        var parser = RelayRecord.Parser()
        #expect(throws: RelayRecord.Parser.ParseError.self) {
            try parser.push(Data([7, 0, 0, 0, 0]))
        }
    }

    @Test func decodesRelayMessages() throws {
        let json = #"{"type":"joined","conversationId":"c1","peer":"alice","replayBursts":1}"#
        let message = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8))
        #expect(message.type == "joined")
        #expect(message.conversationId == "c1")
        #expect(message.replayBursts == 1)
    }
}
