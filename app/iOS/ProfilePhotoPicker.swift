import OverAndOutKit
import PhotosUI
import SwiftUI

/// Your profile photo, with Add or Change (the photo picker) and Remove. Friends see it in
/// their friend lists and on their watch (design decision 2026-09-27).
struct ProfilePhotoPicker: View {
    @EnvironmentObject private var model: AppModel
    var size: CGFloat = 64
    @State private var selection: PhotosPickerItem?

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                Avatar(name: model.displayName, userId: model.session?.userId ?? "",
                       photoVersion: model.photoVersion, size: size, client: model.client)
                if model.updatingPhoto { ProgressView() }
            }
            VStack(alignment: .leading, spacing: 8) {
                // No photo-library permission is needed: the picker runs outside the app.
                PhotosPicker(selection: $selection, matching: .images) {
                    Text(model.photoVersion == nil ? "Add Photo" : "Change Photo")
                }
                if model.photoVersion != nil {
                    Button("Remove Photo", role: .destructive) { Task { await model.removePhoto() } }
                        .foregroundStyle(.red)
                }
            }
            .buttonStyle(.borderless)
            .disabled(model.updatingPhoto)
        }
        .onChange(of: selection) { item in
            guard let item else { return }
            selection = nil
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                    model.errorMessage = "That photo couldn't be opened. Try another one."
                    return
                }
                await model.setPhoto(image)
            }
        }
    }
}
