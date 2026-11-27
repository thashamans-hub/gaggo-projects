# 🌿 GaGGos Projects – igång på 5 minuter

**Live (Netlify):** https://gaggo-projects.netlify.app
**Live (GitHub Pages):** https://thashamans-hub.github.io/gaggo-projects/
**Repo:** https://github.com/thashamans-hub/gaggo-projects (push till `main` uppdaterar GitHub Pages automatiskt)

Sajten ligger i mappen `site/`. **Standardläget är TmpFiles**: ett gratis moln utan konto som ger riktiga publika länkar direkt. Observera att TmpFiles-länkar är **tillfälliga (ca 1 timme)** – för permanent lagring, anslut Supabase eller Cloudinary nedan (båda har gratisplaner utan kreditkort).

En färdig ZIP finns på skrivbordet: `C:\Users\Genc\Desktop\GaGGos-Projects.zip`.

---

## 0. Testa lokalt (ingen setup)

Dubbelklicka `site/index.html`, eller kör den inbyggda noll-beroende servern:

```powershell
cd C:\Users\Genc\Documents\Standardprojekt\site
npm start          # http://localhost:8080
npm test           # kör de beroendefria testerna
```

I **demo-läget** sparas filerna i webbläsarens IndexedDB. Länkarna funkar bara hos dig – perfekt för att prova UI:t.

---

## 1A. Supabase (rekommenderas – allt går, även radering)

1. Gå till **https://supabase.com** och skapa ett gratis konto → **New project**.
2. Välj **Storage** i vänstermenyn → **New bucket** → namn: `vault` → kryssa i **Public bucket** → **Create bucket**.
3. Öppna **SQL Editor** → **New query** → klistra in och kör:

```sql
-- Idempotent: ta bort ev. gamla policies först
drop policy if exists "vault_public_read"   on storage.objects;
drop policy if exists "vault_public_insert" on storage.objects;
drop policy if exists "vault_public_delete" on storage.objects;
drop policy if exists "vault_files_all"     on public.vault_files;

--Publik läsning, uppladdning och radering i bucketen vault
create policy "vault_public_read"
  on storage.objects for select to public
  using (bucket_id = 'vault');

create policy "vault_public_insert"
  on storage.objects for insert to public
  with check (bucket_id = 'vault');

create policy "vault_public_delete"
  on storage.objects for delete to public
  using (bucket_id = 'vault');

-- Metadata så att filistan synkas mellan enheter
create table if not exists public.vault_files (
  id text primary key,
  name text not null,
  size bigint,
  type text,
  path text,
  url text,
  folder text,
  "createdAt" timestamptz default now(),
  starred boolean default false,
  pinned boolean default false,
  note text default '',
  tags text[] default '{}'
);

alter table public.vault_files enable row level security;

create policy "vault_files_all"
  on public.vault_files for all to anon
  using (true) with check (true);
```

4. **Project Settings → API** → kopiera **Project URL** och **anon public key**.
5. Öppna sajten → kugghjulet uppe till höger → fyll i:
   - Leverantör: **Supabase Storage**
   - Project URL, anon-nyckel, bucket `vault`
   - **Synka metadata**: på
   - Spara.

Klart. Ladda upp en fil → kopiera länken → öppna i inkognito för att verifiera att den är publik.

> **Säkerhet:** anon-nyckeln är *menad* att vara publik, men policyn ovan tillåter vem som helst med nyckeln att ladda upp. För privat bruk räcker det oftast att sajten hålls privat, annars får du lägga in t.ex. en lösenordsvy framför (Netlify/Vercel) eller skärpa policyn.

---

## 1B. Cloudinary (enklast – inga SQL-kommandon)

1. Skapa gratis konto på **https://cloudinary.com**.
2. Kugghjulet → **Upload** → **Upload presets** → **Add upload preset**.
   - **Signing Mode:** `Unsigned`
   - **Preset name:** `terrarium_unsigned`
   - **Folder:** `terrarium` (valfritt)
   - Spara.
3. På Dashboard hittar du **Cloud name**.
4. Sajtens inställningar → leverantör **Cloudinary** → fyll i cloud name + preset → spara.

