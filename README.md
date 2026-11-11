# Crypto News Impact Monitor

Analitično orodje, ki kripto novice združi v dogodke in jih oceni (0–100) glede na tržni vpliv referenčnih dogodkov. **Ni investicijski nasvet.**

> Stanje: 6. korak (GitHub Actions, GitHub Pages). Vsi koraki MVP so implementirani; uteži se pregledajo po prvem backfillu.

## Zahteve

- Node.js ≥ 20
- Edina odvisnost: `fast-xml-parser` (fiksna verzija 5.11.2)

## Ukazi

| Ukaz | Namen |
|---|---|
| `npm ci` | namestitev |
| `npm test` | enotski in integracijski testi (brez omrežja) |
| `npm run collect` | en tek zbiralnika → `data/*.json` in `data/bundle.js` (podatki za dashboard) |
| `npm run bundle` | ponovno ustvari `data/bundle.js` iz obstoječih `data/*.json` (npr. po backfillu) |
| `npm run smoke` | preizkus virov: cene (Binance, arhivi LUNA/UST/FTT, Bitstamp 2014), vsi RSS viri (tudi izklopljeni), ID-ji kategorij CoinGecko |
| `npm run backfill` | izračun vpliva za referenčno knjižnico |
| `npm run backfill:offline` | isto, samo iz predpomnilnika (brez omrežja) |
| `npm run calibrate` | Spearman ExAnte↔ExPost; od 50 potrjenih predlog uteži (NNLS) v `data/calibration.json` |

## Okoljske spremenljivke

V repozitoriju ni nobenih skrivnosti. Lokalno jih nastavite v lupini, v GitHub Actions pa v *Settings → Secrets and variables → Actions*.

| Ime | Vrsta v Actions | Namen | Brez nje |
|---|---|---|---|
| `COINGECKO_DEMO_API_KEY` | secret | sektorji (top 30 po kategoriji), preverjanje ID-jev kategorij | sektorji niso na voljo; entitete samo iz `config.entities.static` (opozorilo v statusu) |
| `CONTACT_EMAIL` | **secret** | kontakt v User-Agent za SEC (SEC Fair Access zahteva identifikacijo samodejnih odjemalcev) | vir SEC se preskoči (opozorilo, ne napaka) |

HTTP glave smejo vsebovati le znake ASCII. Odjemalec to preveri ob zagonu, ker bi `fetch` sicer zavrnil vsak zahtevek.

**Maskiranje.** Dnevniki workflowov v javnem repozitoriju so javni. GitHub maskira secrets v dnevniku, ne pa v datotekah artifactov ali na veji `data`. Zato koda (`collector/lib/redact.js`) vrednosti iz `app.secretEnvs` nadomesti z `***` v vseh zapisanih JSON datotekah, v izpisu smoke testa in backfilla ter v dnevniku backfilla. Test preveri, da se kontakt ne pojavi v nobeni datoteki, tudi če ga vir vrne v sporočilu o napaki.

## Smoke test in backfill v GitHub Actions

Workflow `.github/workflows/backfill.yml` se zažene ročno (*Actions → Smoke + backfill knjižnice → Run workflow*).

1. Na runnerju zažene `npm run smoke` in `npm run backfill`. S tem preveri tudi dosegljivost `data-api.binance.vision` z ameriškega IP-ja; država IP-ja se izpiše v `out/runner.txt`.
2. Izpis obeh je v povzetku teka.
3. Artifact `backfill-<id>` (30 dni) vsebuje `out/`, `data/library.json`, `data/series/` in `data/backfill-log.json`.
4. Predpomnilnik cen se shrani v `actions/cache`, zato ponovni tek ne prenaša znova preteklih mesecev.
5. Job je rdeč pri smoke = 1 (kritičen vir nedosegljiv), backfill = 1 (napaka) ali backfill = 2 (kriterij knjižnice). Artifact se naloži v vseh primerih.

## Viri novic

| Vir | Tier | Stanje | Opomba |
|---|---|---|---|
| CoinDesk, Cointelegraph, Decrypt, The Block | 0,7 | vklopljen | RSS 2.0, preverjeno 2026-11-02 |
| CryptoSlate | 0,4 | vklopljen | RSS 2.0, preverjeno 2026-11-02 |
| SEC – sporočila za javnost | 1,0 | vklopljen | RSS 2.0, preverjeno 2026-11-02; zahteva `CONTACT_EMAIL` |
| Blockworks | 0,7 | izklopljen | feed brez novih zgodb |
| The Defiant | 0,7 | izklopljen | **ni preverjen** (strežnik zavrača samodejno preverjanje); smoke test ga preveri na runnerju, vklop po potrditvi |

**Aktiven vir** je vir z uspešnim branjem v tem teku in z vsaj enim člankom v zadnjih 24 h. To je imenovalec komponente C.

