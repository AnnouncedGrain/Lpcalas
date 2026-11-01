// Bilješke o izmjenama. Pri pokretanju aplikacija ih šalje serveru, a server svaku verziju
// jednom objavi kao poruku u kanalu #changelog. Novu verziju dodaj NA KRAJ liste.

export const CHANGELOG: Array<{ version: string; notes: string }> = [
  {
    version: '0.1.0',
    notes: `- Prva verzija: nalozi s pozivnicama, tekstualni i glasovni kanali
- Chat sa slikama, videom i fajlovima, reakcije, odgovori, uređivanje
- Push-to-talk (radi i u igri), aktivacija glasom, potiskivanje šuma
- Stream ekrana do 4K60`,
  },
  {
    version: '0.1.2',
    notes: `- Ispravljen glas kad se server hosta na kućnom računaru (Docker)
- Jasnije poruke kad glas ne prolazi`,
  },
  {
    version: '0.1.3',
    notes: `- Automatski izbor kodeka koji grafička enkodira hardverski
- Postavke → Stream: provjera hardverskog enkodera`,
  },
  {
    version: '0.1.4',
    notes: `- Svaki događaj ima svoj zvuk, jačina zvukova, zvuk za nove poruke
- Stream se skida tek kad klikneš "Gledaj"; X za prestanak gledanja
- Vidi se ko gleda tvoj stream
- Raspored za više streamova odjednom (Auto / 1 / 2 / 3 kolone)
- X na otvorenoj slici, ispravke punog ekrana i lijevog menija`,
  },
  {
    version: '0.1.5',
    notes: `- Glasovna najava na engleskom (Microphone muted / activated...)
- Gledalac vidi i sebe među gledaocima
- Desni klik na člana otvara samo jedan meni`,
  },
  {
    version: '0.2.0',
    notes: `- Poke: desni klik na osobu → Poke (s porukom)
- Automatsko ažuriranje aplikacije`,
  },
  {
    version: '0.2.1',
    notes: `- Miš preko osobe pokazuje koliko je dugo online
- Log ulazaka i izlazaka dole desno`,
  },
  {
    version: '0.2.2',
    notes: `- Kanal #changelog s izmjenama svake verzije
- Premještanje ljudi između glasovnih kanala (prevuci mišem; admin može pomjerati druge, svako sebe)
- Dugme za mute zvuka na streamu koji gledaš
- Gledaoci više ne čuju sami sebe u streamu: zvuk računara se snima bez zvuka Lpcalasa`,
  },
  {
    version: '0.2.3',
    notes: `- Statistika streama pokazuje kako se šalje zvuk (Windows bez Lpcalasa ili stari način)
- Ako zvuk ne može ići bez Lpcalasa, streamer odmah dobije poruku s razlogom
- Izbor jezika: bosanski ili engleski (Postavke → Aplikacija → Jezik, ili na prijavi)
- Language option: Bosnian or English (Settings → App → Language, or on the login screen)`,
  },
  {
    version: '0.2.4',
    notes: `- Pop-out streama: dugme na streamu otvara ga u zasebnom prozoru koji možeš pomjerati, povećavati i držati iznad drugih prozora
- Zatvaranje tog prozora vraća stream u aplikaciju`,
  },
];
