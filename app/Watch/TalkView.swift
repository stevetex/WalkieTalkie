import OverAndOutKit
import SwiftUI
import WatchKit

/// Talking to one friend, pushed from the friends list: the mascot fills the screen and its
/// mouth is the Talk button, as on the iPhone, with "Hold to talk" curved inside it while
/// idle. The friend's picture sits under the back button and their name below the mascot
/// (everyone starts with the same mascot picture, so the picture alone may not say who it
/// is), with the connection's glyph. End sits top right during a conversation, away from the
/// mouth. Only this friend shows here: how conversations ended, and a conversation with
/// someone else, show in the friends list.
struct TalkView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount
    let initial: Friend
    /// Presses this soon after the screen opens are ignored: the second tap of a double tap on
    /// the friend's row lands on the mouth, and would end a conversation with someone else.
    @State private var openedAt = Date.distantFuture
    private static let settleTime: TimeInterval = 0.5

    init(controller: ConversationController, account: WatchAccount, friend: Friend) {
        self.controller = controller
        self.account = account
        initial = friend
    }

    /// The latest from the friends list (a new picture, or the real entry for a placeholder).
    private var friend: Friend { account.friends.first { $0.id == initial.id } ?? initial }

    /// This screen's friend is in the conversation (or nobody is).
    private var isCurrent: Bool { controller.peerId == nil || controller.peerId == friend.id }
    private var inConversation: Bool { controller.phase != .idle && controller.peerId == friend.id }

    private var mouthState: MascotTalkButton.MouthState {
        guard isCurrent else { return .idle }
        if controller.phase != .idle && !controller.talkReady { return .waiting }
        if controller.isTalking { return .talking }
        if controller.remoteTalking { return .listening }
        return .idle
    }

    /// Struck through while this friend didn't answer or can't be reached (until you ring
    /// again or they talk); none when idle.
    private var connection: ConnectionGlyph.Status? {
        if let outcome = controller.outcomes[friend.id]?.outcome, outcome.isUnavailable { return .unavailable }
        guard inConversation else { return nil }
        return controller.connected ? .live : .connecting
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                MascotTalkButton(state: mouthState, ringing: false, friendName: friend.name, hint: "Hold to talk") { pressed in
                    // A release without a press is ignored by the controller.
                    guard !pressed || Date().timeIntervalSince(openedAt) >= Self.settleTime else { return }
                    pressed ? controller.talkPressed(to: friend) : controller.talkReleased()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // The antenna rises between the time and End.
                .padding(.top, 8)
                // Clear of the name at top left. Less on 40/41mm screens, where the buttons
                // keep their size but the mascot shrinks: its antenna touched End.
                .offset(x: Self.compactScreen ? 8 : 12)

                statusLine
            }
            // Up under the time and down to the bottom edge, so the mascot is as big as it can be.
            .ignoresSafeArea(edges: [.top, .bottom])

            // Under the back button (the top of the safe area is the bottom of its bar), in
            // the gap beside the mascot's top corner.
            Avatar(friend: friend, size: 32, client: account.client)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(friend.name)
                .accessibilityAddTraits(.isHeader)
                // Centred under the back button.
                .padding(.leading, 13)
                .padding(.top, 2)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Something is always there, so the time doesn't move when a conversation
                // starts or ends.
                if inConversation {
                    Button(role: .destructive) { controller.end() } label: {
                        Image(systemName: "xmark")
                            .foregroundStyle(.white)
                    }
                    .tint(.red)
                    .accessibilityLabel("End conversation with \(friend.name)")
                } else {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityHidden(true)
                }
            }
        }
        .onAppear {
            openedAt = Date()
            // Opens the relay stream now, so a press doesn't wait for it.
            controller.talkScreenShown(friend.id)
        }
        .onDisappear { controller.stopPreparing(for: friend.id) }
    }

    /// Apple Watch SE and Series 4–6 40mm, Series 7–9 41mm: 176 pt wide or less.
    private static let compactScreen = WKInterfaceDevice.current().screenBounds.width <= 176

    private var statusLine: some View {
        HStack(spacing: 4) {
            if let connection {
                ConnectionGlyph(status: connection)
            }
            Text(friend.name)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(Brand.ivory)
        .accessibilityElement(children: .combine)
        .padding(.bottom, 10)
    }
}

/// A ring that arrived while the app is on screen, over whatever screen is showing: the
/// mascot wiggles, the caller at top left, Decline and Answer below, as on the iPhone.
struct IncomingRingView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount
    let ring: Ring

    var body: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                MascotTalkButton(state: .idle, ringing: true, friendName: ring.fromName) { _ in }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                    .padding(.top, 30)
                    // Clear of the caller at top left.
                    .offset(x: 22)
                // Below the mascot, which shrinks to make room. Decline on the left and Answer
                // on the right, as on the iPhone.
                HStack(spacing: 6) {
                    Button("Decline") { controller.declineIncomingRing() }
                        .buttonStyle(.bordered)
                        .tint(.gray)
                    Button("Answer") { controller.answerIncomingRing() }
                        .buttonStyle(.borderedProminent)
                        .tint(Brand.orange)
                        .foregroundStyle(Brand.ink)
                }
                // One line, shrunk if it must: on 40 and 41 mm watches the labels broke into
                // "De-cline" and "An-swer".
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .ignoresSafeArea(edges: [.top, .bottom])

            VStack(alignment: .leading, spacing: 4) {
                if let caller = account.friends.first(where: { $0.id == ring.from }) {
                    Avatar(friend: caller, size: 32, client: account.client)
                }
                Text(ring.fromName)
                    .minimumScaleFactor(0.7)
                Text("is calling")
                    .font(.caption2)
                    .foregroundStyle(Brand.silver)
            }
            .font(.footnote.weight(.semibold))
            .lineLimit(1)
            .foregroundStyle(Brand.ivory)
            .frame(maxWidth: 64, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
    }
}
