# Gör sidan helt uppkopplad (delad + permanent) – 3 minuter

Just nu fungerar uppladdningen och ger publika länkar via **TmpFiles**, men:
- länkarna går ut efter ca **1 timme**
- **filistan ligger bara i din webbläsare** – därför ser en annan enhet inga filer

För att göra sidan till en riktig delad webbplats behövs ett gratis datalager. Supabase är gratis utan kreditkort.

## Steg

1. Öppna **https://supabase.com** → **Start your project** → logga in med Google → skapa ett projekt (namn valfritt, region närmast dig).
2. Vänstermenyn → **SQL Editor** → **New query** → klistra in allt från `supabase-setup.sql` → **Run**.
3. **Project Settings → API** → kopiera:
   - **Project URL** (t.ex. `https://abcd.supabase.co`)
   - **anon public key**
4. Öppna https://gaggo-projects.netlify.app → kugghjulet → **Lagringsleverantör: Supabase Storage** → klistra in URL + nyckel → **Synka metadata: på** → **Spara**.

Klart. Nu:
- sparas filerna permanent i Supabase Storage
- filistan syns för **alla besökare** och på alla enheter
- länkarna slutar gå ut

## Säkerhet
Anon-nyckeln är avsedd att vara publik. Policyn i SQL-filen tillåter vem som helst att ladda upp/ladda ner i bucketen `vault` – fine för en privat portfölj, men begränsa policyn om sajten blir offentlig.

## Alternativ
Cloudinary fungerar också (gratis): skapa en **Unsigned upload preset** och klistra in cloud name + preset i inställningarna. Då sparas dock filistan lokalt – Supabase är det enda alternativet som ger riktig delning.