> Cloudinary klarar bilder, video, ljud och "raw"-filer via `resource_type=auto`. Radering i molnet kräver en signerad API-nyckel, så sajtens borttagningsknapp tar bara bort posten ur listan. Vill du kunna radera på riktigt → använd Supabase.

---

## 2. Publicera gratis

**Netlify (snabbast):** gå till https://app.netlify.com/drop och dra in hela `site`-mappen. Klart på sekunder.

**Cloudflare Pages / Vercel:** välj repot, sätt *build output/publish directory* till `site`.

**GitHub Pages:** push innehållet av `site/` till en repo (t.ex. `genc.github.io`), sen **Settings → Pages → Deploy from a branch → main / root**.

Alla tre är gratis för statiska sajter. Ingen `npm install` behövs.

---

## 3. Inställningar & backup

- Alla val sparas i webbläsarens `localStorage` (överskrider `js/config.js`).
- **Exportera JSON** i inställningarna för att säkerhetskopiera filistan.
- **Importera JSON** för att återställa den på en annan enhet.
- Projektkorten längst ned redigeras i `js/config.js` under `projects`.
- Utseende: accentfärg, wallpaper på/av, animationer och standardvy i inställningarna.

## 4. Nytt i 17.0

- **Dela samling** – bulk-knapp/palettkommando skapar en enda länk där hela filgalleriet är inpackat i URL:en. Öppna länken var som helst – samma filer och länkar visas i en read-only vy.

## 4n. Tidigare versioner

### Nytt i 16.0

- **GitHub-sektion**: profil, repo-statistik och direktlänkar via GitHubs publika API.
- **Projektkort**: lokala sökvägar lokalt, GitHub-länkar i publicerad miljö.

## 4m. Tidigare versioner

### Fixar i 15.2

- Inga Google Fonts (systemfonter) och TmpFiles via `/api/tmpfiles`-proxy → rena konsol-loggar.

## 4l. Tidigare versioner

### Fixar i 15.1

- Radera-knappen finns för alla lagringslägen (mjuk radering till papperskorgen).
- Förhandsvisning av text/markdown och `content:`-sökning fungerar med TmpFiles tack vare lokal blob-cache; inga CORS-fel i konsolen.

## 4k. Tidigare versioner

### Nytt i 15.0

- **Länkförnyelse** – TmpFiles-länkar förnyas automatiskt efter 50 minuter (filen cachas lokalt), med nedräkning på varje filkort och manuell **Förnya länkar** i bulkraden/kommandopaletten.

## 4j. Tidigare versioner

### Nytt i 14.0

- **`content:`-sökning** – sök i innehållet hos text-/kodfiler (`content:hej`), kombinerbart med andra operatorer.
- **Drag-&-drop till samlingar** – dra ett filkort till en mapp eller tagg i sidopanelen för att flytta/tagga filen.

## 4i. Tidigare versioner

### Nytt i 13.0

- **Systemstatus-panel** i Insikter med leverantör, länkstatus, delad/lokal filista, anslutning, kö och senaste backup.
- **Markdown-export** av markerade fils länkar direkt i bulkraden.
- **Ctrl/Cmd+A** för att markera alla filer, **Ctrl/Cmd+Shift+A** för att rensa.
- **Backup-påminnelse** efter 25 uppladdningar.
- **PDF-förhandsvisning** i förhandsvisningsdialogen.

## 4h. Tidigare versioner

### Nytt i 12.0

- **Permanent gratislagring** – Catbox via Netlify-rewrite (`_redirects`), inget konto, länkar som stannar kvar. Automatisk fallback till TmpFiles om proxyn inte finns.
- **Lokal proxy** i `serve.js` för samma beteende under utveckling.
- **Uppdaterade kravdokument** – `README.md`, `REQUIREMENTS.md`, `ANSLUT.md`.

## 4g. Tidigare versioner

### Nytt i 11.0

