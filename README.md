# Béri Olvasókör

A könyvklub olvasmányai: a könyvekről és szerzőikről szóló információk a Wikipédiáról és a Wikidatáról, borítóképekkel és portrékkal.

Élő oldal: https://malloc9.github.io/book-club/

## Új könyv hozzáadása

1. Írd be a könyvet a [`src/data/books.yaml`](src/data/books.yaml) fájlba (cím, szerző, lehetőleg eredeti cím).
2. Futtasd: `npm run fetch` – letölti az adatokat és a képeket.
3. Ellenőrizd helyben: `npm run dev`
4. Commitold a változásokat (`books.yaml`, `src/data/generated/`, `public/images/`) és pushold – a GitHub Actions telepíti az oldalt.

Ha rossz cikket talál, add meg kézzel a `wiki` mezőt (Wikidata azonosító, pl. `Q478016`, vagy `hu:Cikk címe` / `en:Article title`).
Saját borítóhoz tedd a képet a `covers/` mappába, és add meg a `cover` mezőt.

## Működés

- `scripts/fetch-data.mjs` – build előtt fut: Wikidatán megkeresi a szerzőt és a könyvet, a magyar (vagy ha nincs, angol) Wikipédiából kiveszi a bevezetőt és a cselekményt, a képeket WebP-be konvertálva elmenti. Hiba esetén a korábbi, elmentett adat marad.
- Ha nincs magyar szócikk (vagy a magyar életrajz nagyon rövid), más nyelvű Wikipédiából veszi és gépi fordítással fordítja; ha egyáltalán nincs szócikk a könyvről, a szerző szócikkének a könyvet említő bekezdései jelennek meg.
- Fordítás: az idegen nyelvű szöveget a Google Fordító ingyenes végpontja fordítja le; a fordítások a `src/data/generated/translations.json` fájlban tárolódnak, így csak az új vagy módosult bekezdések mennek fordításra. Az oldalon „gépi fordítás” jelvény jelzi. Ha a fordítás nem sikerül, az eredeti szöveg jelenik meg.
- Ha a könyvről nincs Wikipédia-szócikk, a `books.yaml` `description`, `sources` és `facts` mezőiben saját, megbízható forrásokból (kiadó, kritikák, Moly) összeállított összefoglaló adható meg; az oldalon „összefoglaló több forrás alapján” jelvény és forráslista jelzi.
- Borító sorrend: saját kép → Wikipédia/Wikimedia → Open Library → generált borító.
- Az oldal Astro-val készül, a GitHub Actions minden pushnál és hetente frissíti.

## Licenc

A szövegek a Wikipédiából származnak (CC BY-SA 4.0), az adatok a Wikidatából (CC0); a képek szerzője és licence minden kép alatt fel van tüntetve.