## Cevovod zbiralnika (3. korak)

1. **Sektorji** (enkrat dnevno, okoli 8 klicev CoinGecko na dan)
   - `/coins/categories/list` preveri ID-je; neveljaven ID je opozorilo in ne sproži ponovnega osveževanja ob vsakem teku.
   - Nato se za vsak sektor prebere top 30 po market cap.
   - Izločijo se stablecoini (kategorija `stablecoins`), simboli iz `sectors.exclude.symbols` in imena, ki ustrezajo `namePattern` (Wrapped, Bridged, Staked).
   - Razlog: med prvimi petimi v »Solana Ecosystem« so USDT, USDC, USDS in WBTC.
2. **Zbiranje**
   - Vsak vir posebej; izpad enega vira je napaka v `status.json`, tek pa se nadaljuje.
   - `id = sha256(kanonični URL)`; parametri `utm_` in podobni se odstranijo.
   - Okno je 14 dni. `ingestedAt` je čas prvega zajema in se ne prepiše.
3. **Označevanje** (samo novi članki; oznake obstoječih ostanejo zamrznjene)
   - entitete v naslovu in povzetku, sektorji in tip po pravilih.
4. **Združevanje** (inkrementalno; ID-ji dogodkov so stabilni)
   - Članek se pridruži dogodku, če je `|seen − firstSeen| ≤ 12 h` in velja ena od dveh možnosti:
     - TF-IDF podobnost naslovov ≥ 0,55, ali
     - Jaccard(pomenske entitete naslova, glavne entitete dogodka) ≥ 0,5 **in** enak tip (≠ other) **in** TF-IDF ≥ 0,25.
   - Pomenske entitete so kovanci in akterji (spodaj). BTC, ETH in SOL so ozadje, kadar naslov vsebuje vsaj en drug kovanec.
5. **Status:** viri, aktivni viri, klici po virih, stanje knjižnice, opozorila in napake.

6. **Trg in točkovanje** (spodaj).

### Entitete

| Vrsta | Pravilo ujemanja |
|---|---|
| Ticker | samo velike črke, cela beseda, dovoljen cashtag (`SOL`, `$SOL`); enočrkovni samo kot cashtag. Na `tickerStopList` so AI, SEC, ETF, CEO … |
| Ime | brez razlikovanja velikosti, cela fraza |
| Dvoumno ime | `ambiguousNames`, npr. Near, Base, Core, Jupiter. Se ne ujema; veljata le ticker in večbesedni alias (`aliases`, npr. »Jupiter Exchange«). Velike začetnice ne pomagajo, ker so naslovi pogosto v Title Case. |
| Sinonim | `synonyms`, npr. Binance → BNB, FTX → FTT, Polygon → POL |
| Prekrivanje | daljše ujemanje zmaga |
| Ozadje | `entities.background` (BTC, ETH, SOL): če naslov vsebuje drug kovanec, so tržni kontekst in ne glavna entiteta. Če so edini kovanec, so glavni. Akterji ozadja ne izrinejo, zato »SEC approves spot Bitcoin ETF« ostane BTC. |
| Akterji | `actors` (`@SEC`, `@CFTC`, `@FBI`, `@DOJ`, `@OFAC`, `@FED`, `@CN_REGULATORS`, `@NORTH_KOREA`, borze in podjetja brez kovanca). Ujemanje z razlikovanjem velikosti. Uporabljajo se pri združevanju in pri podobnosti z referenčnimi dogodki (polje `actors` v knjižnici). |

### Klasifikacija

- Ključna beseda z malimi črkami se ujema brez razlikovanja velikosti; z velikimi črkami z razlikovanjem (`SEC`, `Fed`).
- `*` na koncu pomeni predpono (`hack*`). Vedno se ujema na meji besede.
- Negativne fraze (`negative`, npr. »reward hacking«) se izločijo pred iskanjem.
- Prioriteta: hack, insolvency, protocol_failure, **etf_institutional pred regulation**, listing, upgrade, tokenomics, partnership, macro.
- Članek dobi prvi tip po prioriteti v naslovu, sicer v povzetku.
- **Tip grozda** je večinski tip člankov. Glas članka = tier vira × (naslov 1, povzetek 0,5); tudi »other« je glas. Izenačenje razreši prioriteta. En naslov (npr. o odtokih iz ETF zaradi hacka) tako ne spremeni tipa grozda, ki ga drugi viri uvrščajo drugače, in obratno.
- **Kripto kontekst:** tipi `hack`, `insolvency` in `protocol_failure` (`classification.requireCryptoContext`) veljajo le, če naslov ali povzetek vsebuje kovanec ali kripto akterja (`actors[].crypto`: Coinbase, Kraken, Bybit, Polymarket, Circle, Tether, Chainalysis).
  - Sicer se tip preskoči in klasifikacija nadaljuje po prioriteti: »A stolen iPhone … crypto theft« → `other`.
  - Posledica na pravih naslovih: »Hackers hijack a dozen DeFi websites …« in »… Nomad Bridge Exploiter …« sta zdaj `other`, ker nimata entitete.
