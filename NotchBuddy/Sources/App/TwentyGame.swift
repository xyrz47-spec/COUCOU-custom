import Foundation

// Twenty questions on the Mac — the same game as windows/src-tauri/src/twenty.rs, with
// the same lists: twenty_items.txt (what Coucou may think of, named in each interface
// language) and pokemon_facts.txt (what is known of each Pokémon), both bundled from
// windows/src-tauri/src (project.yml), so there is one copy of each.
//
// Coucou draws a secret, never one of the last 60 played; you ask yes/no questions, up
// to twenty, and JEV answers each one; a guess costs a question too, and a right one
// wins. The secret is only shown when the game is over.

struct TwentyItem: Equatable {
    let kind: String
    /// The name in each of TwentyData.langs, English first.
    let names: [String]
    var en: String { names[0] }

    /// The emoji that shows it: its own (twenty_pictures.txt), else its kind's (`@kind` lines there).
    var emoji: String {
        if let own = TwentyData.pictures[en]?.emoji, !own.isEmpty { return own }
        if let ofKind = TwentyData.pictures["@" + kind]?.emoji, !ofKind.isEmpty { return ofKind }
        return "🎲"
    }

    /// A Pokémon's official artwork, in PokeAPI's pictures on GitHub (`@art` in twenty_pictures.txt).
    var artURL: URL? {
        guard let id = TwentyData.pictures[en]?.art, !id.isEmpty, id.allSatisfy({ $0.isASCII && $0.isNumber }),
              let base = TwentyData.pictures["@art"]?.emoji, !base.isEmpty else { return nil }
        return URL(string: base + id + ".png")
    }

    /// The name in `lang`, else the English one.
    func name(_ lang: String) -> String {
        guard let i = TwentyData.langs.firstIndex(of: lang), i < names.count else { return en }
        return names[i]
    }
}

enum TwentyData {
    /// The columns of twenty_items.txt after the kind (twenty.rs LANGS).
    static let langs = ["en", "ko", "zh-Hans", "hi", "es", "ar", "fr", "bn", "pt-BR", "ru", "id"]
    /// The kinds a game may be about, as twenty.rs KINDS, then "any", with their capsules' words.
    static let kinds: [(id: String, label: String)] = [
        ("animal", "An animal"), ("food", "A food"), ("thing", "An object"), ("place", "A place"),
        ("job", "A job"), ("nature", "Something in nature"), ("pokemon", "A Pokémon"), ("character", "A character"),
        ("body", "A body part"), ("activity", "An activity"), ("any", "Anything"),
    ]
    static let total = 20
    static let recentCount = 60

