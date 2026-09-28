import OverAndOutKit
import SwiftUI

/// Talking to one friend (design decision 2026-09-27): the mascot on indigo, its mouth is
/// hold-to-talk, as on the watch. The friend's photo and name are at the top, with End during
/// a conversation and the friend page (report, block, remove) behind the info button.
struct TalkView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var talk: TalkController
    @EnvironmentObject private var ptt: PushToTalkChannel
    let friend: Friend

    /// This screen's friend is in the conversation (or nobody is).
    private var isCurrent: Bool { talk.peerId == nil || talk.peerId == friend.id }

    private var mouthState: MascotTalkButton.MouthState {
        guard isCurrent else { return .idle }
        if talk.isTalking { return talk.talkReady ? .talking : .waiting }
        if talk.phase != .idle && !talk.talkReady { return .waiting }
        if talk.remoteTalking { return .listening }
        return .idle
    }

    private var statusColor: Color {
        switch mouthState {
        case .talking: return Brand.orange
        case .listening: return .green
        default: return Brand.silver
        }
    }

    private var status: String {
        if let other = talk.peerName, !isCurrent { return "In a conversation with \(other)" }
        if !talk.statusLine.isEmpty { return talk.statusLine }
        return "Hold the mouth to talk to \(friend.name)"
    }

    var body: some View {
        VStack(spacing: 0) {
            MascotTalkButton(state: mouthState, ringing: false, friendName: friend.name) { pressed in
                pressed ? talk.talkPressed(to: friend) : talk.talkReleased()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 40)
            .padding(.vertical, 12)
            Text(status)
                .font(.callout.weight(.semibold))
                .foregroundStyle(statusColor)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.horizontal, 24)
            // Always laid out, so the mascot doesn't move when a conversation starts or ends.
            Button(role: .destructive) { talk.end() } label: {
                Label("End Conversation", systemImage: "xmark")
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .foregroundStyle(.white)
            .opacity(inConversation ? 1 : 0)
            .disabled(!inConversation)
            .accessibilityHidden(!inConversation)
            .padding(.top, 12)
            availabilityNote
                .padding(.top, 8)
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
        .foregroundStyle(Brand.ivory)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarBackground(Brand.indigo, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 8) {
                    Avatar(friend: friend, size: 30, client: model.client)
                    Text(friend.name)
                        .font(.headline)
                        .lineLimit(1)
                }
                .foregroundStyle(Brand.ivory)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                NavigationLink {
                    FriendDetailView(friend: friend)
                } label: {
                    Image(systemName: "info.circle")
                }
                .accessibilityLabel("About \(friend.name)")
            }
        }
        .task { await model.requestMicrophone() }
    }

    private var inConversation: Bool { talk.phase != .idle && isCurrent }

    /// How friends reach this iPhone, when it isn't through the walkie-talkie channel.
    @ViewBuilder
    private var availabilityNote: some View {
        if ptt.isAvailable && !ptt.isJoined {
            Text("Walkie-talkie is off on this iPhone, so friends reach it only while Over&Out is open. Turn it on in Settings.")
                .font(.footnote)
                .foregroundStyle(Brand.silver)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
    }
}

/// A ring over the open relay stream while the app is on screen (in-app mode): the mascot
/// wiggles, with Answer and Decline below it, as on the watch.
struct IncomingRingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var talk: TalkController
    let ring: Ring

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                if let friend = model.friends.first(where: { $0.id == ring.from }) {
                    Avatar(friend: friend, size: 72, client: model.client)
                        .padding(.bottom, 4)
                }
                Text(ring.fromName)
                    .font(.largeTitle.bold())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text("is calling")
                    .font(.title3)
                    .foregroundStyle(Brand.silver)
            }
            .padding(.top, 24)
            MascotTalkButton(state: .idle, ringing: true, friendName: ring.fromName) { _ in }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 64)
                .padding(.vertical, 24)
                .allowsHitTesting(false)
            // Decline on the left and Answer on the right, as for calls (and on the watch).
            HStack(spacing: 16) {
                Button { talk.declineIncomingRing() } label: {
                    Text("Decline").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(Brand.ivory)
                Button { talk.answerIncomingRing() } label: {
                    Text("Answer").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Brand.orange)
                .foregroundStyle(Brand.ink)
            }
            .font(.title3.weight(.semibold))
            .controlSize(.large)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
        .foregroundStyle(Brand.ivory)
    }
}
