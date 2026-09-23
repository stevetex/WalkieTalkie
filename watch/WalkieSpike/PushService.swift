import Foundation
import PushKit

/// VoIP push registration. Every VoIP push must be reported to CallKit as an incoming
/// call before `completion` is called, or watchOS terminates the app and eventually
/// stops delivering VoIP pushes to it.
final class PushService: NSObject, PKPushRegistryDelegate {
    var onToken: ((String) -> Void)?
    var onIncomingPush: ((_ payload: [AnyHashable: Any], _ completion: @escaping () -> Void) -> Void)?

    private(set) var token: String?
    private var registry: PKPushRegistry?

    func start() {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        self.token = token
        onToken?(token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        token = nil
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP, let onIncomingPush else {
            completion()
            return
        }
        onIncomingPush(payload.dictionaryPayload, completion)
    }
}
