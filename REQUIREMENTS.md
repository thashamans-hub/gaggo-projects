# Krav – GaGGos Projects 11.0

## Kod
- **Inga npm-beroenden** för själva webbplatsen (ren HTML/CSS/JS).
- **Node.js 18+** behövs bara för `serve.js` och `npm test`.
- Filerna ligger i `site/`; `index.html` kan öppnas direkt i webbläsaren.

## Webbläsare
- Chrome/Edge/Firefox/Safari, senaste 2 versionerna.
- **IndexedDB** (lokal demo, papperskorg, bakgrundsbild, offline-kö).
- **Service Worker** kräver `http://localhost` eller HTTPS (PWA/offline-shell).
- **WebAudio** för ambient-ljud (valfritt).
- **Clipboard API** för kopiering; fallback via `execCommand` finns.

## Lagring
| Läge | Konto | Giltighet | Delas mellan enheter |
|---|---|---|---|
| Catbox (standard) | Nej | **Permanent** | Nej (filistan lokal) |
| TmpFiles (fallback) | Nej | ca 1 timme | Nej (filistan lokal) |
| Supabase Storage | Ja, gratis | Permanent | **Ja** |
| Cloudinary | Ja, gratis | Permanent | Nej (filistan lokal) |
| Lokal demo | Nej | Tills rensad | Nej |

**För en riktigt uppkopplad, delad webbplats:** Supabase (gratis). Se `ANSLUT.md` och `supabase-setup.sql`.

## Hostingtjänst
- Netlify (använt här), Vercel, Cloudflare Pages eller GitHub Pages – alla gratis för statiska sajter.
- Netlify Drop stöder **inte** Netlify Functions; sajten är därför helt statisk.
- `_redirects` måste finnas med vid deploy – den proxy:ar `/api/filehost` till Catbox och gör permanenta länkar möjliga utan konto.
- `serve.js` har motsvarande proxy för lokal utveckling (Node 18+ med `fetch`).

## Externa tjänster
- Google Fonts (Bricolage Grotesque, JetBrains Mono) – valfritt, fallback till systemfonter.
- Supabase JS via jsDelivr CDN – behövs bara för Supabase-läget.
- qrserver.com för QR-koder – valfritt, länken fungerar även utan QR.

## Fixar i 15.3
- GitHub Pages: proxyn används bara på Netlify; TmpFiles-upload retry:ar automatiskt (inga 405-fel i konsolen).

## Fixar i 15.2
- Inga externa typsnitt – systemfonter används, vilket eliminerar CORS-varningar från Google Fonts.
- TmpFiles-uppladdning går via same-origin proxy `/api/tmpfiles` med direkt-URL som fallback.

## Fixar i 15.1
- Alla adaptrar tillåter mjuk radering (papperskorgen fungerar även med TmpFiles/Catbox/Cloudinary som standard).
- Text-, markdown- och `content:`-sökning läser den lokalt cachade bloben först → inga CORS-fel och fungerar offline.
- ZIP-export och backup använder samma blob-först-princip.

## Nya i 15.0
- Filer < 20 MB cachas i IndexedDB vid uppladdning, så länkar kan förnyas utan att filen finns kvar lokalt på disk.
- TmpFiles-länkar förnyas automatiskt efter 50 minuter (kan stängas av i inställningar), eller manuellt via **Förnya länkar**.
- Filkort visar nedräkning till utgång (⏳).

## Nya i 14.0
- `content:<ord>` söker i textinnehållet hos kod-/dokumentfiler (filer < 5 MB), asynkront med träffräknare.
- Filer kan dras direkt till en mapp- eller taggsamling i sidopanelen för att flyttas/taggas.

## Nya i 13.0
- **Systemstatus** i Insikter visar leverantör, länkhållbarhet, om filistan är delad, anslutning, köade uppladdningar och senaste backup.
- **Bulk: Markdown** kopierar markerade filer som `- [namn](länk)`.
- **Ctrl/Cmd+A** markerar alla filer i vyn, **Ctrl/Cmd+Shift+A** rensar.
- **PDF-förhandsvisning** via iframe när filen är en PDF.

## Test
```powershell
cd site
npm test
```
Förväntat: 15+ godkända tester, 0 fel.

## Begränsningar
- TmpFiles rensar filer automatiskt (ca 1 timme) – använd Supabase för permanens.
- Upload från URL kan blockeras av CORS hos källan.
- `browse`/browser-verktyg krävs bara för agentens deploy, inte för sajtens drift.
