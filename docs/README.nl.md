# AI Edit Studio

Voorheen Game Trailer Studio. De productnaam is gewijzigd; bestaande projecten,
opslagpaden, `GAME_TRAILER_STUDIO_*`-instellingen en `Start-Game-Trailer-Studio.*`
blijven ongewijzigd werken. CLI en agents accepteren ook een nog draaiende server
met de oude naam. De GitHub-repository is niet hernoemd.

## Director 0.4.1 — van socials tot vlogs en korte films

Bovenop 0.4 (hieronder), dezelfde lokale engine:

- **Langere montages:** tot 20 minuten, 200 shots en 24 bronnen (bronnen tot 2 uur). Voor vlogs,
  devlogs en korte films naast trailers en socials. De WhatsApp-versie blijft ≤ 16 MiB, dus alleen voor korte cuts.
- **Overgangen per shot:** dissolve, door zwart/wit, wipes, schuiven, cirkel, pixels, radiaal (FFmpeg xfade + acrossfade).
  Een overgang overlapt met het vorige shot en maakt de montage zoveel korter; de tijdlijn toont de overlap als marker.
- **Kleur en beeld per shot:** helderheid, contrast, verzadiging, kleurtemperatuur, verscherpen, ruisonderdrukking —
  live benaderd in de monitor, exact in de render. "Kopieer naar alle shots" voor één look.
- **Tekst in beeld:** titelkaarten, lower thirds, grote social-tekst en notities op montagetijd, met in/uit-fade.
  Apart van ondertitels (brontijd). Eigen T-spoor op de tijdlijn.
- **Stilstaande beelden als bron:** PNG/JPG/WebP (60 s virtueel), met uitsnede, zoom en overgangen; het voorstel
  laat ze met rust, jij of je agent plaatst ze.
