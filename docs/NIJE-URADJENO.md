# Šta još nije urađeno (podsjetnik)

Ovo su stvari koje smo namjerno ostavili za kasnije. Claude te podsjeti kad dođe vrijeme.

## Kad aplikacija prođe testiranje na privremenom hostingu

- [ ] **Domena** `lpcalas.com` (ili `.net` / `.eu` ako je zauzeta) — preporuka: Cloudflare Registrar
- [ ] **Server na Hetzneru** — Ubuntu 24.04, lokacija Falkenstein ili Nürnberg, x86 plan sa 4–8 GB RAM-a
- [ ] **SSH ključ** — `ssh-keygen -t ed25519` u PowerShellu, `.pub` fajl ide u Hetzner
- [ ] Linux instalacijska skripta + HTTPS (Caddy) — Claude piše kad server postoji
- [ ] Prebacivanje podataka (`deploy/data`) s privremenog računara na server

## Nakon što osnovni dio proradi

- [ ] **Vlastiti izgled aplikacije** — da ne liči na Discord, nego da ima karakter specifičan za Lpcalas (raspored, boje, tipografija, chat)

## Opcionalno

- [ ] Code signing certifikat za Windows (bez njega SmartScreen pokazuje upozorenje — dogovoreno da je OK)
- [ ] iOS / Android aplikacija (nakon što se Windows verzija pokaže)
