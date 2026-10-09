import OverAndOutKit
import SwiftUI

/// Settings → Report a Problem (the Beta telemetry spec): a note, and by default this iPhone's
/// and the watch's diagnostics logs, so a problem can be looked into without asking for details.
struct ReportProblemView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var includeDiagnostics = true
    @State private var sending = false
    @State private var sent = false
    @FocusState private var editing: Bool

    var body: some View {
        Form {
            Group {
                if sent {
                    Section {
                        Label("Thanks. We'll look into it.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(Brand.primary)
                    } footer: {
                        Text(includeDiagnostics ? "Your iPhone sent its diagnostics log; your watch sends its own the next time Nowza opens there." : "")
                    }
                } else {
                    Section {
                        TextField("What happened, and roughly when?", text: $note, axis: .vertical)
                            .lineLimit(4...10)
                            .focused($editing)
                    } header: {
                        Text("What went wrong")
                    }
                    Section {
                        Toggle("Include Diagnostics", isOn: $includeDiagnostics)
                    } footer: {
                        Text("Diagnostics are when rings and conversations started, connected and ended, and any errors, from this iPhone and your watch. No audio, and no names.")
                    }
                    Section {
                        Button(sending ? "Sending…" : "Send") { send() }
                            .disabled(sending || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        .navigationTitle("Report a Problem")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { editing = true }
    }

    private func send() {
        sending = true
        Task {
            if await model.reportProblem(note: note.trimmingCharacters(in: .whitespacesAndNewlines), diagnostics: includeDiagnostics) {
                sent = true
            }
            sending = false
        }
    }
}
