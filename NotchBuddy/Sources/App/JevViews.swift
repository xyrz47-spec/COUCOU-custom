import AppKit
import SwiftUI

// The two JEV views of the island (Jev.swift, TwentyGame.swift), laid out like their
// Windows and Linux twins (windows/src/views/decide.ts and twenty.ts, style.css .dc-* and
// .tq-*): Decide in two halves — what you feel and the options on the left, the ranking
// on the right with the best pick on a card of its own; Twenty questions as a game — the
// kinds as capsules of one size, then twenty dots coloured by the answers, the questions
// asked so far and the box to ask in, and at the end the secret on a card of its own.

private enum JevStyle {
    static let ink = Color(hex: "#F5F6F8")
    static let dim = Color(hex: "#9398A1")
    static let card = Color(hex: "#141518")
    static let green = Color(hex: "#22C55E")
    static let red = Color(hex: "#F4505E")
    static let amber = Color(hex: "#F5A524")
    static let indigo = Color(hex: "#6366F1")
    static let cyan = Color(hex: "#22D3EE")
    static let mint = Color(hex: "#34D399")

    static func background(_ a: Color, _ b: Color) -> some View {
        RoundedRectangle(cornerRadius: 20)
            .fill(card)
            .overlay(
                ZStack {
                    RadialGradient(colors: [a.opacity(0.14), .clear], center: .topLeading, startRadius: 0, endRadius: 320)
                    RadialGradient(colors: [b.opacity(0.08), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 320)
                }
                .clipShape(RoundedRectangle(cornerRadius: 20))
            )
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.035), lineWidth: 1))
    }
}

/// A capsule button of the JEV views.
private struct JevButton: View {
    let title: String
    var kind: Kind = .plain
    var disabled = false
    let action: () -> Void
    @State private var hovered = false

    enum Kind { case plain, primary, danger, on }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11.5, weight: kind == .primary ? .semibold : .medium))
                .lineLimit(1)
                .padding(.horizontal, 13)
                .frame(height: 30)
                .foregroundColor(foreground)
                .background(Capsule().fill(background))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .onHover { hovered = $0 }
    }

    private var foreground: Color {
        if disabled { return JevStyle.dim }
        switch kind {
        case .primary: return .white
        case .danger:  return hovered ? JevStyle.red : JevStyle.ink
        case .on:      return JevStyle.amber
        case .plain:   return JevStyle.ink
        }
    }

    private var background: Color {
        if disabled { return Color.white.opacity(0.1) }
        switch kind {
        case .primary: return hovered ? Color(hex: "#7C7FF5") : JevStyle.indigo
        case .danger:  return hovered ? JevStyle.red.opacity(0.2) : Color.white.opacity(0.08)
        case .on:      return JevStyle.amber.opacity(0.22)
        case .plain:   return Color.white.opacity(hovered ? 0.16 : 0.08)
        }
    }
}

// MARK: - Decide

/// The presets of the options box (windows/src/core/jev.ts PRESETS), English keys localized at use.
private let decidePresets: [(label: String, options: [String])] = [
    ("Meal", ["Rice dish", "Noodles", "Soup", "Salad", "Sandwich", "Pizza", "Sushi", "Fried chicken"]),
    ("Drink", ["Coffee", "Tea", "Water", "Juice", "Milk"]),
    ("Activity", ["Go for a walk", "Take a nap", "Read", "Watch a movie", "Work out", "Call a friend"]),
]