    static let items: [TwentyItem] = {
        guard let url = Bundle.main.url(forResource: "twenty_items", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { line in
            if line.hasPrefix("#") || line.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
            let parts = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == langs.count + 1 else { return nil }
            return TwentyItem(kind: parts[0], names: Array(parts.dropFirst()))
        }
    }()

    static let facts: [String: String] = {
        guard let url = Bundle.main.url(forResource: "pokemon_facts", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
        var out: [String: String] = [:]
        for line in text.split(separator: "\n") {
            guard let bar = line.firstIndex(of: "|") else { continue }
            out[String(line[..<bar]).trimmingCharacters(in: .whitespaces)] = String(line[line.index(after: bar)...]).trimmingCharacters(in: .whitespaces)
        }
        return out
    }()

    /// twenty_pictures.txt: `English | emoji | PokeAPI id` per line.
    static let pictures: [String: (emoji: String, art: String)] = {
        guard let url = Bundle.main.url(forResource: "twenty_pictures", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
        var out: [String: (emoji: String, art: String)] = [:]
        for line in text.split(separator: "\n") where !line.hasPrefix("#") {
            let parts = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count >= 2 else { continue }
            out[parts[0]] = (parts[1], parts.count > 2 ? parts[2] : "")
        }
        return out
    }()

    /// The indexes Coucou may draw for `kind` ("any" for all).
    static func pool(_ kind: String) -> [Int] {
        items.indices.filter { kind == "any" || items[$0].kind == kind }
    }

    /// Letters and digits only, lowercase: "Ice  cream!" and "ice cream" are the same.
    static func normalise(_ text: String) -> String {
        String(text.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
    }

    /// The answer to a question, from JEV's 0–1 (twenty.rs label).
    static func label(_ noul: Double) -> TwentyAnswer {
        switch noul {
        case 0.85...:   return .yes
        case 0.6...:    return .probablyYes
        case _ where noul > 0.4:  return .unsure
        case _ where noul > 0.15: return .probablyNo
        default:        return .no
        }
    }

    static func kindPhrase(_ kind: String) -> String {
        switch kind {
        case "animal":    return "an animal"
        case "food":      return "a food or drink"
        case "thing":     return "an everyday object"
        case "place":     return "a place"
        case "job":       return "a job or a role"
        case "nature":    return "something in nature or the sky"
        case "pokemon":   return "a Pokémon"
        case "character": return "a character from stories, games, cartoons or legends"
        case "body":      return "a part of the human body or something that happens to it"
        default:          return "an activity, game or event"
        }
    }

    /// "ko: 코끼리, fr: éléphant, …": the names in the other languages, so any of them is understood.
    static func otherNames(_ item: TwentyItem) -> String {
        var seen = [item.en]
        var out: [String] = []
        for (lang, name) in zip(langs, item.names).dropFirst() where !seen.contains(name) {
            seen.append(name)
            out.append("\(lang): \(name)")
        }
        return out.joined(separator: ", ")
    }

    static func askBody(_ item: TwentyItem, question: String) -> [String: Any] {
        var state = "A guessing game of twenty questions. The secret is: \(item.en) (\(kindPhrase(item.kind))); its name in other languages: \(otherNames(item)). The player asks a yes/no question about the secret, in any language. Judge it as an expert who knows this subject well, from the facts below when there are any and from general knowledge otherwise. Be decisive: answer true or false, and stay undecided only when the question is ambiguous or nobody could know."
        if item.kind == "pokemon", let facts = facts[item.en] {
            state += "\nFacts about the secret (authoritative): " + facts
        }
        return [
            "state": state,
            "model": Jev.model,
            "questions": ["answer": ["type": "noul", "instructions": "Is this true of the secret? \(question)"]],
        ]
    }

    static func sameBody(_ item: TwentyItem, guess: String) -> [String: Any] {
        [
            "state": "The secret: \(item.en) (\(otherNames(item)))\nThe guess: \(guess)",
            "model": Jev.model,
            "questions": ["same": ["type": "noul", "instructions": "The guess names the same thing as the secret. A translation, a plural or a close synonym counts."]],
        ]
    }

    /// JEV's 0–1 for a question about `item`. Nonisolated: only Sendable values cross.
    static func answer(_ item: TwentyItem, question: String, key: String) async throws -> Double {
        try Jev.noul(try await Jev.call(key: key, body: askBody(item, question: question)), "answer")
    }

    /// Whether JEV takes `guess` for `item` (a translation or a synonym counts).
    static func same(_ item: TwentyItem, guess: String, key: String) async throws -> Bool {
        try Jev.noul(try await Jev.call(key: key, body: sameBody(item, guess: guess)), "same") >= 0.8
    }

    /// A Pokémon's artwork, as twenty.rs twenty_picture gets it: at most 2 MB, and a PNG, else nothing.
    static func artwork(_ url: URL) async -> Data? {
        let limit = 2 * 1024 * 1024
        guard let fetched = try? await URLSession.shared.bytes(from: url) else { return nil }
        let (bytes, response) = fetched
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              response.expectedContentLength <= Int64(limit) else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > limit { return nil }
            }
        } catch {
            return nil
        }
        return data.starts(with: [0x89, 0x50, 0x4E, 0x47]) ? data : nil
    }

    /// The interface language as a code of `langs` (Settings → Language, else the system's).
    static var language: String {
        let code = Bundle.main.preferredLocalizations.first ?? "en"
        if langs.contains(code) { return code }
        let base = code.split(separator: "-").first.map(String.init) ?? code
        if base == "zh" { return "zh-Hans" }
        if base == "pt" { return "pt-BR" }
        return langs.contains(base) ? base : "en"
    }
}

enum TwentyAnswer: Equatable {
    case yes, probablyYes, unsure, probablyNo, no, wrongGuess

    var text: String {
        switch self {
        case .yes:         return String(localized: "Yes")
        case .probablyYes: return String(localized: "Probably yes")
        case .unsure:      return String(localized: "Not sure")
        case .probablyNo:  return String(localized: "Probably not")
        case .no:          return String(localized: "No")
        case .wrongGuess:  return String(localized: "Wrong guess")
        }
    }
}

struct TwentyTurn: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let answer: TwentyAnswer
}

@MainActor
final class TwentyGame: ObservableObject {
    static let shared = TwentyGame()

