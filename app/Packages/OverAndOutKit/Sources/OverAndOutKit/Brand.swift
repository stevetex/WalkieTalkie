import SwiftUI

/// Shared semantic colors; each app supplies matching light/dark asset colors.
public enum Brand {
    public static let background = Color("BrandBackground")
    public static let surface = Color("BrandSurface")
    public static let primary = Color("BrandPrimary")
    public static let secondary = Color("BrandSecondary")
    public static let accent = Color("BrandAccent")
    public static let indigo = Color(red: 39 / 255, green: 45 / 255, blue: 80 / 255)
    /// The background baked into the OverAndOutBrand art, a shade off `indigo`. Use it
    /// behind that image so there's no visible seam around it.
    public static let artIndigo = Color(red: 37 / 255, green: 42 / 255, blue: 81 / 255)
    public static let ivory = Color(red: 255 / 255, green: 246 / 255, blue: 223 / 255)
    public static let ink = Color(red: 16 / 255, green: 22 / 255, blue: 27 / 255)
    public static let orange = Color(red: 255 / 255, green: 139 / 255, blue: 26 / 255)
    public static let silver = Color(red: 190 / 255, green: 213 / 255, blue: 223 / 255)
}

public extension View {
    /// Apply to each scrollable destination as well as the root so sheets and pushed
    /// screens keep the same surface instead of reverting to the system list background.
    func brandScreen() -> some View {
        self
            .foregroundStyle(Brand.primary)
            .tint(Brand.accent)
            .scrollContentBackground(.hidden)
            .background(Brand.background.ignoresSafeArea())
            .modifier(SystemToolbarScheme())
    }
}

/// The navigation bar (and status bar) follow the system's light or dark appearance, so a
/// screen pushed from an indigo one (whose bar is dark) doesn't keep light text on ivory.
private struct SystemToolbarScheme: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        #if os(iOS)
        // The scheme applies only with a visible bar background.
        content
            .toolbarColorScheme(colorScheme, for: .navigationBar)
            .toolbarBackground(Brand.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        #else
        content
        #endif
    }
}