- **Anslutningsguide i appen** – tre steg direkt i inställningarna + **Testa anslutning** som validerar nycklar mot Supabase/Cloudinary innan du sparar.
- **Tydlig status** – banner visar när sajten kör tillfälliga TmpFiles-länkar och knapp tar dig till permanent anslutning.
- **Dokumentation** – `README.md`, `REQUIREMENTS.md`, `ANSLUT.md` och `supabase-setup.sql` är uppdaterade.

## 4f. Tidigare versioner

### Nytt i 10.0

- **QR-delning** – förhandsvisningen visar en QR-kod för filens offentliga länk (via qrserver.com) med kopieringsknapp.
- **Delningssida** – generera en fristående `gaggo-share.html` med ett galleri av valda filer och deras länkar.
- **Aktivitetsvärmekarta** – insikter visar 30 dagars aktivitet som en värmekarta.

## 4e. Tidigare versioner

### Nytt i 9.0

- **Versionshistorik** – namn, taggar, anteckningar, stjärna/fäst, mapp och ikon sparas som snapshots; ändringar kan återställas i förhandsvisningen.
- **Fil-emoji** – välj en egen ikon per fil från förhandsvisningen.
- **Bulk-flytt till mapp** – flytta flera markerade filer till samma mapp.
- **Taggfärger** – sätt egna färger per tagg i inställningarna (annars genereras en deterministisk färg).
- **Dublett-merge** – städassistenten kan behålla en fil per dublettgrupp och flytta resten till papperskorgen.
- **Fuzzy-sök i paletten** – kommandon och filer matchas även vid ofullständiga bokstäver.

## 4d. Tidigare versioner

### Nytt i 8.0

- **Städassistent** – samlad vy med dubletter, filer över 10 MB, filer äldre än ett år och otaggade filer; markera en grupp eller alla med ett klick.
- **Ambient-ljud** – mjuk WebAudio-drone (tre toner + långsam filter-LFO) som kan slås på i navet eller i inställningarna.
- **Roterande bakgrunder** – Jungle → Night swamp → Amber dusk var 30:e sekund.
- **Senaste kommandon** – kommandopaletten visar dina 3 senaste val överst.
- **Offline-kö** – filer som slängs in medan du är offline köas och laddas upp automatiskt när anslutningen återvänder (fanns redan i kärnan, nu dokumenterad).

## 4c. Tidigare versioner

### Nytt i 7.0

- **Backup-restore** – en sparad .zip kan läsas tillbaka: filer, metadata, historik, utmärkelser och inställningar återställs.
- **Filanteckningar** – skriv en anteckning per fil i förhandsvisningen; visas som 📝 på filkortet.
- **Markdown-visning** – `.md`-filer renderas med rubriker, listor, fetstil och kodblock istället för rå text.
- **Bildtransform** – rotera 90° och spegelvänd bilder i förhandsvisningen, med återställningsknapp.

## 4b. Tidigare versioner

### Nytt i 6.0

- **Full backup** – en enda ZIP med alla filer, metadata (JSON + CSV), aktivitet, utmärkelser och inställningar.
- **Ladda upp från URL** – hämta en fil direkt via länk (CORS kan blockera vissa tjänster).
- **Slideshow** – bildspel i helskärm med autoavancemang; starta från förhandsvisningen eller paletten.
- **Auto-taggar** – regelbaserade förslag (typ, årtal, skärmdump, rapport…) som kan läggas till på en fil eller alla.
- **Bakgrundsvarianter** – Jungle, Night swamp och Amber dusk; väljs i inställningarna eller paletten.
- **Bildinformation** – förhandsvisningen visar bildens pixeldimensioner.
- **j/k-navigering** – bläddra snabbt mellan filer utan mus.
- **17 utmärkelser** – nya badges för backup och slideshow.

## 4a. Tidigare versioner

### Nytt i 5.0

