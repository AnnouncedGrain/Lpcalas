# Lpcalas

Aplikacija za ekipu: glasovni kanali, stream ekrana u visokom kvalitetu i chat sa slikama i videima.
Zamjena za TeamSpeak / Discord koju hostamo sami.

## Dijelovi

| Folder | Šta je |
|---|---|
| `client/` | Windows aplikacija (Tauri + React). Glas i stream preko LiveKita. |
| `server/` | Backend: nalozi, kanali, chat, fajlovi, tokeni za glas. Node.js, bez vanjskih paketa, SQLite baza. |
| `deploy/` | Docker konfiguracija i skripte za pokretanje servera. |
| `docs/` | Upute (hosting, šta još nije urađeno). |

## Kako doći do aplikacije (Windows)

GitHub sam napravi installer na svaki push:

1. Na GitHubu otvori **Actions** → najnoviji zeleni "Build".
2. Dole pod **Artifacts** skini `Lpcalas-Windows-installer`.
3. Raspakuj i pokreni `Lpcalas_x.y.z_x64-setup.exe`.
   Windows može pokazati "Windows protected your PC" → **More info** → **Run anyway** (aplikacija nije potpisana certifikatom).

Installer pošalji ostalima (Viber, Google Drive...).

## Server

- Privremeno, na nečijem računaru: [docs/HOSTING-NA-RACUNARU.md](docs/HOSTING-NA-RACUNARU.md)
- Kasnije na pravom serveru (Hetzner) — vidi [docs/NIJE-URADJENO.md](docs/NIJE-URADJENO.md)

## Šta radi (v0.1)

- Nalozi s pozivnim kodom (prvi nalog je admin), avatar, promjena imena/lozinke
- Tekstualni kanali: poruke, markdown, odgovori, uređivanje, brisanje, reakcije, "kuca...",
  slike/video/fajlovi (drag & drop, paste, do 500 MB), pregled slika
- Glasovni kanali: Opus 48 kbps, potiskivanje šuma/eha, aktivacija glasom s pragom, push-to-talk (globalno, i u igri, i dugmad miša),
  mute/deafen tipke, jačina po osobi, zvukovi ulaska/izlaska
- Stream ekrana: do 4K60, izbor kodeka (H.264 / AV1 / VP9), bitrate do 30 Mbps, zvuk sistema,
  statistika (rezolucija, fps, bitrate, da li enkoder radi hardverski)
- Admin: pozivnice, kanali, uloge, onemogućavanje naloga, izbacivanje iz glasovnog kanala

## Razvoj

```bash
# server
cd server && npm test && npm start

# klijent (treba Rust + Node)
cd client && npm install && npx tauri dev
```