- Odstopanja od izhodiščnega seznama v specifikaciji, ugotovljena na pravih naslovih:
  - Iz `etf_institutional` sta odstranjena samostojna »filing« in »approval«; »False SEC Filings« je sicer postal ETF.
  - »rate« je nadomeščen s frazami (»rate cut«, »interest rate«).
  - Dodani so `probe`, `sues`, `charged`, `fraud` (regulation) in `attacker*`, `cyberattack*` (hack).

## Točkovanje (4. korak, poglavje 6)

Uteži in privzete vrednosti so v `config.scoring` in so **točno iz specifikacije**. Pred pregledom `M_ref` iz pravega backfilla se ne spreminjajo.

### ExAnte = 100 · (0,30 T + 0,20 C + 0,10 Q + 0,15 S + 0,25 A)

| Komponenta | Izračun |
|---|---|
| T | povprečni M/M_ref knjižničnih dogodkov istega tipa (M72/M_ref72, sicer M24/M_ref24), omejeno na 1; sicer `typeDefaults` |
| C | različni **medijski** viri v oknu ex-ante / aktivni medijski viri (imenovalec ≥ 1), omejeno na 1. Uradni viri (`official`, SEC) niso ne v števcu ne v imenovalcu, ker skoraj nikoli ne pokrivajo kripto novic; njihova prisotnost je v Q. Samo uradni vir → C = 1. |
| Q | največji tier med viri v oknu |
| S | percentil market cap primarnega kovanca med spremljanimi kovanci (posnetek market cap, veljaven ob koncu okna); BTC in ETH = 1; brez kovanca 0 |
| A | s podobnostjo utežen povprečni M/M_ref do treh analogov s sim ≥ 0,3, omejeno na 1 |

**Podobnost** (popravek formule iz specifikacije, odobren 2026-11-02): sim = [enak tip] · (0,6·Jaccard(glavne entitete dogodka, sredstva in akterji referenčnega dogodka) + 0,4·cos(TF-IDF naslovov, ključne besede)).
- Tip je pogoj in ne del vsote, zato A ne podvaja T: pri istem tipu brez skupnih entitet in besed je sim = 0 in A = 0.
- Uteži (`scoring.similarityWeights`) in prag 0,3 (`scoring.analogMinSim`) sta v configu.
- Pri sredstvih referenčnega dogodka velja isto pravilo ozadja.

**Brez look-ahead.** Ex-ante uporabi le članke, ki izpolnjujejo oba pogoja:
- `seen ≤ firstSeenAt + 6 h` (čas objave);
- `ingestedAt ≤ firstIngestedAt + 6 h` (čas, ko je sistem novico imel).

Nazaj datiran članek, zajet kasneje, zato ne vpliva. Pred `knownBy` je ocena začasna; ob prvem teku po `knownBy` se zamrzne (`exAnte.frozen`) in se ne spreminja več. Test to preveri s kasnejšimi in nazaj datiranimi članki ter tržnimi podatki.

### Trg (živi dogodki)

- **Merjeno sredstvo** je primarni kovanec (prvi kovanec med glavnimi entitetami) prek para `<SIM>USDT` na data-api.binance.vision.
- Če para ni, se uporabi sektorski indeks: top 10 kovancev sektorja s parom, uteži iz market cap posnetka na t − 1 d.
- Če ima sektorski indeks manj kot 3 člane (ali kovanec nima sektorja), se uporabi **tržni indeks**: top 20 po market cap s parom na Binance, brez stablecoinov in zavitih žetonov, enake uteži (CoinGecko, tržni vrh brez kategorije).
  - V meritvi (`market.kind = "market"`) in na grafu je označen kot **»trg«**, ne »sektor«.
  - Isti indeks je primerjalna serija na grafu, kadar sektorskega ni.
  - Ni entiteta za `shared_impact`.
- Merilo je BTC. Ocenjevalno okno je `[t − 31 d, t − 1 d)`, t = firstSeenAt.
- Uporabijo se samo **zaprte** sveče; okno, ki se še ni izteklo, se ne računa.
- Meritev se izvede največ trikrat: ob prvi zaprti sveči (z₁), po 24 h (z₂₄, V, M24) in po 72 h (z₇₂, M72; nato zamrznjeno).
- »Ni para« se zapomni za 7 dni (`data/market-state.json`).

### Zgodbe in faktor novosti N