- **Elke agent kan aansluiten:** naast MCP en CLI nu `GET /api/agent/tools`, `POST /api/agent/call`,
  `POST /api/agent/tools/{naam}` en `GET /api/openapi.json` (OpenAPI 3.1 uit dezelfde schema's).
  Stuur `X-Studio-Client: <naam>` en de editor toont die naam bij elke revisie. Zie [AGENTS.md](../AGENTS.md) (Engels).
- **Project dupliceren** (`studio_duplicate`) voor A/B-versies of een verticale cut naast de master.
- Twintig agent-tools; nieuwe operaties `add_text`, `update_text`, `remove_text`; `set` accepteert overgangen en kleur.

## Director 0.4 — echte tijdlijn, live meemonterende agent

Nieuwe editor (`/`), dezelfde lokale engine. Bestaande projecten openen gewoon; clips krijgen
automatisch een stabiel id. De oude opnameconsole blijft op `/legacy.html`.

**Voor editors**
- Tijdlijn met sporen voor beeld (filmstrip-thumbnails), geluid (waveform), muziek (beatgrid),
  ondertitels en markers. Zoom, passend maken, snappen op knippen/markers/beats.
- Slepen om te verplaatsen, randen slepen voor ripple-trim, Alt+slepen voor slip, mes-gereedschap.
- Sneltoetsen zoals in een NLE: Spatie, J/K/L, I/O, S (knip), Q/W (trim tot kop), Delete (ripple),
  Alt+←/→ (verplaats), M (marker), N (snap), Ctrl+Z/Shift+Z, Ctrl+S, Ctrl+Enter (preview), `?` voor alles.
- Bronmonitor met in/uit-punten; gebruikte stukken zijn gearceerd. Invoegen bij kop (`,`) of achteraan (`.`).
- Live voorvertoning: twee-video-afspeler voor strakke knippen, muziek en voice-over spelen mee,
  look/fades/titel/ondertitels als benadering, 9:16/1:1/4:5-weergave met vervaagde achtergrond.
- Shot-inspector met focuspunt-kiezer die de uitsnede per formaat toont.
- Live kwaliteitscheck (score, hook, jump cuts, flitsshots, zwart beeld, leessnelheid, off-beat) met één-klik-fixes.
- Beat-detectie en "snap knippen op beat"; muziek-startpunt; drie ondertitelstijlen en posities.
- Zes sjablonen (Shorts-hook, gametrailer, YouTube-teaser, devlog, cinematic, feedpost), ook bij het aanmaken.
- Revisiegeschiedenis met auteur, "wat veranderde?" en niet-destructief terugzetten.

**Voor agents** (MCP + CLI + HTTP, 20 tools — zie [agenthandleiding](../AGENT-GUIDE.md))
- `studio_edit`: atomische edit-operaties (split, ripple delete, move, trim, slip, insert, beat_sync, …)
  op stabiele clip-ids, met `dryRun`. Geen hele cliplijst meer opnieuw sturen.
- `studio_timeline` (leesbaar overzicht met energie/loudness/ruimte), `studio_storyboard` (contactsheet als beeld),
  `studio_review` (issues met machine-toepasbare fixes), `studio_highlights`, `studio_beats`,
  `studio_history` / `studio_diff` / `studio_restore`.
- Agentwijzigingen verschijnen live in de open editor met naam en samenvatting. Heeft de editor
  niet-opgeslagen werk, dan kiest de gebruiker; er gaat nooit iets verloren.
- Tabblad **Agent** geeft kant-en-klare configuratie voor Claude Code, MCP-json en terminal.

**Eerlijke grenzen** blijven gelden: geen spraakherkenning, geen gezichtsvolgen, geen generatieve video.
Energie, hook en highlights zijn metingen van beweging, geluid en scènewissels — geen verhaalbegrip.
De browser-voorvertoning benadert look en tekst; de FFmpeg-render is leidend. Bronformaten die de
browser niet afspeelt, kun je nog steeds monteren; bekijk dan de gerenderde preview.
Zie de [changelog](../CHANGELOG.md).

## Director 0.3 — voor editors, creators en hun agents

Eén lokale montagekern, drie ingangen: browsereditor, JSON-CLI en MCP-stdio.
Bouwt verder op de bestaande engine; bestaande projecten blijven bruikbaar.
Voor korte trailers, YouTube-teasers, TikTok/Reels/Shorts en sociale posts.
**Bèta, geen bewezen marktleider of complete vervanger voor een professionele NLE.**

- Montage: splitsen bij de cursor, ongebruikte footage toevoegen, undo/redo,
  bronmontage afspelen, snelheid 0,5–2× en volume per fragment.
- Controle: optionele ononderbroken finale; stiltevoorstellen worden niet
  automatisch opgeslagen; revisiecontrole voorkomt verloren agent/editor-wijzigingen.
- Afwerking: vier instelbare looks, belichting, fades, laagfilter en muziekducking.
  Per-fragmentvolume wordt ná normalisatie toegepast, dus dempen blijft dempen.
- Beeldregie per shot: expliciete uitsnede, statisch focuspunt, zoom 1–2× en
  horizontaal spiegelen. Standaard blijft volledig beeld behouden.
- Audio: losse voice-over met brontrim, startpunt in montage en eigen volume;
  geen ongewenste loop. Links/rechts naar beide oren of mono voor fout opgenomen kanalen.
- Ondertitels: lokale SRT-import, timingcorrectie en automatische herberekening
  bij knippen, volgordewisseling en snelheid. Ingebrand plus losse SRT bij export.
  Geen ingebouwde spraakherkenning: lever eigen transcript/ondertitels aan.
- Hergebruik: één bewaarde look/merk/mix/exportstijl en herstelbare browserconcepten.
- Exports: 1080p, 1440p, 4K, 9:16, 1:1, 4:5 en kleine deelversie. Sociale formaten
  behouden de hele scène tegen een vervaagde achtergrond; geen blinde middencrop.
- Agents: tien tools, echte bronframes als beeldbewijs, gedeelde daemon, JSON-schema's
  en expliciete fouten. Geen modelabonnement of API-key nodig voor de engine.
  Agents kunnen ook frames van een afgeronde export opvragen om hun crop/grade/tekst te beoordelen.

```powershell
node cli.mjs studio schema
node cli.mjs studio list
node cli.mjs studio create --request create.json
node cli.mjs studio get --project PROJECT_UUID
node mcp.mjs
```

De laatste opdracht is een MCP-stdio-server, geen interactieve shell. Een MCP-client
start die als subprocess. Zie [agenthandleiding](../AGENT-GUIDE.md) voor configuratie,
een volledige workflow en een kopieerbare vibe-editopdracht.

**Kwaliteitsgrens (0.3; sinds 0.4.1: 20 minuten, 200 shots, 24 bronnen van maximaal 2 uur):** destijds 120 seconden montage, 48 clips, 12 bronnen van maximaal
één uur. SDR/H.264-uitvoer. Upscaling is Lanczos, geen AI-detailreconstructie.
Langere YouTube-afleveringen, semantische highlightselectie, automatische spraakherkenning,
gezichtsvolgen en publicatie naar platforms zijn nog niet geïmplementeerd.
Een cloudagent kan toolresultaten/gevraagde previewframes ontvangen; zie [privacy](../PRIVACY.md).

De onderstaande 0.2-instructies blijven geldig. Bij een nog draaiende oudere server:
wacht tot actieve renders klaar zijn en herstart Studio. De agentinterface meldt dit
als `RESTART_REQUIRED` en sluit geen werktaak automatisch af.

## Bèta 0.2 — montagevoorstel vóór de eindrender

Lokale Windows-bèta voor indie-gamebouwers. De nieuwe interface biedt een
chronologische vluchtmontage met langere shots en een kortere actiemontage.
Fragmenten zijn te bekijken, in te korten, te verplaatsen, te verwijderen en
naar een andere gekoppelde bron te verwijzen. Projectinstellingen worden lokaal
bewaard; een render start pas wanneer je daar zelf voor kiest.

Dubbelklik `Start-Game-Trailer-Studio.vbs` voor een verborgen serverstart of
gebruik `npm start` met Node 20+. De standaard-URL is nu
http://127.0.0.1:32146/ ; de eerdere 32145-voorbeelden hieronder zijn historisch.
De oorspronkelijke opnameconsole blijft bereikbaar via `/legacy.html`.
Alle bestaande CLI-capture-/montagecommando's blijven beschikbaar; de standaard
poort is eveneens 32146. `GAME_TRAILER_STUDIO_PORT` kan een andere poort kiezen.

### Gebruik

1. Nieuw project: kies/sleep video's of koppel absolute lokale bestandspaden.
   Slepen importeert een werkkopie op de werkdatadrive; paden koppelen zonder kopie.
2. Kies actie of vlucht, doelduur en eventueel begin/einde om over te slaan.
3. Maak het voorstel, bewerk fragmenten en bewaar de wijzigingen.
4. Voeg titel, label, eindtekst, PNG/JPG-logo en toegestane muziek toe.
5. Regel de audiobalans. Bronnen worden vóór de regelaars genormaliseerd;
   dempen blijft echt dempen. Daarna worden pieken begrensd.
6. Bekijk een gerenderde preview en maak vervolgens het promotiepakket.

Exports: 1920x1080/60 breedbeeld, 1080x1920/30 verticaal met de volledige scène
op een vervaagde achtergrond, en 1280x720/30 delen met een gecontroleerde
16-MiB-limiet. De kleine versie gebruikt maximaal 2,4 Mbit/s video. Alle MP4's
worden volledig op video én audio gedecodeerd vóór ze als resultaat verschijnen.
Kleine doelduur of weinig bronbeelden worden niet aangevuld met herhaalde beelden.

### Opslag en andere pc's

Standaard komen projecten en renders in de map die je in de installer koos, anders in
`Documenten\AI Edit Studio` (Windows) of `.studio-data` naast de app (macOS/Linux). Een andere map kiezen:

```powershell
./Start-Game-Trailer-Studio.ps1 -DataRoot 'D:\Game-Trailer-Studio'
```

Voor handmatig starten met Node: stel `GAME_TRAILER_STUDIO_DATA_ROOT` in op de
gekozen absolute map.
FFmpeg en ffprobe worden gezocht in PATH, in tools/ffmpeg/bin onder de app/data-
map of via `FFMPEG_PATH`/`FFPROBE_PATH`. De huidige publieke distributie/installer
is nog niet gereed: Node 20+ en een geschikte FFmpeg-build moeten apart bestaan.
Deze implementatie is getest met FFmpeg 9.0.1; willekeurige oudere builds zijn
niet als compatibel gevalideerd.

### Grenzen en bewijs

Maximaal 12 bronnen, één uur per bron, 120 s per montage en 48 fragmenten.
HDR-invoer wordt expliciet afgewezen totdat tonemapping is gevalideerd. Sommige
bronformaten spelen niet rechtstreeks in de browser, maar een MP4-preview wel.
De planner gebruikt meetbare beeld-/audiosignalen, geen semantisch AI-begrip van
wat in de game belangrijk is. Bekijk en corrigeer dus zelf de selectie.

`node --test` voert de unit-tests uit. `tools/verify-ui.mjs` toetst de eigen app
in een tijdelijk, geïsoleerd browserprofiel. `tools/verify-beta.mjs` test de lokale
API en een echte render met korte audio, muziek, logo en byte-rangeverzoeken.
Tests maken uitsluitend eigen output; resultaten komen niet automatisch in Git.

Zie [privacy](../PRIVACY.md) en [dependency-/publicatiegrens](../THIRD-PARTY-NOTICES.md).

## Historische 0.1-engine en CLI

AI Edit Studio is een lokale Windows-tool die gameplay opneemt per gekozen proces en automatisch de sterkste momenten tot een trailer monteert. De bronbeelden worden alleen gelezen. Grote opnames, analysebestanden, previews en renders blijven in de datamap (zie *Opslag en andere pc's*).

## Starten

Dubbelklik op `Start-Game-Trailer-Studio.cmd`. De lokale server bindt uitsluitend aan `127.0.0.1:32145` en opent de Nederlandstalige interface. Er worden geen beelden naar een cloudservice gestuurd.

Vanaf Codex of een terminal kan dezelfde engine worden aangestuurd met Node.js (24 of nieuwer):

```powershell
node .\cli.mjs doctor
node .\cli.mjs processes bf6 --json
node .\cli.mjs capture start --process bf6.exe --project BF6 --fps 120
node .\cli.mjs capture status
node .\cli.mjs capture stop
```

Een procesnaam moet naar precies één zichtbaar venster verwijzen. Bij meerdere resultaten gebruik je de PID uit `processes`. Een opname wordt als MKV afgerond; daarna kan de laatste opname direct worden gemonteerd:

```powershell
node .\cli.mjs from-last-capture --project BF6 --style air-combat --duration 60 --title 'Air Superiority' --output 'D:\AI-Edit-Studio\exports\bf6-air.mp4'
```

Of monteer bestaande footage:

```powershell
node .\cli.mjs run --input 'D:\Captures\BF6' --project BF6 --style action --duration 60 --output 'D:\AI-Edit-Studio\exports\bf6-trailer.mp4'
```

Met `--no-preview` wordt de snelle 720p-proefversie overgeslagen. Zonder `--output` gebruikt de engine een unieke jobmap in de datamap. Uitvoer wordt nooit stil overschreven. Een volledige decodecontrole moet slagen voordat een trailer als gereed wordt gepubliceerd.

## Opnamegedrag

- Alleen het expliciet gekozen zichtbare procesvenster wordt opgenomen; nooit automatisch het hele bureaublad.
- Gebruik bij voorkeur randloos venster (`borderless windowed`). FFmpeg-windowcapture kan bij exclusief volledig scherm, geminimaliseerde vensters en sommige hardware-overlays een zwart of stilstaand beeld geven.
- De ingebouwde FFmpeg-backend neemt standaard video zonder systeemaudio op. Een ondersteund DirectShow-audioapparaat kan via `--audio-device` worden opgegeven. Voor betrouwbare game- en applicatie-audio is OBS Game Capture de aanbevolen toekomstige backend; OBS wordt door deze tool niet ongemerkt geïnstalleerd.
- Opnames kunnen namen, chatberichten of notificaties uit het gekozen spelvenster bevatten. Bekijk een trailer altijd voordat je hem deelt.

## Automatische selectie

De analyzer meet per bron scèneovergangen, beeldbeweging, audiodynamiek, zwarte stukken en bronkwaliteit. De planner kiest unieke, niet-overlappende fragmenten en dupliceert geen footage om een doelduur kunstmatig te vullen. Beschikbare stijlen zijn `action`, `cinematic`, `gameplay`, `showcase` en `air-combat`.

## Bescherming van projecten

AI Edit Studio scant alleen het pad dat je expliciet als footage opgeeft. Het zoekt niet automatisch in projectmappen. Daardoor worden andere projecten, modellen, renders en ontwikkelwerk niet als footage gebruikt of gewijzigd.

## Ontwikkelcontrole

```powershell
node --test
```

FFmpeg wordt gezocht in PATH, in `tools/ffmpeg/bin` onder de app- of datamap, of via `FFMPEG_PATH`/`FFPROBE_PATH`.