- **Papperskorg** – radering flyttar filen till en återställningsbar korg; permanent rensning sker explicit. Fungerar även med moln (länken lever tills du rensar).
- **Egen bakgrundsbild** – ladda upp valfri bild i inställningarna; sparas lokalt och används som hela sidans wallpaper.
- **Klistra in filer** – `Ctrl/Cmd+V` med bilder/filer i urklippet laddar upp dem direkt. Kommandopaletten har även "Nytt textfiler".
- **Bulk-rename** – prefix + autonummerering på flera markerade filer, ändelsen behålls.
- **Dubletter** – filer med samma namn och storlek markeras och kan filtreras i egen samling.
- **Kvotmätare** – insikter visar webbläsarens faktiska lagringsanvändning.
- **Zen-läge** – `Z` eller kommandopaletten döljer allt utom filvyn.
- **Taggfärger** – varje tagg får en deterministisk färg i samlingar och filkort.
- **15 utmärkelser** – tre nya badges (zen, återupplivare, dubbelspår).

## 4a. Tidigare versioner

### Nytt i 4.0

- **Fästa filer** – 📌 fästa filer sorteras först och får egen samling; bulk-fästning finns i markeringsraden.
- **Insikter** – donut för lagringsfördelning, 7-dagars uppladdningsdiagram, topp-taggar och nyckeltal.
- **Utmärkelser** – 12 upplåsbara badges med toast när de låses upp.
- **Inline-rename** – byt namn direkt på filkortet via pennikonen (Enter sparar, Esc avbryter).
- **Bulk-taggar** – lägg till samma taggar på flera markerade filer; Shift+klick markerar ett intervall.
- **CSV-export** – komplett metadata-export för Excel/Sheets.
- **Offline-skydd** – tydlig banner och pausade uppladdningar när anslutningen försvinner.
- **Från 3.0:** samlingar, smarta sökoperatorer, aktivitetshistorik, ZIP-export, bildzoom och egen accentfärg.

## 4b. Tidigare versioner

### Nytt i 3.0

- **Samlingar** – sidopanel med filtrerbara album byggda på mappar och taggar, plus "Senaste 7 dagarna".
- **Smarta sökoperatorer** – `tag:work`, `folder:proj`, `type:image`, `starred`, `size:>1mb` går att kombinera.
- **Aktivitetshistorik** – tidslinje med de senaste 100 åtgärderna (uppladdning, radering, rename, stjärnor, inställningar).
- **ZIP-export** – ladda ner valda filer eller hela samlingen som en riktig ZIP (egen CRC32-implementation, inga beroenden).
- **Bildzoom** – klicka på en bild i förhandsvisningen för 2× zoom, flytta musen för fokus.
- **Egen accentfärg** – valfri hex-färg i inställningarna; sajten räknar ut ljusare/mörkare nyanser automatiskt.
- **Från 2.0:** wallpaper-läge, filhanterare med förhandsvisning/bulkåtgärder/mapp-upload, kommandopalett (`Ctrl/Cmd+K`), kortkommandon, analytics/XP och PWA.

## 5. Deploy-automation

- **Snabbast:** `npm run deploy:zip` (eller `powershell -File deploy.ps1`) skapar en ZIP och öppnar Netlify Drop – dra in ZIP:en.
- **Automatiskt:** `.github/workflows/deploy-site.yml` bygger och deployar `site/` till Netlify vid push. Lägg till repository-secrets `NETLIFY_AUTH_TOKEN` och `NETLIFY_SITE_ID` (från Netlify → Site configuration → API ID / Personal access tokens). utan secrets hoppar jobbet över deploy men kör fortfarande checker och tester.

---

## Felsökning

| Problem | Åtgärd |
|---|---|
| "Lagring inte ansluten" | Kontrollera URL/nyckel och att rätt leverantör är vald. |
| Upload failar direkt (Supabase) | Bucketen måste heta `vault` (eller samma som i inställningarna) och vara public + policy `vault_public_insert` måste finnas. |
| Upload failar (Cloudinary) | Preseten måste vara **Unsigned** och namnet stämma exakt. |
| CORS-fel | Supabase och Cloudinary tillåter detta som standard. Öppna konsolen (F12) för exakt felmeddelande. |
| Filerna försvinner vid omstart | Du kör i demo-läge – anslut ett moln. |

---

🦎 **Tips:** tryck `/` för att fokusera sökfältet, `Esc` för att stänga dialoger.
