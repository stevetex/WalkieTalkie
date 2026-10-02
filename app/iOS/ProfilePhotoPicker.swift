import OverAndOutKit
import PhotosUI
import SwiftUI

/// Your picture, with a button that opens the chooser: one of the built-in mascots or a photo
/// of your own (design decisions 2026-09-27 and 2026-09-28). Friends see it in their friend
/// lists, on their Talk screens and on their watch.
struct ProfilePhotoPicker: View {
    @EnvironmentObject private var model: AppModel
    var size: CGFloat = 64
    @State private var choosing = false

    var body: some View {
        HStack(spacing: 16) {
            Button { choosing = true } label: {
                ZStack {
                    Avatar(name: model.displayName, userId: model.session?.userId ?? "",
                           photoVersion: model.photoVersion, avatar: model.avatar, size: size, client: model.client)
                    if model.updatingPhoto { ProgressView().tint(Brand.ivory) }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Your picture")
            Button("Change Picture") { choosing = true }
                .buttonStyle(.bordered)
                .tint(Brand.accent)
                .disabled(model.updatingPhoto)
        }
        .sheet(isPresented: $choosing) {
            PictureChooser()
                .environmentObject(model)
        }
    }

    /// Just the button, under a larger picture (onboarding).
    struct ChangeButton: View {
        @EnvironmentObject private var model: AppModel
        @State private var choosing = false

        var body: some View {
            Button("Choose a Picture") { choosing = true }
                .buttonStyle(.bordered)
                .tint(Brand.accent)
                .font(.title3)
                .disabled(model.updatingPhoto)
                .sheet(isPresented: $choosing) {
                    PictureChooser()
                        .environmentObject(model)
                }
        }
    }
}

/// A grid of the mascots, and your own photo from the photo picker.
struct PictureChooser: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var selection: PhotosPickerItem?

    /// Three across, so each mascot is about 100 pt on the smallest iPhone.
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 16), count: 3)

    /// The mascot shown for you now: your choice, or the default without a photo.
    private var current: Mascot? {
        model.photoVersion != nil ? nil : Mascot(id: model.avatar) ?? .default
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Your photo").font(.headline)
                        HStack(spacing: 12) {
                            // No photo-library permission is needed: the picker runs outside the app.
                            PhotosPicker(selection: $selection, matching: .images) { [hasPhoto = model.photoVersion != nil] in
                                Label(hasPhoto ? "Choose Another Photo" : "Choose a Photo", systemImage: "photo")
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Brand.orange)
                            .foregroundStyle(Brand.ink)
                            if model.photoVersion != nil {
                                Button("Remove Photo", role: .destructive) { Task { await model.removePhoto() } }
                                    .buttonStyle(.bordered)
                                    .tint(.red)
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Or a mascot").font(.headline)
                        LazyVGrid(columns: columns, spacing: 16) {
                            ForEach(Mascot.allCases) { mascot in
                                Button { choose(mascot) } label: { cell(mascot) }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(mascot.name)
                                    .accessibilityAddTraits(mascot == current ? .isSelected : [])
                            }
                        }
                    }
                }
                .padding(20)
            }
            .brandScreen()
            .navigationTitle("Your Picture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .disabled(model.updatingPhoto)
            .overlay { if model.updatingPhoto { ProgressView().controlSize(.large) } }
        }
        .onChange(of: selection) { _, item in
            guard let item else { return }
            selection = nil
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                    model.errorMessage = "That photo couldn't be opened. Try another one."
                    return
                }
                await model.setPhoto(image)
                if model.photoVersion != nil { dismiss() }
            }
        }
    }

    /// The picture alone; its name is only for VoiceOver.
    private func cell(_ mascot: Mascot) -> some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                Image(mascot.imageName)
                    .resizable()
                    .scaledToFill()
            }
            .clipShape(Circle())
            .overlay {
                Circle().stroke(mascot == current ? Brand.orange : .clear, lineWidth: 4)
            }
    }

    private func choose(_ mascot: Mascot) {
        Task {
            await model.setAvatar(mascot)
            dismiss()
        }
    }
}