- **Pripenjanje:** dogodek se pripne obstoječi zgodbi, če se ujema z njenim **prvim** dogodkom in je zadnji dogodek zgodbe mlajši od `stories.maxGapDays` (7 dni). `storyId` je trajen.
- **Ujemanje** (prag `stories.jaccardMin` = 0,5):
  - če ima vsaj ena stran specifičen kovanec (ne ozadje BTC/ETH/SOL), odloča Jaccard specifičnih kovancev. Primer: FBI o Severni Koreji (BNB) se pripne zgodbi »Binance hack« (BNB);
  - sicer odloča Jaccard(ozadje ∪ akterji), le če je prisoten vsaj en akter.
  - Ta dopolnitev pravila preprečuje dvoje: sam »BTC« ne veriži nepovezanih zgodb, »SEC sues Coinbase« in »SEC approves BTC ETF« pa nista ista zgodba.
- **Faktor novosti** (`stories.novelty`): prvi dogodek N = 1,0, nadaljnji N = 0,5. Eskalacija ima N = 1,0; to je prehod v višjo stopnjo (`stories.escalation`), pri čemer se tip v zgodbi pojavi prvič:
  - hack → insolvency;
  - katerikoli → regulation, ki zadeva glavno entiteto zgodbe (specifičen kovanec ali akter, ki ni regulator);
  - katerikoli → protocol_failure.
- **ExAnte_eff = ExAnte · N.** Uteži komponent se ne spremenijo. Končna ocena uporablja ExAnte_eff.
- **Trg** se meri po dogodku, od lastnega `firstSeenAt`.
- **`shared_impact`** velja samo med dogodki **različnih** zgodb.

### ExPost in končna ocena

- **ExPost** = 100 · min(1, M/M_ref): po 24 h z M24/M_ref24, po 72 h z M72/M_ref72.
- **Najbližji referenčni dogodek** je izbran po |M − M_r| na istem horizontu.
- **Končna ocena:**
  - pred potrditvijo: final = ExAnte, `expected`;
  - po potrditvi: final = 0,3·ExAnte + 0,7·ExPost, `confirmed`.
- ExPost se računa ob vsakem teku iz zamrznjene tržne meritve, zato se po novem backfillu ocene posodobijo.

### Varovalke (oznake `flags`, razlogi v `flagReasons`)

| Oznaka | Pogoj |
|---|---|
| `confounded` | \|z₂₄(BTC)\| > 3 in BTC ni glavna entiteta, ali objava FOMC/CPI v ±24 h (`config.macroEvents`, preverjeni datumi s časom v UTC) |
| `shared_impact` | ista merjena entiteta pri več dogodkih **različnih zgodb** v ±24 h |
| `no_market_asset` | dogodek nima kovanca med glavnimi entitetami (npr. samo akterji); ocena ostane ExAnte |
| `no_market_data` | ni para niti sektorskega indeksa, ali ni podatkov |

**Koledar makro objav.** Ko FOMC ali CPI v `config.macroEvents` pokriva manj kot `minCoverageDays` (60) dni vnaprej, `status.json` (`macroCalendar.warning`) in dashboard prikažeta opozorilo za posodobitev. Trenutni seznam sega do decembra 2027.

### Kalibracija

- Ob končni meritvi (72 h) se dogodek zapiše v `data/confirmed-archive.json` (hrani se 400 dni, dogodki sami le 14).
- `npm run calibrate` izračuna Spearmanov ρ(ExAnte, ExPost).
- Od 50 potrjenih naprej predlaga uteži z NNLS (ExPost/100 ~ T, C, Q, S, A; w ≥ 0; tudi normirano na vsoto 1).
- Predlog se **ne uveljavi** samodejno.

### Dashboard (`index.html`)

Ena datoteka (HTML + CSS + JS) v temni temi, s slovenskimi napisi in številkami v obliki `sl-SI`; časi so v Europe/Ljubljana. Dashboard ne kliče zunanjih API-jev.

- **Odpiranje:** neposredno kot `file://index.html` (podatki iz `data/bundle.js`, ki ga zapiše zbiralnik) ali prek statičnega strežnika, npr. `npx serve .`.
- **Glava:** sektor, obdobje (24 h / 7 dni / 14 dni glede na zadnji tek), tipi (večizbirno), »samo potrjeni«, čas zadnjega teka.
- **Opozorila:** neizmerjena knjižnica, tek starejši od 2 h, viri v napaki, koledar makro objav.
- **Glavni seznam prikazuje zgodbe.** Kartica prikazuje najvišje ocenjeni dogodek zgodbe:
  - ocena z barvno lestvico (< 30 siva, 30–60 rumena, 60–80 oranžna, > 80 rdeča) in status;
  - tip, glavne entitete, število virov, čas prve objave;
  - smer in AR₂₄, najbližji analog, oznake in eskalacija;
  - število dogodkov v zgodbi in časovnica razvoja ob razširitvi.
