# Privremeni hosting na Windows računaru

Dok ne pređemo na pravi server (Hetzner), server može raditi na računaru jednog od vas.
Taj računar mora biti upaljen dok se ostali koriste aplikacijom.

## Šta treba

- Windows 10/11, 64-bit
- **Docker Desktop** — https://www.docker.com/products/docker-desktop/
  (ili u PowerShellu: `winget install Docker.DockerDesktop`). Nakon instalacije restartuj računar i pokreni Docker Desktop jednom.
- Pristup ruteru (za port forwarding)
- Žičana veza (kabl) je preporučena, nije obavezna

## Pokretanje

1. Skini repozitorij (na GitHubu: **Code → Download ZIP**) i raspakuj ga, npr. u `C:\Lpcalas`.
2. Uđi u folder `deploy` i dvoklikni **POKRENI-SERVER.bat**.
3. Windows će pitati za administratorska prava (potrebna za firewall) — klikni **Yes**.
4. Na kraju skripta ispiše:
   - adresu za tebe i druge u istoj kućnoj mreži (npr. `192.168.0.14:8080`),
   - adresu za prijatelje preko interneta (`TVOJA-JAVNA-IP:8080`),
   - **prvi pozivni kod**: ko se prvi registruje s njim, postaje admin.

Ponovno pokretanje skripte je bezbjedno: ključevi i podaci (poruke, slike, nalozi) ostaju u `deploy/data`.

## Port forwarding na ruteru

U postavkama rutera (obično `192.168.0.1` ili `192.168.1.1`, traži "Port Forwarding", "Virtual Server" ili "NAT")
napravi tri pravila prema lokalnoj IP adresi računara koju je ispisala skripta:

| Protokol | Port | Za šta |
|---|---|---|
| TCP | 8080 | aplikacija, chat, signalizacija |
| TCP | 7881 | glas/video kad UDP ne prolazi |
| UDP | 7882 | glas/video (glavni put) |

Savjet: u ruteru rezerviši (DHCP reservation) tu lokalnu IP adresu za ovaj računar, da se ne promijeni.

## Provjera: da li imaš "pravu" javnu IP adresu (CGNAT)

Neki provajderi daju adresu koja se dijeli s drugim korisnicima (CGNAT). Tada port forwarding ne radi.

1. U ruteru pogledaj **WAN IP** (status/internet stranica).
2. Uporedi je s adresom koju skripta ispiše kao javnu.
   - Iste su → sve je u redu.
   - Različite, ili WAN počinje sa `100.64`–`100.127`, `10.`, `172.16`–`172.31` ili `192.168.` → CGNAT.
     Javi Claudeu, rješenje je da server hostuje neko drugi ili da odmah pređemo na Hetzner.

## Javna IP se mijenja

Kućne IP adrese se povremeno promijene (restart rutera). Tada prijatelji u aplikaciji moraju upisati novu adresu.
Ovo nestaje kad pređemo na pravi server s domenom.

## Gašenje, logovi, backup

- Gašenje: **ZAUSTAVI-SERVER.bat**
- Logovi (u folderu `deploy`): `docker compose logs -f`
- Backup: kopiraj folder `deploy/data` (dok je server ugašen)
- Novu verziju: zamijeni fajlove novim ZIP-om (folder `deploy/data` i fajl `deploy/.env` ostavi) i ponovo pokreni **POKRENI-SERVER.bat**
