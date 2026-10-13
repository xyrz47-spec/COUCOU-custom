import SwiftUI

// Settings → JEV: the TypeSafe API key Decide and Twenty questions use (Jev.swift), kept in
// the Keychain like every other key, and whether their tabs show in the island's header.
// The same page as windows/src/settings/jev.ts, with its words. The key is only sent to
// TypeSafe, and only when you press Decide, ask a question or test it here.

struct JevSettingsView: View {
    @ObservedObject private var state = AppState.shared
    @State private var key = ""
    @State private var status = ""
    @State private var problem = ""
    @State private var testing = false

    var body: some View {
        Text(String(localized: "JEV is TypeSafe's model for quick, structured judgements. With a key, the Decide tab ranks the options you list for how you feel, and the Twenty questions tab lets JEV answer your yes/no questions about something Coucou thought of."))
            .font(.system(size: 12))
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)

        GroupBox(String(localized: "TypeSafe API key")) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    SecureField(String(localized: "TypeSafe API key"), text: $key)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(save)
                    Button(String(localized: "Save"), action: save)
                        .buttonStyle(.borderedProminent)
                        .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                HStack(spacing: 8) {
                    Button(String(localized: "Test the key"), action: test)
                        .disabled(!state.jevKeySaved || testing)
                    Button(String(localized: "Remove"), role: .destructive, action: remove)
                        .disabled(!state.jevKeySaved)
                }
                Text(status.isEmpty ? (state.jevKeySaved ? String(localized: "A key is saved.") : String(localized: "No key saved: nothing is sent to TypeSafe.")) : status)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                if !problem.isEmpty {
                    Text(problem)
                        .font(.system(size: 11))
                        .foregroundColor(.red)
                }
            }
            .padding(6)
        }

        GroupBox("JEV") {
            VStack(alignment: .leading, spacing: 8) {
                Toggle(String(localized: "Decide tab"), isOn: $state.decideTabEnabled)
                Toggle(String(localized: "Twenty questions tab"), isOn: $state.twentyTabEnabled)
                Toggle(String(localized: "Pokémon pictures"), isOn: $state.twentyPicturesEnabled)
                    .disabled(!state.jevKeySaved || !state.twentyTabEnabled)
                Text(String(localized: "When the secret is a Pokémon, its official artwork shows as the game ends, fetched then from PokeAPI's pictures on GitHub. Off, nothing is fetched and an emoji of its type shows instead."))
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }

    private func save() {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        KeychainStore.shared.set(Jev.keyName, value: value)
        key = ""
        problem = ""
        status = ""
        state.jevKeySaved = true
    }

    private func remove() {
        KeychainStore.shared.remove(Jev.keyName)
        problem = ""
        status = ""
        state.jevKeySaved = false
    }

    private func test() {
        guard let saved = Jev.key else { return }
        testing = true
        problem = ""
        status = String(localized: "Asking JEV…")
        Task {
            do {
                _ = try await Jev.checkKey(saved)
                status = String(localized: "The key works.")
            } catch {
                status = ""
                problem = error.localizedDescription
            }
            testing = false
        }
    }
}
