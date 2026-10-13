# Privacy

**In short: AI Edit Studio runs on your computer. Your videos are never uploaded.**

- The editor/server only listens on this computer (127.0.0.1). No account, no telemetry, no analytics.
- It only reads the files you choose and never changes or deletes originals. Projects and renders live in the data
  folder you picked during installation.
- **Network use happens only when you ask for it:** the optional speech setup downloads whisper.cpp (GitHub) and a
  model (Hugging Face); optional online music generation sends only your text prompt and the length to ElevenLabs,
  with your own key (stored locally in the data folder, or read from `ELEVENLABS_API_KEY`).
- **AI agents:** if you connect a cloud agent (Claude, OpenAI Codex, the OpenAI API…), that agent's provider receives
  your prompts and the tool results — project paths, settings, transcripts/captions and the preview frames or
  storyboards it asks for — under your own account and that provider's privacy terms. Video and audio files are
  not sent. Use a local agent if even that must stay on your computer.
- The installer writes a small settings file (data folder and install location) and, only for apps you have,
  adds AI Edit Studio to their configuration (with a backup). `node cli.mjs uninstall` removes those entries.
- Check your export before you share it: names or notifications that are in your footage stay visible.

---

# Privacy van de lokale bèta (Nederlands, ontwikkelgeschiedenis)

- Server luistert uitsluitend op een loopbackadres; standaardpoort 32146.
- Geen cloud-AI, accounts, telemetrie, externe fonts of verplichte uploads.
- Het programma leest alleen de video-/audio-/logobestanden die je zelf kiest.
- Een ingevoerd absoluut pad koppelt het bestand zonder het te verplaatsen.
- Drag-and-drop/bestand kiezen maakt één inhoudsgedupliceerde werkkopie in de
  Studio-datamap. De browser stuurt daarvoor bytes naar de lokale server, niet
  naar internet. Het origineel wordt niet gewijzigd.
- Projectbestanden bewaren lokaal gekozen paden, montage, instellingen en
  exportresultaten. Ze horen niet in openbare bugmeldingen of bronrepositories.
- Uitvoer krijgt unieke renderlocaties. Eerdere exports worden niet overschreven.
- Verwijderen of opruimen van originelen is geen functie van deze bèta.
- Het programma scant geen chats, andere projecten, browsergeschiedenis of saves.

## Agentbediening en concepten (0.3)

De CLI en MCP-adapter gebruiken dezelfde lokale server. Er is geen ingebouwd
cloudmodel, geen API-keyopslag en geen automatische publicatie. Een **aangesloten
cloudagent** kan echter de toolresultaten ontvangen: projectpaden, instellingen,
ondertitels en expliciet opgevraagde previewframes. Dat valt onder de privacy- en
bewaarinstellingen van die agentprovider. Gebruik een lokale agent als ook deze
informatie lokaal moet blijven. Deel geen vertrouwelijke beelden met een cloudagent.

De browser bewaart een klein herstelconcept per project en één herbruikbare stijl
in localStorage. Dit bevat montage-instellingen, gekozen paden en eventuele
ondertitels, geen browsegeschiedenis. Herstel vereist bevestiging; een verouderde
projectrevisie wordt niet automatisch overschreven. Een succesvolle projectsave
verwijdert het bijbehorende browserconcept. Browsergegevens wissen verwijdert die
concepten/stijl, niet de projectbestanden. Gebruik op een gedeelde pc een eigen profiel.

Bronframes worden alleen voor geregistreerde projectvideo's gelezen en tot maximaal
24 verschillende JPEG-previewframes per project gecachet. De montage- en MCP-tools
bevatten geen functies om originelen te verwijderen of naar sociale platforms te uploaden.

Bekijk de export voordat je hem zelf deelt: namen, chatberichten en meldingen die
al in je gamebeelden staan kunnen zichtbaar blijven. De tool anonimiseert die niet.
Lokale software en codecs moeten wel bijgewerkt worden; lokaal is niet hetzelfde
als gegarandeerd foutvrij of veilig tegen ieder schadelijk mediabestand.
