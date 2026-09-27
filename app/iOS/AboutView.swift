import OverAndOutKit
import SwiftUI

/// Settings → About Over&Out: the logo, version, contact and legal lines.
struct AboutView: View {
    @EnvironmentObject private var model: AppModel

    private static let supportEmail = "support@cypressoakstudios.com"

    private var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "Version \(short) (\(build))"
    }

    var body: some View {
        List {
            Group {
                Section {
                    VStack(spacing: 6) {
                        Image("OverAndOutBrand")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 160, height: 160)
                            .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
                            .accessibilityLabel("Over&Out")
                        Text("Watch Walkie Talkie")
                            .font(.title3.weight(.semibold))
                            .padding(.top, 8)
                        Text("for iPhone and Apple Watch")
                            .foregroundStyle(Brand.secondary)
                        Text(version)
                            .font(.footnote)
                            .foregroundStyle(Brand.secondary)
                            .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                Section {
                    Link(destination: URL(string: "mailto:\(Self.supportEmail)")!) {
                        LabeledContent("Contact", value: Self.supportEmail)
                    }
                    Link("overandout.app", destination: URL(string: "https://\(model.linkDomain)")!)
                    Link("Privacy Policy", destination: URL(string: "https://\(model.linkDomain)/privacy")!)
                    Link("Help and Support", destination: URL(string: "https://\(model.linkDomain)/support")!)
                }
                .listRowBackground(Brand.surface)

                Section {
                    // Placeholder until there's an App Store listing; then open its
                    // write-review page (apps.apple.com/app/id<ID>?action=write-review).
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Rate Over&Out", systemImage: "star")
                        Text("Available once Over&Out is on the App Store")
                            .font(.footnote)
                            .foregroundStyle(Brand.secondary)
                    }
                    .foregroundStyle(Brand.secondary)
                    .accessibilityElement(children: .combine)
                }
                .listRowBackground(Brand.surface)

                Section {
                    VStack(spacing: 6) {
                        Text("© 2026 Cypress Oak Studios LLC")
                        Text("Apple Watch and iPhone are trademarks of Apple Inc., registered in the U.S. and other countries and regions.")
                            .multilineTextAlignment(.center)
                    }
                    .font(.footnote)
                    .foregroundStyle(Brand.secondary)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }
        }
        .brandScreen()
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }
}