- **Podrobnosti dogodka:**
  - razčlenitev T, C, Q, S, A in N z izračunom ExAnte, ExAnte_eff, ExPost in končne ocene;
  - tabela z₁, z₂₄, z₇₂, V, M;
  - graf cene ±24 h (sredstvo, sektorski indeks, BTC; indeksirano na objavo, ena os), analogi, razlogi za oznake, zgodba, članki s povezavami.
- **Referenčni dogodki:**
  - opozorilo o negativnih šokih;
  - primerjava M₇₂ s črto M_ref;
  - mejniki in sočasni dejavniki, metrike po sredstvih, graf ±7 dni;
  - navodila za dodajanje dogodka.
  - Brez izmerjene knjižnice so prikazani ročni vnosi z opozorilom.
- **Prazno stanje:** brez `data/bundle.js` se prikaže navodilo za zagon zbiralnika.
- **Grafi:** Chart.js 4.5.1 s cdnjs, z rezervo na jsdelivr. Brez povezave do CDN se namesto grafa izpiše opomba, tabele pa ostanejo.
- **Varnost:** naslovi iz feedov se izpisujejo varno (escape oziroma `textContent`); test to preveri z naslovom, ki vsebuje HTML.
- **Širina 375 px:** brez vodoravnega drsenja (test s Playwrightom, ki se preskoči, če Playwright ni nameščen).

## Testne fikture za točkovanje

`tests/fixtures/library-measured-synthetic.json` je **sintetična** izmerjena knjižnica, označena v polju `_synthetic`. Vrednosti M so izmišljene za ročne izračune in niso rezultat backfilla: M_ref24 = 3, M_ref72 = 4. Na njej temeljijo ročno izračunani primeri v `tests/score.test.js`:
- ExAnte 92 z izmerjeno knjižnico;
- ExAnte 55 brez nje;
- ExPost 50 in 100;
- končna ocena 63 in 98.

### Neizmerjena knjižnica

Če `data/library.json` ne obstaja ali nima `measured` (ni `M_ref24`):

- `status.json` vsebuje `library.measured = false`, `calibrated = false` in opozorilo »Referenčna knjižnica ni izmerjena – ocene niso kalibrirane«.
- Velja: T iz privzetih vrednosti configa, A = 0 (analogi se prikažejo le kot podobnost), brez ExPost, status `expected`, final = ExAnte. Tržne meritve (z, V, M) se izvajajo normalno.
- Delno izmerjena knjižnica (n/5) da milejše opozorilo.

## Dashboard (`index.html`)

Ena datoteka (HTML + CSS + JS) v temni temi, s slovenskimi napisi in številkami v obliki `sl-SI`; časi so v Europe/Ljubljana. Dashboard ne kliče zunanjih API-jev.

- **Odpiranje:** neposredno kot `file://index.html` (podatki iz `data/bundle.js`, ki ga zapiše zbiralnik) ali prek statičnega strežnika, npr. `npx serve .`.
- **Glava:** sektor, obdobje (24 h / 7 dni / 14 dni glede na zadnji tek), tipi (večizbirno), »samo potrjeni«, čas zadnjega teka.
- **Opozorila:** neizmerjena knjižnica, tek starejši od 2 h, viri v napaki, koledar makro objav.
- **Glavni seznam prikazuje zgodbe.** Kartica prikazuje najvišje ocenjeni dogodek zgodbe:
  - ocena z barvno lestvico (< 30 siva, 30–60 rumena, 60–80 oranžna, > 80 rdeča) in status;
  - tip, glavne entitete, število virov, čas prve objave;
  - smer in AR₂₄, najbližji analog, oznake in eskalacija;
  - število dogodkov v zgodbi in časovnica razvoja ob razširitvi.
- **Podrobnosti dogodka:**
  - razčlenitev T, C, Q, S, A in N z izračunom ExAnte, ExAnte_eff, ExPost in končne ocene;
  - tabela z₁, z₂₄, z₇₂, V, M;
  - graf cene ±24 h (sredstvo, sektorski indeks, BTC; indeksirano na objavo, ena os), analogi, razlogi za oznake, zgodba, članki s povezavami.
- **Referenčni dogodki:**
  - opozorilo o negativnih šokih;
  - primerjava M₇₂ s črto M_ref;
  - mejniki in sočasni dejavniki, metrike po sredstvih, graf ±7 dni;
  - navodila za dodajanje dogodka.
  - Brez izmerjene knjižnice so prikazani ročni vnosi z opozorilom.