struct DecideIslandView: View {
    @ObservedObject var state: AppState
    @State private var feeling = ""
    @State private var options = ""
    @State private var decision: Jev.Decision?
    @State private var busy = false
    @State private var error = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            form.frame(width: 250)
            result.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JevStyle.background(JevStyle.cyan, JevStyle.mint))
        .onChange(of: state.view) { _, view in
            // The feeling is never kept once the view is left.
            if view != .decide { feeling = ""; decision = nil; error = "" }
            else { focused = true }
        }
    }

    private var form: some View {
        VStack(spacing: 7) {
            TextField(String(localized: "How do you feel? (tired, want something warm…)"), text: $feeling)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundColor(JevStyle.ink)
                .focused($focused)
                .onSubmit { run() }
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.1), lineWidth: 1))

            ZStack(alignment: .topLeading) {
                TextEditor(text: $options)
                    .font(.system(size: 12))
                    .foregroundColor(JevStyle.ink)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 6).padding(.vertical, 4)
                if options.isEmpty {
                    Text(String(localized: "Options, one per line"))
                        .font(.system(size: 12))
                        .foregroundColor(JevStyle.dim)
                        .padding(.horizontal, 11).padding(.vertical, 6)
                        .allowsHitTesting(false)
                }
            }
            .frame(maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.1), lineWidth: 1))

            HStack(spacing: 6) {
                ForEach(decidePresets.indices, id: \.self) { index in
                    let preset = decidePresets[index]
                    Button {
                        options = preset.options.map { NSLocalizedString($0, comment: "") }.joined(separator: "\n")
                        decision = nil
                    } label: {
                        Text(NSLocalizedString(preset.label, comment: ""))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(JevStyle.ink)
                            .frame(maxWidth: .infinity)
                            .frame(height: 26)
                            .background(Capsule().fill(Color.white.opacity(0.06)))
                            .overlay(Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }

            Button(action: run) {
                Text(busy ? String(localized: "Asking JEV…") : String(localized: "Decide"))
                    .font(.system(size: 12.5, weight: .bold))
                    .foregroundColor(busy ? JevStyle.dim : Color(hex: "#06281F"))
                    .frame(maxWidth: .infinity)
                    .frame(height: 34)
                    .background(
                        Capsule().fill(busy
                            ? AnyShapeStyle(Color.white.opacity(0.1))
                            : AnyShapeStyle(LinearGradient(colors: [JevStyle.cyan, JevStyle.mint], startPoint: .leading, endPoint: .trailing)))
                    )
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(busy)

            if !error.isEmpty {
                Text(error)
                    .font(.system(size: 10.5))
                    .foregroundColor(JevStyle.red)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder private var result: some View {
        if let decision, let best = decision.ranking.first {
            let top = max(best.share, 0.0001)
            ScrollView(showsIndicators: false) {
                VStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(String(localized: "Best pick").uppercased())
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundColor(Color(hex: "#A5F3FC"))
                        HStack(alignment: .firstTextBaseline) {
                            Text(best.option)
                                .font(.system(size: 22, weight: .bold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            Text(percent(best.share))
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(Color(hex: "#6EE7B7"))
                        }
                        bar(1, height: 6, fill: LinearGradient(colors: [JevStyle.cyan, JevStyle.mint], startPoint: .leading, endPoint: .trailing))
                            .padding(.top, 4)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 14)
                            .fill(LinearGradient(colors: [JevStyle.cyan.opacity(0.24), JevStyle.mint.opacity(0.16)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    )
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.08), lineWidth: 1))

                    ForEach(Array(decision.ranking.dropFirst().enumerated()), id: \.offset) { index, row in
                        HStack(spacing: 9) {
                            Text(verbatim: "\(index + 2)")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(JevStyle.ink)
                                .frame(width: 18, height: 18)
                                .background(Circle().fill(Color.white.opacity(0.1)))
                            Text(row.option)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(JevStyle.ink)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            bar(row.share / top, height: 4, fill: Color.white.opacity(0.45))
                                .frame(width: 90)
                            Text(percent(row.share))
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(JevStyle.dim)
                                .frame(width: 36, alignment: .trailing)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.04)))
                    }

                    if decision.confidence < 0.5 {
                        Text(String(localized: "JEV is not very sure: the first ones are close."))
                            .font(.system(size: 10.5))
                            .foregroundColor(JevStyle.amber)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        } else {
            Text(busy ? String(localized: "Asking JEV…") : String(localized: "List a few options and press Decide: JEV ranks them for how you feel."))
                .font(.system(size: 12))
                .foregroundColor(JevStyle.dim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func bar(_ fraction: Double, height: CGFloat, fill: some ShapeStyle) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.1))
                Capsule().fill(fill).frame(width: geo.size.width * min(1, max(0, fraction)))
            }
        }
        .frame(height: height)
    }

    private func percent(_ share: Double) -> String {
        "\(Int((min(1, max(0, share)) * 100).rounded()))%"
    }

    private func run() {
        guard !busy else { return }
        let chosen = Jev.parseOptions(options)
        guard chosen.count >= Jev.minOptions else {
            error = String(localized: "Give at least 2 different options.")
            decision = nil
            return
        }
        SoundEngine.shared.play("blip")
        busy = true
        error = ""
        let feeling = self.feeling
        Task {
            do {
                decision = try await Jev.decide(feeling: feeling, options: chosen)
            } catch {
                decision = nil
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Twenty questions

struct TwentyIslandView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var game = TwentyGame.shared
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 8) {
            if game.phase == .start { start } else { play }
            if !game.error.isEmpty {
                Text(game.error)
                    .font(.system(size: 10.5))
                    .foregroundColor(JevStyle.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JevStyle.background(JevStyle.indigo, Color(hex: "#F472B6")))
        .onChange(of: state.view) { _, view in if view == .twenty { focused = true } }
    }

    private var start: some View {
        VStack(spacing: 12) {
            Text(String(localized: "I am thinking of something. What kind?"))
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(JevStyle.ink)
                .multilineTextAlignment(.center)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(104), spacing: 7), count: 4), spacing: 7) {
                ForEach(TwentyData.kinds.indices, id: \.self) { index in
                    let kind = TwentyData.kinds[index]
                    KindCapsule(title: NSLocalizedString(kind.label, comment: "")) {
                        SoundEngine.shared.play("blip")
                        text = ""
                        game.newGame(kind: kind.id)
                        focused = true
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var play: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Text(NSLocalizedString(TwentyData.kinds.first { $0.id == game.kind }?.label ?? "Anything", comment: ""))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Color(hex: "#C7D2FE"))
                    .padding(.horizontal, 10).padding(.vertical, 3)
                    .background(Capsule().fill(JevStyle.indigo.opacity(0.25)))
                Text(String(localized: "I am thinking of one of \(game.poolSize.formatted()) things."))
                    .font(.system(size: 10.5))
                    .foregroundColor(JevStyle.dim)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if game.phase == .play {
                    Text(String(localized: "Question \(min(game.asked + 1, TwentyData.total)) of \(TwentyData.total)"))
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(JevStyle.ink)
                }
            }

            HStack(spacing: 4) {
                ForEach(0..<TwentyData.total, id: \.self) { i in
                    Capsule()
                        .fill(dotColor(i))
                        .frame(height: 6)
                }
            }

            if game.phase == .over { reveal }

            ScrollView(showsIndicators: false) {
                VStack(spacing: 4) {
                    ForEach(game.turns.reversed()) { turn in
                        HStack(spacing: 8) {
                            Text(turn.text)
                                .font(.system(size: 11.5))
                                .foregroundColor(JevStyle.ink)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(turn.answer.text)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(answerColor(turn.answer))
                                .padding(.horizontal, 9).padding(.vertical, 2)
                                .background(Capsule().fill(answerColor(turn.answer).opacity(0.16)))
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.04)))
                    }
                }
            }
            .frame(maxHeight: .infinity)

            if game.phase == .play {
                HStack(spacing: 6) {
                    TextField(game.guessing ? String(localized: "What is it?") : String(localized: "Ask a yes/no question…"), text: $text)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .foregroundColor(JevStyle.ink)
                        .focused($focused)
                        .onSubmit(send)
                        .padding(.horizontal, 12)
                        .frame(height: 30)
                        .background(Capsule().fill(Color.white.opacity(0.05)))
                        .overlay(Capsule().stroke(game.guessing ? JevStyle.amber.opacity(0.7) : JevStyle.indigo.opacity(focused ? 0.7 : 0.25), lineWidth: 1))
                    JevButton(title: game.busy ? String(localized: "Asking JEV…") : game.guessing ? String(localized: "Guess") : String(localized: "Ask"),
                              kind: .primary, disabled: game.busy, action: send)
                    JevButton(title: game.guessing ? String(localized: "Back to questions") : String(localized: "I know it!"),
                              kind: game.guessing ? .on : .plain) {
                        game.guessing.toggle()
                        focused = true
                    }
                    JevButton(title: String(localized: "Give up"), kind: .danger) { game.giveUp() }
                }
            }
        }
    }

    @ViewBuilder private var reveal: some View {
        if let secret = game.revealed {
            let name = secret.name(TwentyData.language)
            HStack(spacing: 14) {
                TwentyPicture(item: secret, artwork: state.twentyPicturesEnabled)
                VStack(alignment: .leading, spacing: 1) {
                    Text(game.won ? String(localized: "You got it in \(game.asked) questions!") : String(localized: "Better luck next time."))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(JevStyle.ink.opacity(0.85))
                    Text(name)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    if name != secret.en {
                        Text(secret.en)
                            .font(.system(size: 11))
                            .foregroundColor(JevStyle.dim)
                    }
                }
                Spacer(minLength: 8)
                JevButton(title: String(localized: "New game"), kind: .primary) { game.backToStart() }
            }
            .padding(.leading, 10).padding(.trailing, 16).padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 14).fill(LinearGradient(
                    colors: game.won ? [JevStyle.green.opacity(0.3), JevStyle.cyan.opacity(0.14)] : [JevStyle.indigo.opacity(0.28), Color(hex: "#F472B6").opacity(0.16)],
                    startPoint: .topLeading, endPoint: .bottomTrailing))
            )
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.08), lineWidth: 1))
        }
    }

    private func send() {
        let question = text
        guard !question.trimmingCharacters(in: .whitespaces).isEmpty, !game.busy else { return }
        SoundEngine.shared.play("blip")
        game.submit(question)
        text = ""
    }

    private func dotColor(_ i: Int) -> Color {
        if i < game.turns.count { return answerColor(game.turns[i].answer).opacity(isSoft(game.turns[i].answer) ? 0.55 : 1) }
        if game.phase == .play && i == game.asked { return Color.white.opacity(0.45) }
        return Color.white.opacity(0.08)
    }

    private func isSoft(_ answer: TwentyAnswer) -> Bool { answer == .probablyYes || answer == .probablyNo }

    private func answerColor(_ answer: TwentyAnswer) -> Color {
        switch answer {
        case .yes, .probablyYes: return JevStyle.green
        case .no, .probablyNo:   return JevStyle.red
        case .unsure:            return JevStyle.dim
        case .wrongGuess:        return JevStyle.amber
        }
    }
}

