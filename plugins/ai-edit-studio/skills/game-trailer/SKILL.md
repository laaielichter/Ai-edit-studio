---
name: game-trailer
description: Make a game trailer, teaser or Steam/YouTube devlog clip from gameplay captures with AI Edit Studio — gameplay hook in the first seconds, build-up, beat-synced action, title and wishlist call to action, 1440p + 9:16 + WhatsApp versions, QC and store-ready stills. Use for indie game marketing, Steam pages, announcement and launch trailers.
---

# Game trailer

What works on store pages and feeds: **gameplay in the first 2 seconds** (no studio logos first), one clear fantasy
("you fly rescue missions through a storm"), escalation, a hard cut to the title, and one call to action.

1. `studio_create {name, inputs:[captures…], template:"game-trailer", options:{title:"<Game>", label:"PRE-ALPHA"?, endTitle:"Wishlist on Steam"}}`.
   Keep the label honest (pre-alpha/early access footage).
2. Music: their track, or `studio_music {style:"cinematic", mood:"epic", drops:"auto", ending:"hit"}` — or
   `"synthwave"`/`"trap"` for arcade games. Mark the moment of the biggest action with a marker named `drop`.
3. `studio_auto_edit {projectId, platform:"trailer", title, cta:"Wishlist now", music?, preview:true, queue:true}`
   — or `studio_recipe {action:"run", name:"game-trailer", projectId, inputs:{title, cta:"Wishlist now"}}`.
4. Storyboard + frames. Fix: opening shot must be the most spectacular gameplay (`studio_highlights` → `move`),
   UI clutter → `set {zoom:1.1, focusY:…}`, mixed captures → `studio_color_match {mode:"auto"}`, shaky handheld →
   `studio_stabilize`. Add 2–3 short `big` texts that sell verbs ("RESCUE", "SURVIVE"), not features.
5. Quality gate. Formats: `["qhd","vertical","whatsapp"]` (Steam takes 1080p+; vertical for TikTok/Shorts; WhatsApp for
   playtesters). `studio_publish_pack {platforms:["steam","youtube","x"]}` for capsule-style stills and post drafts.