- **Prazno stanje:** brez `data/bundle.js` se prikaže navodilo za zagon zbiralnika.
- **Grafi:** Chart.js 4.5.1 s cdnjs, z rezervo na jsdelivr. Brez povezave do CDN se namesto grafa izpiše opomba, tabele pa ostanejo.
- **Varnost:** naslovi iz feedov se izpisujejo varno (escape oziroma `textContent`); test to preveri z naslovom, ki vsebuje HTML.
- **Širina 375 px:** brez vodoravnega drsenja (test s Playwrightom, ki se preskoči, če Playwright ni nameščen).

## Testne fikture

`tests/fixtures/feeds/*.xml` vsebujejo naslove, povezave in `pubDate` **dobesedno iz živih feedov** (zajem 2026-11-02). V tem obdobju je bila večvirska zgodba »Binance hack«, zato so primerne za preizkus združevanja. `synthetic-atom.xml` in `sectors.json` sta sintetična, kar je označeno v datotekah.

Primer FBI o Severni Koreji iz treh virov se po pravilu z ozadjem in akterji združi (test). Primer Texas iz dveh virov ostaja znana omejitev (`todo`) do embeddingov v 2. fazi.

## GitHub Actions in GitHub Pages (6. korak)

| Workflow | Sprožilec | Kaj naredi |
|---|---|---|
| `backfill.yml` »Smoke + backfill knjižnice« | ročno | Smoke test virov in backfill; izpis v povzetku teka in artifactu `backfill-<id>`. S `publish = true` in izhodno kodo 0 objavi knjižnico na vejo `data`. |
| `collect.yml` »Zbiralnik (cron)« | `7,37 * * * *` + ročno | Obnovi stanje z veje `data`, izvede tek, objavi stanje nazaj na `data` in objavi dashboard na Pages. |
| `keepalive.yml` »Vzdrževanje« | 1. v mesecu + ročno | Prek REST API ponovno omogoči `collect.yml` in `keepalive.yml`; izvede `npm run calibrate`. |

- **Vrata za cron:** `collect.yml` se izvede šele, ko na veji `data` obstaja `data/library.json` ali je spremenljivka `CRON_ENABLED` = `true`. Ročni zagon s `force = true` vrata obide.
- **Brez prekrivanja:** vsi trije workflowi so v isti skupini `concurrency: data-branch` (`cancel-in-progress: false`), zato nikoli ne pišejo stanja hkrati.
- **Veja `data`:** stanje (`data/*.json`, `bundle.js`) se objavi kot en commit brez zgodovine (force-push, `scripts/publish-data-branch.sh`). Glavna veja se nikoli ne spreminja.
- **60-dnevna neaktivnost:** GitHub dokumentira samo to, da se načrtovani workflowi v javnem repozitoriju izklopijo, »ko 60 dni ni aktivnosti repozitorija«; kaj šteje kot aktivnost, ni definirano.
  - Zato se ne zanašamo na commite. `keepalive.yml` vsak mesec kliče `PUT /repos/{owner}/{repo}/actions/workflows/{id}/enable` (pravica `actions: write`).
  - Rezultat zapiše v `data/keepalive.json`. Ob neuspehu ali če zadnji tek ni starejši od 35 dni, zbiralnik doda opozorilo v `status.json` in dashboard.
  - Prazni commiti se ne uporabljajo.
- **Pages:** `index.html` + `data/` kot artifact (`upload-pages-artifact@v4`, `deploy-pages@v4`); `<meta name="robots" content="noindex">`.

### Varnost (javni repozitorij)

- **Sprožilci:** samo `schedule` in `workflow_dispatch`. Ni `pull_request` ne `pull_request_target`, zato koda iz forkov nikoli ne teče s secrets ali pravicami za pisanje. `workflow_dispatch` lahko zaženejo le uporabniki s pravico pisanja.
- **Pravice** (`permissions:`; privzeto *Read repository contents*):

| Workflow / job | Pravice | Zakaj |
|---|---|---|
| `collect.yml` (privzeto) | `contents: read` | – |
| `collect.yml` → `collect` | `contents: write` | objava stanja na vejo `data` |
| `collect.yml` → `deploy` | `pages: write`, `id-token: write` | objava na Pages |
| `backfill.yml` | `contents: write` | objava knjižnice na vejo `data` (le pri `publish = true`) |
| `keepalive.yml` | `actions: write`, `contents: write` | ponovno omogočanje workflowov; objava `keepalive.json` in `calibration.json` na vejo `data` (brez tega opozorilo ne doseže statusa) |

- **Secrets** so podani samo korakom, ki jih potrebujejo (`npm run collect`, `smoke`, `backfill`), ne na ravni joba. `npm ci` teče z `--ignore-scripts` in brez secrets. Odvisnost `fast-xml-parser` je fiksirana na točno verzijo z `package-lock.json`.
- **Brez vrivanja ukazov:** izhodi korakov in vnosi gredo v skripte prek `env`, ne neposredno kot `${{ … }}` v `run`.
- **Akcije:** samo GitHubove (`actions/*`), na glavni verziji. Za strožjo različico jih lahko pripnete na SHA.