/// The secret's picture on the reveal card: its emoji, or a Pokémon's artwork once it has loaded
/// (TwentyData.artwork: at most 2 MB, and a PNG, like twenty.rs on Windows and Linux).
private struct TwentyPicture: View {
    let item: TwentyItem
    let artwork: Bool
    @State private var shown = false
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.08))
            if let image {
                Image(nsImage: image).resizable().scaledToFit().shadow(color: .black.opacity(0.45), radius: 5, y: 4)
            } else {
                Text(item.emoji).font(.system(size: 44))
            }
        }
        .frame(width: 76, height: 76)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .scaleEffect(shown ? 1 : 0.6)
        .opacity(shown ? 1 : 0)
        .onAppear { withAnimation(.spring(response: 0.45, dampingFraction: 0.6)) { shown = true } }
        .task(id: item.en) {
            image = nil
            guard artwork, let url = item.artURL, let data = await TwentyData.artwork(url) else { return }
            image = NSImage(data: data)
        }
    }
}

/// A kind to pick: a capsule 2.4 wide for 1 high, all the same size, the label centred.
private struct KindCapsule: View {
    let title: String
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(Color(hex: "#F1F2F4"))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 8)
                .frame(width: 104, height: 104 / 2.4)
                .background(Capsule().fill(hovered ? JevStyle.indigo.opacity(0.28) : Color.white.opacity(0.06)))
                .overlay(Capsule().stroke(hovered ? Color(hex: "#818CF8").opacity(0.6) : Color.white.opacity(0.08), lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}
