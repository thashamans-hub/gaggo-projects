/* ============================================================
   TERRARIUM — standardinställningar
   Ändra här, eller (enklare) öppna sajten och klicka på
   "Inställningar" för att spara val direkt i webbläsaren.
   ============================================================ */
window.TERRARIUM_CONFIG = {
  // Vilken lagring som används: "local" | "supabase" | "cloudinary"
  provider: "tmpfiles",

  // Supabase (gratis) — https://supabase.com
  supabase: {
    url: "",
    anonKey: "",
    bucket: "vault",
    syncMetadata: true // kräver tabellen vault_files, se SETUP.md
  },

  // Cloudinary (gratis) — https://cloudinary.com
  cloudinary: {
    cloudName: "",
    uploadPreset: "terrarium_unsigned",
    folder: "terrarium"
  },

  // Utseende
  brand: {
    name: "GaGGos Projects",
    owner: "GaGGo",
    tagline: "Din gröna drop för allt. Ladda upp, dela, chill."
  },

  tagColors: {},

  theme: {
    accent: "lime",        // lime | mint | amber | violet
    customAccent: "",       // t.ex. #ff6b9d
    useCustom: false,       // aktivera egen accentfärg
    customWallpaper: false, // använd egen uppladdad bakgrundsbild
    wallpaperStyle: "jungle", // jungle | night | amber
    rotateWallpapers: false,  // rotera bakgrunden automatiskt
    ambient: false,          // mjuk WebAudio-bakgrundston
    autoRenew: true,         // förnya tillfälliga länkar automatiskt
    wallpaper: true,        // fullskärmsbakgrund
    motion: true,           // animationer
    view: "grid"            // grid | list
  },

  // Projektkort längre ned på sidan
  projects: [
    {
      name: "PhilipsTheOneTvRemote",
      desc: "Lokal fjärrkontroll för Philips The One via JointSpace API. Node, PWA, iOS och Android/TV.",
      tags: ["Node.js", "PWA", "iOS", "Android"],
      icon: "📺",
      href: "../PhilipsTheOneTvRemote/README.md",
      githubHref: "https://github.com/thashamans-hub?tab=repositories",
      accent: "#8affc1"
    },
    {
      name: "GearS3Studio",
      desc: "Studio för att designa, förhandsgranska och exportera klockansikten till Samsung Gear S3 Frontier.",
      tags: ["Vanilla JS", "SVG", "Tizen", "CLI"],
      icon: "⌚",
      href: "../GearS3Studio/README.md",
      githubHref: "https://github.com/thashamans-hub?tab=repositories",
      accent: "#c9ff5a"
    }
  ]
};