### Kontrolni seznam za prvi zagon

1. **Repozitorij:** objavite kodo na GitHub (javni repozitorij). Mape `data/` in `cache/` niso v glavni veji.
2. **Secrets** (*Settings → Secrets and variables → Actions → Secrets*):
   - `COINGECKO_DEMO_API_KEY` – brezplačen ključ CoinGecko Demo;
   - `CONTACT_EMAIL` – kontakt za User-Agent pri SEC (secret, ker so dnevniki javni).
3. **Spremenljivke** (*… → Variables*): `CRON_ENABLED` pustite nenastavljeno (ali `false`), dokler ne pregledate backfilla.
4. **Pages:** *Settings → Pages → Build and deployment → Source: GitHub Actions*. To nastavite ročno; prek API iz seje Claude ni bilo mogoče.
5. **Pravice workflowov:** privzete pravice *Read repository contents* **pustite**. Vsak workflow ima eksplicitni blok `permissions:` z najmanjšimi pravicami (glej *Varnost*).
6. **Smoke + backfill (pregled):** *Actions → Smoke + backfill knjižnice → Run workflow* s `publish = false`.
   - **Izpis backfilla:** povzetek teka (*Summary*) vsebuje izpis smoke testa in tabelo M, z₂₄, z₇₂, V.
   - **Artifact `backfill-<id>`** (spodaj na strani teka) vsebuje `out/smoke.txt`, `out/backfill.txt`, `out/runner.txt` (država IP runnerja), `data/library.json`, `data/series/` in `data/backfill-log.json`.
   - Preverite tudi The Defiant v smoke izpisu; če je feed veljaven, ga vklopite v `config.sources`.
7. **Pregled M_ref:** po pregledu se odločimo o morebitnih spremembah uteži in configa.
8. **Objava knjižnice:** ponovno zaženite »Smoke + backfill knjižnice« s `publish = true`. Predpomnilnik cen naredi tek hiter. Ob izhodni kodi 0 se `data/library.json` objavi na vejo `data` in vrata za cron se odprejo.
   - Alternativa brez knjižnice: nastavite `CRON_ENABLED = true` (ocene niso kalibrirane).
9. **Prvi tek zbiralnika:** *Actions → Zbiralnik (cron) → Run workflow* (po potrebi `force = true`). Po uspehu je dashboard na naslovu Pages (*Settings → Pages*).
10. **Vzdrževanje:** *Actions → Vzdrževanje → Run workflow* enkrat ročno, da preverite, ali ponovno omogočanje workflowov deluje (`data/keepalive.json`, opozorilo v dashboardu ob neuspehu).

## Alternativa: zasebni repozitorij

Javni repozitorij je izbran zaradi brezplačnih minut Actions in GitHub Pages. Zasebni repozitorij pri GitHub Free ima omejeno brezplačno kvoto minut, Pages za zasebne repozitorije pa ni na voljo. Cron vsakih 30 min porabi približno 1.500 obračunanih minut na mesec, ker se vsak job zaokroži navzgor na minuto.

## Referenčna knjižnica

- **Vhod (ročni vnos):** `config/library.json`
- **Izhod:** `data/library.json` (vnos + `measured` + `refs` + `acceptance`), `data/series/{id}.json` (cene ±7 dni za grafe), `data/backfill-log.json` (čas teka, klici po virih)

Pretekli meseci cen se trajno shranijo v `cache/prices/`. Zato ponovni zagon da enak `data/library.json`.

### Dodajanje dogodka

Dodajte zapis v `config/library.json` in zaženite `npm run backfill`. Obvezna polja:

| Polje | Pomen |
|---|---|
| `id` | male črke, številke, `_` |
| `t0`, `t0Precision` | `"hour"` zahteva `t0Source`. `"day"` zahteva `t0` ob `00:00:00Z` in nima z₁. |
| `t0Source` | URL ali objekt `{ url, method, ... }` (spodaj) |
| `primaryAsset` | sredstvo, katerega M predstavlja dogodek; mora biti v `assets` in v `config.assets` |
| `assets` | vsa merjena sredstva; stablecoini (`isStablecoin` v configu) so izključeni iz z/M |
| `milestones`, `confounders` | `[{ date, label, affectsEstimation? }]`; `date` je dan ali ISO čas. Pri vnosih pred dnem t0 je `affectsEstimation` obvezen. |
| `type`, `sectors`, `keywords` | za klasifikacijo in podobnost (koraki 3–4) |

### Določanje t0

t0 je trenutek, ko je informacija postala **javna v obliki, ki bi jo zaznal novičarski monitor**, saj se živi dogodki merijo od `firstSeenAt`. Naknadne rekonstrukcije (npr. čas zadnje transakcije) se vpišejo kot mejnik, ne kot t0.

