# Dependencies en publicatiegrens

AI Edit Studio start FFmpeg en ffprobe als afzonderlijke lokale processen.
Het Node-project gebruikt voor de productcode alleen ingebouwde Node-modules.
Playwright is uitsluitend een ontwikkeltestdependency, geen runtimevereiste.

De op deze ontwikkel-pc aangetroffen FFmpeg is 9.0.1 van Gyan, geconfigureerd met
`--enable-gpl --enable-version3` en onder andere libx264. Die build mag niet als
eigen proprietary code of als LGPL-only build worden gepresenteerd.
Bron: https://ffmpeg.org/legal.html en de lokale `ffmpeg -version`-uitvoer.

Deze bèta-bronrepository bevat GEEN FFmpeg-/Node-binaries, externe fonts,
muziek, gameplayvideo's, GPU-modellen of persoonlijke browserprofielen. FFmpeg
moet nu apart aanwezig zijn. Voordat een zelfvoorzienend publiek Windowspakket
wordt verspreid, moeten de exacte dependency-builds, bijbehorende bronnen,
licentieteksten en eventuele distributieverplichtingen worden gecontroleerd.
Dit bestand is een technische inventaris, geen juridische goedkeuring.

Op Windows gebruikt de renderer optioneel het aanwezige Segoe UI-font van het
besturingssysteem. Het fontbestand wordt niet meegeleverd. Eigen demo-muziek
en gameplay staan alleen in de lokale werkdatamap en zijn niet in Git opgenomen.

Eigen bronrepository: privé. Er wordt met deze commit geen open-sourcelicentie
verleend op het oorspronkelijke project. Rechten van dependencies en andere
makers blijven ongewijzigd. Een toekomstige gratis proefversie is een afzonderlijk
distributieproduct; een openbare download is niet hetzelfde als een publieke Git-repo.
