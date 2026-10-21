// Appended to the generated controller; never stores file names or paths.
struct IncomingShareFailure {
  var step: String
  var types: [String]
  var error: String?
  // True for an observed destination/container failure. Source-read and
  // unclassified copy errors keep reception-failure wording; storage gets its
  // own feedback (ShareFeedback.saveFailed).
  var storage = false

  static func isStorageError(_ error: Error) -> Bool {
    let error = error as NSError
    guard error.domain == NSCocoaErrorDomain else { return false }
    return [NSFileWriteUnknownError, NSFileWriteNoPermissionError,
      NSFileWriteInvalidFileNameError, NSFileWriteFileExistsError,
      NSFileWriteInapplicableStringEncodingError, NSFileWriteUnsupportedSchemeError,
      NSFileWriteOutOfSpaceError, NSFileWriteVolumeReadOnlyError].contains(error.code)
  }

  var json: Data? {
    var object: [String: Any] = ["step": step, "types": types]
    if let error {
      object["error"] = error
    }
    return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }
}

private extension ShareIntoViewController {
  /// The name a host asks us to use for the item. Only the last path component
  /// is kept, so a provider can never place the copy outside its own directory.
  /// A suggested name without an extension ("Report" for "Report.pdf") keeps the
  /// extension of the source file or of the type identifier, so the attachment
  /// stays openable after upload and download.
  func incomingShareFileName(_ provider: NSItemProvider, fallback: String, extensionHint: String? = nil) -> String {
    guard let suggested = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines),
          !suggested.isEmpty else { return fallback }
    let name = (suggested as NSString).lastPathComponent
    guard !name.isEmpty, name != ".", name != "..", name != "/" else { return fallback }
    guard (name as NSString).pathExtension.isEmpty else { return name }
    let hint = extensionHint ?? (fallback as NSString).pathExtension
    return hint.isEmpty ? name : name + "." + hint
  }

  func recordShareFailure(step: String, types: [String] = [], error: Error? = nil, storage: Bool = false) {
    var failure = shareFailure ?? IncomingShareFailure(step: step, types: [], error: nil)
    // Keep an observed destination failure over an unsupported fallback.
    if failure.storage && !storage { return }
    failure.step = step
    failure.storage = storage
    failure.error = nil
    for type in types where !failure.types.contains(type) {
      failure.types.append(type)
    }
    if let error {
      let error = error as NSError
      failure.error = "\(error.domain):\(error.code)"
    }
    shareFailure = failure
  }

  /// A share that produced no payload still tells the user which half failed:
  /// content that was read but could not be stored keeps the storage wording.
  var shareFailureFeedback: ShareFeedback {
    shareFailure?.storage == true ? .saveFailed : .failed
  }

  /// Best effort: a failed slot write is exactly what leaves no diagnostic
  /// behind, so a missing record is expected and never shown to the user.
  func writeShareDiagnostic() {
    guard let data = shareFailure?.json else { return }
    try? IncomingShareSlot.writeDiagnostic(data, group: appGroupId)
  }
}