- **Prva objava je tweet** → `method: "x_snowflake"`, `tweetId`, `timestampMs` in `formula`. Čas se izračuna iz ID-ja: `timestamp_ms = (id >> 22) + 1288834974657`. Validacija preveri ujemanje ID ↔ URL, `timestampMs` ↔ izračun in `t0` ↔ `timestampMs` (na sekundo navzdol). Enako preveri `corroboration`, ki vsebuje `tweetId`.
- **Prva objava je spletna stran** → `method: "publication_time"` in `publishedLocal` (lokalni čas z navedbo časovnega pasu).

### `affectsEstimation`

| Vrednost | Za kaj | Učinek |
|---|---|---|
| `true` | predhodniki dogodka in izredni sočasni dejavniki (npr. razvezava UST 7. 5. 2022, Tesla 12. 5. 2021) | ocenjevalno okno se konča pred njim |
| `false` | načrtovane makro objave (FOMC, CPI) | okno se ne premakne; so del običajne volatilnosti in sodijo v σ |

Če sredstvo še nima vira cen, ga dodajte v `config.assets` s seznamom `sources`. Viri se preizkušajo po vrsti. `validFrom` je vključujoč, `validTo` izključujoč (npr. stari LUNA pred preimenovanjem v LUNC).

## Metodologija merjenja (poglavje 6.1)

- **Donosi:** log donosi sveč. Okno dogodka obsega h donosov sveč z odprtjem v `[c0, c0 + h)`, kjer je `c0` sveča, ki vsebuje t0.
- **Abnormalni donos:** `AR = r − β·r_BTC`. Za BTC je β = 0.
- **z-vrednost:** `z_h = AR_h / (σ · √n)`, kjer je n število sveč v oknu.
- **Velikost vpliva:** `M24 = |z24|·f(V)` in `M72 = (0,6·|z24| + 0,4·|z72|)·f(V)`, kjer je `f(V) = 1 + 0,1·clip(log₂V, 0, 3)`.
- **Referenci:** `M_ref24` in `M_ref72` sta mediani M24 oziroma M72 primarnih sredstev knjižnice. Ex-post po 24 h se primerja z `M_ref24`, po 72 h z `M_ref72`.
- **Vrzeli v podatkih:** donos po vrzeli zajame celoten premik, zato z uporablja nominalni n. Okno z manj kot 80 % sveč se ne izračuna.
- **Stablecoini:** brez z/M. Kot informativna metrika se izračuna največji odmik od vezave v bazičnih točkah v 72 h.

### Ocenjevalno okno: knjižnica ≠ živi dogodki

| | Okno za β in σ |
|---|---|
| **Referenčni dogodki** | 30 dni, ki se končajo 1 dan pred **prvim mejnikom ali sočasnim dejavnikom z `affectsEstimation: true` pred dnem t0**. Če takega ni: 1 dan pred t0. |
| **Živi dogodki** | `[t − 31 d, t − 1 d)` |

Razlog za razliko: pri referenčnih dogodkih so predhodni dogodki znani in bi napihnili σ (npr. FTX 2.–7. 11., Kitajska 12.–19. 5. 2021). Posledično bi z podcenili. Pri živih dogodkih te informacije ob objavi ni, zato bi njena uporaba pomenila look-ahead.

### Kriteriji knjižnice

- **Obvezno** (LUNC pri `luna_crash_2022`, nastavljivo v `config.acceptance.largestImpact`): rang 1 po |AR72| in rang ≤ 2 po M72.
  - |AR72| je surovi abnormalni donos in je nedvoumen.
  - M72 je normaliziran s σ pred dogodkom. Sredstvo z nizko predhodno volatilnostjo (npr. FTT) ima zato lahko legitimno višji M72.
- **Informativno:** z₂₄ za BTC pri Kitajski in FTX. Metodologija se ne prilagaja ciljni vrednosti; majhen vpliv se zapiše kot ugotovitev.
- **Izhodna koda 2** pri neizpolnjenem obveznem kriteriju vrne samo ročni `npm run backfill`. Zbiralnik (cron) knjižnice ne preverja in te kode ne vrača.

## Viri cen

| Vir | Uporaba |
|---|---|
| `data-api.binance.vision` | urne sveče od 2017. `api.binance.com` z ameriških IP-jev vrača 451. |
| `data.binance.vision` (mesečni arhivi) | umaknjeni simboli (stari LUNA/UST, FTT). Preveri se SHA-256. Spot časovni žigi so od 2025 v mikrosekundah. |
| Bitstamp `/api/v2/ohlc/{pair}/` | BTC pred 2017. Najprej se poskusi 1h, nato 1d. |