    enum Phase { case start, play, over }

    @Published private(set) var phase: Phase = .start
    @Published private(set) var kind = "any"
    @Published private(set) var poolSize = 0
    @Published private(set) var asked = 0
    @Published private(set) var turns: [TwentyTurn] = []
    @Published private(set) var won = false
    @Published private(set) var busy = false
    @Published var error = ""
    @Published var guessing = false

    private var secret: Int?
    private var recent: [Int] = []
    /// Which game this is: an answer that comes back after a give-up or a new game is dropped.
    private var round = 0

    /// The secret, once the game is over.
    var revealed: TwentyItem? {
        guard phase == .over, let secret else { return nil }
        return TwentyData.items[secret]
    }

    func newGame(kind: String) {
        error = ""
        guard Jev.key != nil else {
            error = "No TypeSafe API key: add one in Settings → JEV."
            return
        }
        let pool = TwentyData.pool(kind)
        let fresh = pool.filter { !recent.contains($0) }
        guard let pick = (fresh.isEmpty ? pool : fresh).randomElement() else { return }
        recent.append(pick)
        if recent.count > TwentyData.recentCount { recent.removeFirst(recent.count - TwentyData.recentCount) }
        self.kind = kind
        round += 1
        busy = false
        secret = pick
        poolSize = pool.count
        asked = 0
        turns = []
        won = false
        guessing = false
        phase = .play
    }

    func backToStart() {
        round += 1
        busy = false
        phase = .start
        error = ""
    }

    func submit(_ text: String) {
        let text = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(guessing ? 60 : 200))
        guard !text.isEmpty, !busy, phase == .play, let secret, let key = Jev.key else { return }
        let item = TwentyData.items[secret]
        let isGuess = guessing
        let mine = round
        busy = true
        error = ""
        Task {
            do {
                if isGuess {
                    var correct = item.names.contains { TwentyData.normalise($0) == TwentyData.normalise(text) }
                    if !correct {
                        correct = try await TwentyData.same(item, guess: text, key: key)
                    }
                    guard mine == round, phase == .play else { return }
                    spend()
                    if correct {
                        won = true
                        phase = .over
                    } else {
                        turns.append(TwentyTurn(text: text, answer: .wrongGuess))
                    }
                    guessing = false
                } else {
                    let noul = try await TwentyData.answer(item, question: text, key: key)
                    guard mine == round, phase == .play else { return }
                    spend()
                    turns.append(TwentyTurn(text: text, answer: TwentyData.label(noul)))
                }
            } catch {
                guard mine == round else { return }
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    func giveUp() {
        guard phase == .play else { return }
        round += 1
        busy = false
        won = false
        phase = .over
    }

    private func spend() {
        asked += 1
        if asked >= TwentyData.total { phase = .over }
    }
}
