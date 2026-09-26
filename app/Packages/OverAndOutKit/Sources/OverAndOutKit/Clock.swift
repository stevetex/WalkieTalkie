import Foundation

/// Wall-clock time in the unit the relay's timelines use.
public enum Clock {
    /// Milliseconds since 1970.
    public static func nowMs() -> Double {
        Date().timeIntervalSince1970 * 1000
    }
}
