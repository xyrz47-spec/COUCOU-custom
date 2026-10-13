import Foundation

// JEV (TypeSafe's System One model) — the Mac side of what windows/src-tauri/src/jev.rs
// and twenty.rs do on Windows and Linux: Decide ranks the options a person types for
// how they feel, and Twenty questions answers yes/no questions about a secret.
//
// It needs a TypeSafe API key (Settings → JEV, in the Keychain, never on disk). Without
// one nothing is sent. What is sent is what the person typed, and only when they press
// Decide or ask a question; Twenty questions also sends the secret's names and, for a
// Pokémon, its facts (pokemon_facts.txt).
//
// The API: POST https://api.typesafe.ai/v1/systemone with a Bearer key, a `state` and
// typed `questions` (docs.typesafe.ai).

enum Jev {
    static let keyName = "typesafe-api-key"
    static let model = "jev-latest"
    private static let endpoint = URL(string: "https://api.typesafe.ai/v1/systemone")!

    static let minOptions = 2
    static let maxOptions = 10
    private static let maxOptionChars = 60
    private static let maxFeelingChars = 200

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static var key: String? {
        guard let k = KeychainStore.shared.get(keyName), !k.isEmpty else { return nil }
        return k
    }

    // MARK: - Call

    /// One call to JEV with `body`; the whole response.
    static func call(key: String, body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: endpoint, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure(message: error.localizedDescription)
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw Failure(message: statusMessage(http.statusCode))
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(message: "Bad answer from TypeSafe.")
        }
        return json
    }

    static func statusMessage(_ status: Int) -> String {
        switch status {
        case 401, 403: return "TypeSafe refused the API key."
        case 402:      return "The TypeSafe account has no credit left."
        case 429:      return "TypeSafe says too many requests: try again in a moment."
        default:       return "TypeSafe: \(status)"
        }
    }

    /// Asks JEV one harmless question with `key`: the model's name, or why it did not work.
    static func checkKey(_ key: String) async throws -> String {
        let body: [String: Any] = [
            "state": "Hello!",
            "model": model,
            "questions": ["friendly": ["type": "noul", "instructions": "The message is friendly."]],
        ]
        let response = try await call(key: key, body: body)
        return response["model"] as? String ?? model
    }

    // MARK: - Decide

    struct Ranked: Equatable {
        let option: String
        /// 0 to 1: JEV's probability for this option.
        let share: Double
    }

    struct Decision: Equatable {
        /// Best first.
        let ranking: [Ranked]
        /// 0 to 1: how sure JEV is of the first.
        let confidence: Double
    }

    /// The options in a box: one per line or separated by commas, each once, trimmed, at most maxOptions.
    static func parseOptions(_ text: String) -> [String] {
        var out: [String] = []
        let separators = CharacterSet(charactersIn: "\n,，、;")
        for part in text.components(separatedBy: separators) {
            let option = String(part.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxOptionChars))
            if !option.isEmpty && !out.contains(where: { $0.lowercased() == option.lowercased() }) {
                out.append(option)
            }
        }
        return Array(out.prefix(maxOptions))
    }

    static func decideBody(feeling: String, options: [String]) -> [String: Any] {
        let feeling = String(feeling.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxFeelingChars))
        let state = feeling.isEmpty
            ? "The person has no particular preference right now."
            : "What the person feels like right now: \(feeling)"
        var criteria: [String: String] = [:]
        for (n, option) in options.enumerated() { criteria["o\(n + 1)"] = option }
        return [
            "state": state,
            "model": model,
            "questions": ["pick": [
                "type": "choice",
                "instructions": "Which option suits the person best right now",
                "criteria": criteria,
            ]],
        ]
    }

    static func decision(from response: [String: Any], options: [String]) throws -> Decision {
        guard let pick = (response["answers"] as? [String: Any])?["pick"] as? [String: Any],
              let probabilities = pick["probabilities"] as? [String: Any] else {
            throw Failure(message: "Bad answer from TypeSafe.")
        }
        var ranking = options.enumerated().map { n, option in
            Ranked(option: option, share: min(1, max(0, (probabilities["o\(n + 1)"] as? NSNumber)?.doubleValue ?? 0)))
        }
        guard ranking.contains(where: { $0.share > 0 }) else { throw Failure(message: "Bad answer from TypeSafe.") }
        // Best first; options rated the same stay in the order they were typed.
        ranking = ranking.enumerated().sorted { a, b in
            a.element.share != b.element.share ? a.element.share > b.element.share : a.offset < b.offset
        }.map(\.element)
        let confidence = min(1, max(0, (pick["confidence"] as? NSNumber)?.doubleValue ?? 0))
        return Decision(ranking: ranking, confidence: confidence)
    }

    /// Which option suits the person best. Asked only when the person presses Decide.
    static func decide(feeling: String, options: [String]) async throws -> Decision {
        guard options.count >= minOptions else { throw Failure(message: String(localized: "Give at least 2 different options.")) }
        guard let key else { throw Failure(message: "No TypeSafe API key: add one in Settings → JEV.") }
        return try decision(from: try await call(key: key, body: decideBody(feeling: feeling, options: options)), options: options)
    }

    /// 0 to 1 from a Noul answer named `name`.
    static func noul(_ response: [String: Any], _ name: String) throws -> Double {
        guard let answer = (response["answers"] as? [String: Any])?[name] as? [String: Any],
              let value = (answer["noul"] as? NSNumber)?.doubleValue, value.isFinite else {
            throw Failure(message: "Bad answer from TypeSafe.")
        }
        return min(1, max(0, value))
    }
}
